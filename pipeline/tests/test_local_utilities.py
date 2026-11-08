"""Local utility layers: synthetic geometry only. No registry, no network, no real parcels."""
import json, os, re, subprocess, shutil, unittest, pathlib
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import local_utilities as U
import parcels as P
from shapely.geometry import LineString, Point, box

ROOT = pathlib.Path(__file__).resolve().parents[2]
LAT, LON = 38.0, -97.0

def ll(g):
    return P.to_ll(g, LAT, LON)

def line(x0, y0, x1, y1):
    return ll(LineString([(x0, y0), (x1, y1)]))

REG = {"jurisdictions": [{"publisher": "City of Example", "counties": ["Saline"], "scale": 100, "layers": [
    {"type": "pipeline", "name": "NPMS", "url": "https://example.test/npms/0", "geom": "Polyline",
     "DO_NOT_USE": "PHMSA NPMS republication"},
    {"type": "water", "name": "Water Mains", "url": "https://example.test/water/4", "geom": "Polyline",
     "diameter_fields": ["SIZE"], "material_fields": ["MATERIAL"], "owner_fields": ["OWNER"]},
    {"type": "sewer", "name": "Sanitary_FM", "url": "https://example.test/fm/8", "geom": "Polyline"},
]}], "statewide": [{"name": "NPMS", "DO_NOT_USE": True, "url": "https://example.test/npms/0"}],
 "no_public_source": [{"county": "Finney"}]}


class Scale(unittest.TestCase):
    def test_salina_hundredths(self):
        self.assertEqual(U.norm_size(600, 100), 6)
        self.assertEqual(U.norm_size(600, 0.01), 6)
        self.assertEqual(U.norm_size("8 in", 100), 8)
        self.assertEqual(U.norm_size("150 mm", None), round(150 / 25.4, 2))
        self.assertIsNone(U.norm_size("", 100))

    def test_registry_skips_do_not_use_and_keeps_scale(self):
        layers = U.layers_for(REG, "Saline County")
        self.assertEqual([L["name"] for L in layers], ["Water Mains", "Sanitary_FM"])
        self.assertEqual(layers[0]["scale"], 100)
        self.assertEqual(U.kind_of("sewer", "Sanitary_FM"), "force")
        self.assertEqual(U.kind_of("sewer", "Sewer Lateral"), "lateral")
        self.assertEqual(U.kind_of("storm", "Storm Pipes"), "storm")
        self.assertEqual(U.kind_of("sewer", "Sanitary_Sewer_Main"), "main")
        self.assertNotIn("https://example.test/npms/0", U.banned_urls(REG) and {L["url"] for L in layers})
        self.assertIn("https://example.test/npms/0", U.banned_urls(REG))
        self.assertTrue(U.marked_off({"DO_NOT_USE": "CUI"}))
        self.assertIn("Finney", U.discover_query(U.lacking_counties(REG)[0]))

    def test_line_keeps_only_type_size_material_owner(self):
        layer = U.layers_for(REG, "Saline")[0]
        feat = {"geometry": line(-80, 0, 80, 0), "properties": {"SIZE": 600, "MATERIAL": "PVC", "OWNER": "City", "APN": "SECRET-1", "note": "drop me"}}
        row = U.line_of(feat, layer, LAT, LON, 1000)
        self.assertEqual(row["sz"], 6)
        self.assertEqual(row["mat"], "PVC")
        self.assertEqual(row["ow"], "City")
        self.assertEqual(row["t"], "water")
        blob = json.dumps(row)
        self.assertNotIn("SECRET", blob)
        self.assertNotIn("drop me", blob)
        self.assertNotIn("APN", blob)


class Clip(unittest.TestCase):
    def test_circle_keeps_the_part_inside_two_miles(self):
        g, dist = U.clip_geom(line(-4000, 0, 4000, 0), LAT, LON, radius_m=1000)
        m = P.to_m(g, LAT, LON)
        self.assertLess(dist, 1)
        self.assertLess(m.length, 2100)
        self.assertGreater(m.bounds[0], -1100)
        self.assertLess(m.bounds[2], 1100)
        self.assertIsNone(U.clip_geom(line(5000, 0, 6000, 0), LAT, LON, radius_m=1000))


class Cap(unittest.TestCase):
    def fat(self, t, k, mi):
        return {"t": t, "k": k, "mi": mi, "mat": "M" * 300, "g": {"type": "LineString", "coordinates": [[0, 0], [0.01, 0.01]]}}

    def test_drops_storm_then_laterals_then_farthest(self):
        storm, lat, far, near = self.fat("storm", "storm", 0.2), self.fat("sewer", "lateral", 0.2), self.fat("water", "main", 1.8), self.fat("water", "main", 0.05)
        rec = {"src": "local-gis", "county": "T", "radius_m": 3218, "lines": [storm, lat, far, near]}
        def jlen(ls): return len(U.record_j(dict(rec, lines=ls)))
        only_storm_off = U.fit(rec, cap=jlen([lat, far, near]) + 8)
        self.assertTrue(all(f["t"] != "storm" for f in only_storm_off["lines"]))
        self.assertTrue(any(f["k"] == "lateral" for f in only_storm_off["lines"]))
        mains = U.fit(rec, cap=jlen([far, near]) + 8)
        self.assertEqual(sorted(f["k"] for f in mains["lines"]), ["main", "main"])
        one = U.fit(rec, cap=jlen([near]) + 8)
        self.assertEqual([f["mi"] for f in one["lines"]], [0.05])
        self.assertLessEqual(len(U.record_j(one)), jlen([near]) + 8)
        self.assertLessEqual(len(U.record_j(U.fit(rec, cap=U.CAP))), U.CAP)


class Strips(unittest.TestCase):
    def test_widths_and_crossing(self):
        parcel = ll(box(-200, -200, 200, 200))
        g = line(-50, 0, 50, 0)
        far = line(5000, 0, 6000, 0)
        rows = [
            {"t": "water", "k": "main", "sz": 6, "g": g},
            {"t": "sewer", "k": "main", "sz": 16, "g": g},
            {"t": "sewer", "k": "force", "sz": 8, "g": g},
            {"t": "storm", "k": "storm", "sz": 24, "g": g},
            {"t": "fiber", "k": "main", "g": g},
            {"t": "easement", "k": "main", "w": 15, "g": g},
            {"t": "easement", "k": "main", "g": g},
            {"t": "water", "k": "main", "sz": 6, "g": far},
        ]
        out = U.strips(parcel, rows)
        got = {(f["t"], f["k"]): f["strip_ft"] for f in out}
        self.assertEqual(got[("water", "main")], 20)
        self.assertEqual(got[("sewer", "main")], 30)
        self.assertEqual(got[("sewer", "force")], 20)
        self.assertEqual(got[("storm", "storm")], 20)
        self.assertEqual(got[("fiber", "main")], 10)
        self.assertEqual(got[("easement", "main")], 15)
        self.assertEqual(len(out), 6)   # widthless easement and the far main are not strips
        self.assertTrue(all(f["label"] == "public GIS, verify with survey" for f in out))
        self.assertFalse(U.crosses(parcel, far))
        self.assertTrue(U.crosses(parcel, g))


class Rules(unittest.TestCase):
    def test_utilities_admin_read_only(self):
        r = (ROOT / "firebase" / "firestore.rules").read_text()
        i = r.index("match /utilities/{id}")
        blk = r[i:i + 90]
        self.assertIn("allow read: if admin()", blk)
        self.assertIn("allow write: if false", blk)
        self.assertNotIn("member()", blk)


@unittest.skipUnless(shutil.which("node"), "node missing")
class SitePlan(unittest.TestCase):
    def test_template_strips_match_the_python_widths(self):
        tpl = (ROOT / "pipeline" / "template.html").read_text()
        def fn(name):
            m = re.search(r"^function %s\(.*?(?=^function |^const |^//)" % name, tpl, re.S | re.M)
            self.assertTrue(m, name)
            return m.group(0)
        src = "const SP={ut:{},poly:null,cx:{},sd:{sites:{}}};\nconst spCx=s=>(s&&SP.cx[s.id])||null;\n" + "".join(fn(n) for n in ["utStripFt", "utCross", "spProj", "spSegD", "spNB", "spNBhit"]) + r"""
const s={id:'t',lat:38,lon:-97};
const P=spProj(38,-97);
SP.poly=[[-400,-400],[400,-400],[400,400],[-400,400],[-400,-400]].map(P.b);
const g={type:'LineString',coordinates:[P.b([-300,0]),P.b([300,0])]};
const far={type:'LineString',coordinates:[P.b([5000,0]),P.b([6000,0])]};
SP.ut.t={lines:[
 {t:'water',k:'main',sz:6,nm:'Water',g},
 {t:'sewer',k:'main',sz:18,nm:'Sewer',g},
 {t:'fiber',k:'main',nm:'Fiber',g},
 {t:'water',k:'main',sz:6,nm:'Far',g:far}
]};
const N=spNB(s,{});
const hit=(y)=>spNBhit(0,y,N);
console.log(JSON.stringify({
  w:utStripFt({t:'water',k:'main',sz:6}),
  big:utStripFt({t:'sewer',k:'main',sz:16}),
  fm:utStripFt({t:'sewer',k:'force',sz:8}),
  st:utStripFt({t:'storm',k:'storm',sz:30}),
  fb:utStripFt({t:'fiber',k:'main'}),
  ez:utStripFt({t:'easement',w:15}),
  ez0:utStripFt({t:'easement'}),
  on:hit(5), off:hit(40), bigOn:hit(12)
}))"""
        r = json.loads(subprocess.run(["node"], input=src, capture_output=True, text=True, check=True).stdout)
        self.assertEqual([r["w"], r["big"], r["fm"], r["st"], r["fb"], r["ez"], r["ez0"]], [20, 30, 20, 20, 10, 15, 0])
        self.assertEqual(r["on"], 8)      # 5 ft off a 20 ft water strip
        self.assertEqual(r["off"], 0)
        self.assertEqual(r["bigOn"], 8)   # 12 ft off a 30 ft sewer main (sz 18)
        self.assertIn("Public GIS, not as-built. Call 811.", tpl)
        self.assertIn("public GIS, verify with survey", tpl)
        self.assertIn("match /utilities/{id}", (ROOT / "firebase" / "firestore.rules").read_text())
