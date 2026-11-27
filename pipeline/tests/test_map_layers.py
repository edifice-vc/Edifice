"""OSM transmission lines merged into the HIFLD layer: voltage, dedupe, labels, failure behavior."""
import json, os, sys, unittest
from shapely.geometry import LineString

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import map_layers as ml


class Voltage(unittest.TestCase):
    def test_multi_value_max_in_kv(self):
        self.assertEqual(ml.parse_multi_kv("138000;345000"), 345)
        self.assertEqual(ml.parse_multi_kv("69000"), 69)
        self.assertEqual(ml.parse_multi_kv("138"), 138)
        self.assertIsNone(ml.parse_multi_kv(""))
        self.assertIsNone(ml.parse_multi_kv(None))

    def test_hifld_unknown_keeps_none(self):
        self.assertIsNone(ml.hifld_voltage("NOT AVAILABLE", "138"))
        self.assertIsNone(ml.hifld_voltage(-999, "115"))
        self.assertIsNone(ml.hifld_voltage(-1, "NOT AVAILABLE"))
        self.assertEqual(ml.hifld_voltage(None, "UNDER 100"), 69)
        self.assertEqual(ml.hifld_voltage(138, "100-161"), 138)
        self.assertEqual(ml.volt_class(None), "unknown")
        self.assertEqual(ml.volt_class(138), "100-161")
        self.assertEqual(ml.volt_class(345), "345")
        self.assertEqual(ml.volt_class(230), "220-287")
        self.assertEqual(ml.volt_class(69), "69")

    def test_same_voltage(self):
        self.assertTrue(ml.same_voltage(138, 138.2))
        self.assertFalse(ml.same_voltage(138, 115))
        self.assertFalse(ml.same_voltage(138, None))
        self.assertTrue(ml.same_voltage(None, None))


class Dedupe(unittest.TestCase):
    def test_parallel_same_voltage_dropped_spur_kept(self):
        hifld = LineString([(0, 0), (5000, 0)])
        by_kv = {138: [hifld]}
        parallel = LineString([(0, 10), (5000, 10)])
        self.assertIsNone(ml.clip_osm_to_hifld(parallel, by_kv, 138))
        spur = LineString([(2500, 0), (2500, 2000)])
        kept = ml.clip_osm_to_hifld(spur, by_kv, 138)
        self.assertIsNotNone(kept)
        self.assertGreater(kept.length, 1500)
        far = LineString([(0, 500), (4000, 500)])
        self.assertAlmostEqual(ml.clip_osm_to_hifld(far, by_kv, 138).length, far.length, delta=1)
        # different voltage is not in this bucket, so the parallel line would be kept by the caller
        self.assertAlmostEqual(ml.clip_osm_to_hifld(parallel, {345: [hifld]}, 138).length, parallel.length, delta=1)

    def test_unknown_does_not_match_known(self):
        hifld = LineString([(0, 0), (1000, 0)])
        osm = LineString([(0, 5), (1000, 5)])
        self.assertIsNotNone(ml.clip_osm_to_hifld(osm, {138: [hifld]}, None))
        self.assertIsNone(ml.clip_osm_to_hifld(osm, {None: [hifld]}, None))


class Labels(unittest.TestCase):
    def test_substation_fallback(self):
        self.assertEqual(ml.sub_label("Caldwell", "Sunflower", 138, "way", 1), "Caldwell")
        self.assertEqual(ml.sub_label(None, "Sunflower Electric", 138, "way", 1), "Sunflower Electric")
        self.assertEqual(ml.sub_label("", "", 138, "way", 1102240797),
                         "unnamed 138 kV sub (OSM way 1102240797)")
        self.assertEqual(ml.sub_label(None, None, None, "node", 9), "unnamed sub (OSM node 9)")


class Refresh(unittest.TestCase):
    def test_failure_reuses_committed_layer(self):
        import tempfile
        d = tempfile.mkdtemp()
        ml.write("lines.geojson", [{"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
                                    "properties": {"source": "OSM", "osm_id": 1}}], "test", out=d)

        def boom():
            raise RuntimeError("overpass down")

        ml.refresh("lines.geojson", boom, "test", out=d)
        fc = json.load(open(os.path.join(d, "lines.geojson")))
        self.assertEqual(fc["features"][0]["properties"]["osm_id"], 1)

    def test_failure_without_cache_raises(self):
        import tempfile
        d = tempfile.mkdtemp()
        with self.assertRaises(RuntimeError):
            ml.refresh("lines.geojson", lambda: (_ for _ in ()).throw(RuntimeError("down")), "test", out=d)

    def test_empty_does_not_blank(self):
        import tempfile
        d = tempfile.mkdtemp()
        ml.write("gas.geojson", [{"type": "Feature", "geometry": None, "properties": {"t": "x"}}], "eia", out=d)
        ml.refresh("gas.geojson", lambda: [], "eia", out=d)
        fc = json.load(open(os.path.join(d, "gas.geojson")))
        self.assertEqual(len(fc["features"]), 1)


class CommittedLayer(unittest.TestCase):
    """The built lines layer, once this branch has regenerated it."""

    def setUp(self):
        self.path = os.path.join(os.path.dirname(__file__), "..", "..", "sunflower", "layers", "lines.geojson")
        self.fc = json.load(open(self.path))

    def test_caldwell_spur_and_parent_present(self):
        ids = {((f.get("properties") or {}).get("osm_id")) for f in self.fc["features"]}
        if 1102240796 not in ids:
            self.skipTest("lines.geojson has not been rebuilt with OSM yet")
        self.assertIn(1058631068, ids)  # Milan side of the 138 kV line
        self.assertIn(1102235101, ids)  # Bluff City side
        spur = next(f for f in self.fc["features"] if (f.get("properties") or {}).get("osm_id") == 1102240796)
        p = spur["properties"]
        self.assertEqual(p["source"], "OSM")
        self.assertTrue(p["unverified"])
        self.assertEqual(p["voltage_kv"], 138)
        self.assertEqual(p["c"], "100-161")
        self.assertIn("Sunflower", p.get("operator") or "")
        # the radial ends at the Sunflower substation, so that pin is on the 138 kV line
        from shapely.geometry import Point, shape
        from shapely.ops import transform
        from pyproj import Transformer
        to_m = Transformer.from_crs("EPSG:4326", "EPSG:5070", always_xy=True)
        pt = transform(lambda x, y: to_m.transform(x, y), Point(-97.6198, 37.0396))
        best = None
        for f in self.fc["features"]:
            kv = (f.get("properties") or {}).get("kv")
            if kv != 138:
                continue
            d = transform(lambda x, y: to_m.transform(x, y), shape(f["geometry"])).distance(pt) / 1609.344
            if best is None or d < best:
                best = d
        self.assertLess(best, 0.15)

    def test_hifld_345_still_present(self):
        n = sum(1 for f in self.fc["features"]
                if (f.get("properties") or {}).get("source") == "HIFLD" and (f.get("properties") or {}).get("c") == "345")
        # source is added by this rebuild; the previous file had no source property
        if n == 0 and not any((f.get("properties") or {}).get("source") for f in self.fc["features"]):
            self.skipTest("lines.geojson has not been rebuilt yet")
        self.assertGreater(n, 40)


class Template(unittest.TestCase):
    def setUp(self):
        self.html = open(os.path.join(os.path.dirname(__file__), "..", "template.html"), encoding="utf-8").read()

    def test_osm_drawn_in_the_lines_layer(self):
        self.assertIn("#FFB25A", self.html)
        self.assertIn("#8A8A8A", self.html)
        self.assertIn("OSM (unverified)", self.html)
        self.assertIn("© OpenStreetMap contributors, ODbL", self.html)
        self.assertIn("kV not tagged", self.html)
        self.assertIn("unnamed", self.html)
        self.assertNotIn("osm_lines", self.html)


if __name__ == "__main__":
    unittest.main()
