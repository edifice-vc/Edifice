import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import spp_subs as S


class SppSubsTest(unittest.TestCase):
    def test_kv_and_norm(self):
        self.assertEqual(S.kv_list("345/115 kV"), [345, 115])
        self.assertEqual(S.kv_list("13.8"), [])
        self.assertEqual(S.norm("Wolf Creek 345 kV Substation"), "wolf creek")
        self.assertEqual(S.norm("NEW Sub (Sumner Co.)"), "")

    def test_status(self):
        self.assertEqual(S.status_of("Identified", "", None), "planned")
        self.assertEqual(S.status_of("On Schedule < 4", "", "In Progress"), "under_construction")
        self.assertEqual(S.status_of("Delay - Mitigation", "Construction began 3/2026", None), "under_construction")
        self.assertEqual(S.status_of("On Schedule > 4", "", None), "ntc_issued")
        self.assertTrue(S.DONE.match("In Service") and not S.DONE.match("On Schedule < 4"))

    def test_classify(self):
        u = lambda n, d="", f="", t="": {"Upgrade Name": n, "Project Description/ Comments": d, "From Bus Name": f, "To Bus Name": t}
        self.assertEqual(S.classify(u("Buckner 345 kV Substation", "Build new 345 kV switching station")), ("new", False))
        self.assertEqual(S.classify(u("Elm Creek 345/230 kV Transformer", "Install second transformer", "ELM CREEK")), ("expansion", False))
        self.assertEqual(S.classify(u("Elm Creek - Summit 345 kV Ckt 1", "", "ELM CREEK", "SUMMIT")), (None, True))
        self.assertEqual(S.classify(u("Hays 115 kV Capacitor", "Install 30 MVAR cap bank")), (None, False))

    def test_geocode_accuracy(self):
        osm = {"KS": {"alpha": [(1, 38.0, -97.0, "Alpha", "https://osm.org/node/1")],
                      "beta": [(2, 38.2, -97.4, "Beta", "https://osm.org/node/2")]}}
        places = {("KS", "gamma"): [(37.5, -98.0)]}
        counties = {("KS", "sumner"): [(37.2, -97.5)]}
        g = lambda n, **k: S.geocode({"n": n, "st": "KS", **k}, osm, places, counties)
        self.assertEqual(g("Alpha 345 kV")["loc"], "osm")
        self.assertEqual(g("Alpha-Beta Tap", _ends=("alpha", "beta"))["loc"], "mid")
        self.assertEqual(g("Gamma")["loc"], "town")
        self.assertEqual(g("Sumner County")["loc"], "county")
        n = g("Nowhere")
        self.assertEqual((n["loc"], n["lat"]), ("none", None))


if __name__ == "__main__":
    unittest.main()
