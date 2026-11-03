"""Server tests (no network): auth gate, CORS, rate limits, schema validation, output cleaning, no query text in logs."""
import io, json, unittest, contextlib
from unittest import mock
import main

O = {"Origin": "https://edifice.vc", "Authorization": "Bearer t"}
OK = {"email": "a@x.com", "email_verified": True}
SCH = {"hallL": {"type": "number", "min": 100, "max": 3000, "desc": "hall length ft"}, "stories": {"type": "integer", "min": 1, "max": 4},
       "use": {"type": "string", "enum": ["dc", "storage"]}}

class Server(unittest.TestCase):
    def setUp(self):
        main._hits.clear(); main._members.clear(); main._day.update(d="", n=0)
        self.c = main.app.test_client()

    def test_origin_and_auth(self):
        self.assertEqual(self.c.post("/parse", json={"q": "x"}, headers={"Origin": "https://evil.example"}).status_code, 403)
        self.assertEqual(self.c.post("/parse", json={"q": "x"}, headers={"Origin": "https://edifice.vc"}).status_code, 401)
        with mock.patch.object(main.id_token, "verify_firebase_token", side_effect=ValueError):
            self.assertEqual(self.c.post("/plan_edit", json={}, headers=O).status_code, 401)
        with mock.patch.object(main.id_token, "verify_firebase_token", return_value=dict(OK, email_verified=False)):
            self.assertEqual(self.c.post("/parse", json={"q": "x"}, headers=O).status_code, 401)
        with mock.patch.object(main.id_token, "verify_firebase_token", return_value=OK), mock.patch.object(main, "_member", return_value=False):
            self.assertEqual(self.c.post("/parse", json={"q": "x"}, headers=O).status_code, 403)
        r = self.c.options("/parse", headers={"Origin": "https://evil.example"})
        self.assertNotIn("Access-Control-Allow-Origin", r.headers)

    def test_rate_limit_and_logs(self):
        out = io.StringIO()
        with mock.patch.object(main.id_token, "verify_firebase_token", return_value=OK), mock.patch.object(main, "_member", return_value=True), \
             mock.patch.object(main, "_gen", return_value=({"business": "storage", "place": "Wichita"}, {"promptTokenCount": 9})), contextlib.redirect_stdout(out):
            codes = [self.c.post("/parse", json={"q": "secret query text"}, headers=O).status_code for _ in range(main.PER_MIN + 1)]
        self.assertEqual(codes[:main.PER_MIN], [200] * main.PER_MIN)
        self.assertEqual(codes[-1], 429)
        self.assertNotIn("secret", out.getvalue())

    def test_parse_clean(self):
        c = main.clean({"business": "x", "min_score": 500, "mw_min": 50, "stages": ["LOI Submitted", "Bogus"], "flood": "exclude",
                        "place": "Wichita<script>", "name_terms": ["a" * 99]})
        self.assertEqual(c["business"], "both"); self.assertNotIn("min_score", c); self.assertEqual(c["mw_min"], 50)
        self.assertEqual(c["stages"], ["LOI Submitted"]); self.assertEqual(c["place"], "Wichitascript"); self.assertEqual(len(c["name_terms"][0]), 40)

    def test_plan_schema(self):
        s, rs = main.plan_schema(SCH)
        self.assertEqual(set(rs["properties"]["changes"]["properties"]), set(SCH))
        for bad in [{}, {"1x": {"type": "number"}}, {"a": {"type": "object"}}, {("k%d" % i): {"type": "number"} for i in range(41)}, []]:
            with self.assertRaises(ValueError):
                main.plan_schema(bad)

    def test_plan_clean(self):
        s, _ = main.plan_schema(SCH)
        r = main.plan_clean({"changes": {"hallL": 800, "stories": 2.4, "use": "hotel", "evil": 1, "hallW": 3}, "reply": " ok "}, s, {"hallL": 1000, "stories": 1})
        self.assertEqual(r, {"changes": {"hallL": 800.0, "stories": 2}, "reply": "ok"})
        self.assertEqual(main.plan_clean({"changes": {"hallL": 50000}}, s, {})["changes"], {})
        self.assertEqual(main.plan_clean({"changes": {"hallL": 1000}}, s, {"hallL": 1000})["changes"], {})

    def test_plan_edit_endpoint(self):
        with mock.patch.object(main.id_token, "verify_firebase_token", return_value=OK), mock.patch.object(main, "_member", return_value=True), \
             mock.patch.object(main, "_gen", return_value=({"changes": {"stories": 2}, "reply": "Two stories."}, {})) as g:
            r = self.c.post("/plan_edit", json={"message": "two stories", "schema": SCH, "params": {"stories": 1, "owner": "X"}}, headers=O)
            self.assertEqual(r.status_code, 200); self.assertEqual(r.get_json()["changes"], {"stories": 2})
            self.assertNotIn("owner", g.call_args[0][0])
            self.assertEqual(self.c.post("/plan_edit", json={"message": "", "schema": SCH}, headers=O).status_code, 400)
            self.assertEqual(self.c.post("/plan_edit", json={"message": "x", "schema": {"a": {"type": "blob"}}}, headers=O).status_code, 400)

if __name__ == "__main__":
    unittest.main()
