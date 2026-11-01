"""OSI memory: keyed conflict detection, approval gates, weekly weight proposals. Local files only.
Run: python3 -m unittest discover -s pipeline/tests"""
import contextlib, io, json, os, shutil, sys, tempfile, unittest
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(HERE)

class OsiMemory(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        for f in ("terrafice.yaml", "everstow.yaml", "shared.yaml"):
            shutil.copy(os.path.join(REPO, "osi", f), self.d)
        os.makedirs(os.path.join(self.d, "sources")); shutil.copy(os.path.join(REPO, "osi", "sources", "standards.json"), os.path.join(self.d, "sources"))
        os.makedirs(os.path.join(self.d, "inbox"))
        os.environ["OSI_DIR"] = self.d
        sys.path.insert(0, HERE); sys.modules.pop("osi_memory", None)
        import osi_memory; self.m = osi_memory
    def tearDown(self): shutil.rmtree(self.d); os.environ.pop("OSI_DIR", None)
    def run_(self, *a):
        out = io.StringIO()
        with contextlib.redirect_stdout(out): self.m.main(list(a))
        return out.getvalue()
    def feed(self, text):
        open(os.path.join(self.d, "inbox", "n.txt"), "w").write(text)
        self.run_("ingest", "--kind", "chat"); self.run_("propose"); return self.m.rj(self.m.PROP)

    def test_models_are_osi_011(self):
        import yaml
        for f in ("terrafice", "everstow", "shared"):
            d = yaml.safe_load(open(os.path.join(REPO, "osi", f + ".yaml")))
            self.assertEqual(d["version"], "0.1.1"); self.assertTrue(d["semantic_model"][0]["datasets"])

    def test_threshold_conflict_detected_by_key(self):
        ps = self.feed("if the score of a site isnt above 60, lets filter them out if its less than 100 acres")
        p = next(p for p in ps if p.get("key", "") and p["key"].startswith("small_site_filter"))
        self.assertEqual(p["action"], "conflict"); self.assertEqual(p["match"], "tf.small_low_filter"); self.assertTrue(p["needs_sahil"])

    def test_only_sahil_or_roger_decide_and_scoring_needs_sahil(self):
        ps = self.feed("if the score of a site isnt above 60, lets filter them out if its less than 100 acres")
        p = next(p for p in ps if p["needs_sahil"])
        with self.assertRaises(SystemExit): self.run_("accept", p["id"], "--by", "bot")
        with self.assertRaises(SystemExit): self.run_("accept", p["id"], "--by", "roger@edifice.vc")
        self.run_("accept", p["id"], "--by", "sahil@edifice.vc")
        facts = {f["id"]: f for f in self.m.model_facts(False)}
        self.assertEqual(facts["tf.small_low_filter"]["status"], "superseded")
        self.assertEqual(facts[p["id"]]["accepted_by"], "sahil@edifice.vc")

    def test_roger_can_accept_ungated(self):
        ps = self.feed("Note: the 2 drive-up units near the lake rent fast")
        p = next(p for p in ps if not p["needs_sahil"])
        self.run_("reject", p["id"], "--by", "roger", "--why", "noise")
        self.assertEqual(self.m.rj(self.m.LEDGER)[-1]["by"], "roger@edifice.vc")

    def test_weekly_proposals_only(self):
        w = os.path.join(self.d, "w.json")
        json.dump({"power": {"n": 12, "deltas": {"gas": 0.2, "fiber": 0.01}, "drivers": [{"factor": "gas", "text": "Gas counts 20% more."}]},
                   "storage": {"n": 2, "deltas": {"demand": 0.3}}}, open(w, "w"))
        self.run_("weekly", "--weights", w)
        out = json.load(open(self.m.WEEKLY))
        self.assertEqual([p["factor"] for p in out["proposals"]], ["gas"])
        self.assertTrue(all(p["needs_sahil"] and p["status"] == "pending" for p in out["proposals"]))

if __name__ == "__main__":
    unittest.main()
