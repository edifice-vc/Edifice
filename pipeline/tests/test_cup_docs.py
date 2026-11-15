"""Draft CUP packet: operations plan, application sheet, legal description.

Synthetic fixture only. The sample site is invented (Example County, parcel ids SYN-*).
Nothing here is a real parcel, owner, or survey.
"""
import json, os, pathlib, shutil, subprocess, unittest, zipfile
from io import BytesIO

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = "\n".join((ROOT / "pipeline" / f).read_text() for f in (
    "planEditSchema.js", "testfit.js", "civil.js", "sheet.js", "cup_docs.js"))
HERE = pathlib.Path(__file__).resolve().parent
SAMPLES = ROOT / "pipeline" / "samples" / "cup-synthetic"
SECRETS = (
    "Sample Holdings LLC",
    "1 Example Street",
    "SYN-100-200-300",
    "SYN-100-200-301",
    "QREF-SYN-1",
)
BRANDS = ("Compass", "Cantrill", "Bartlett", "Wakarusa", "CU-26-203", "community-first", "Evergy")
OPS_HEADS = [
    "1. Use and Project Statement",
    "2. Site Plan Narrative",
    "3. Noise",
    "4. Utilities",
    "5. Water Usage",
    "6. Electrical Details",
    "7. Prototypical Building Plans",
    "8. Environmental Studies",
    "9. Drainage Report",
    "10. Traffic Impact Assessment",
    "11. Construction Management",
    "12. Fire Safety Plans",
    "13. Emergency Response Plan",
    "14. Decommissioning and Reclamation",
    "Supplement",
    "S1. Public Utility Connections",
    "S1A. Municipal Water and Wastewater",
    "S1B. Other Water and Wastewater Path",
    "S2A. Phases",
    "S2B. Electrical Load",
    "S2C. Employees",
    "S2D. Ownership",
    "S2E. Tenants",
    "S2F. Lighting",
    "S2G. Generators",
    "S2H. Security",
    "S2I. Building Density",
    "S2J. Hazardous Material",
    "S3. Noise Study Scope",
    "S4. Applicant Substations",
    "S5. Utility Substation",
]


def node(body, env=None):
    src = SRC + "\nconsole.log(JSON.stringify((()=>{" + body + "})()))"
    r = subprocess.run(["node"], input=src, capture_output=True, text=True, env=env)
    if r.returncode != 0:
        raise AssertionError(r.stderr[-4000:] or r.stdout[-4000:])
    return json.loads(r.stdout)


def packet_bytes(public_mode, extra=""):
    """Return {name: bytes} for one packet, plus the plain texts and audit problems."""
    body = """
      const built = cupSampleBuild(%s, %s);
      const files = {};
      const enc = new TextEncoder();
      const zip = cupPacket(built);
      const bin = Buffer.from(zip).toString('base64');
      const texts = {};
      Object.keys(built.docs).forEach(k => texts[k] = built.docs[k].text);
      return {problems: built.problems, texts, b64: bin, site: built.siteName, pub: built.publicMode};
    """ % ("true" if public_mode else "false", extra or "null")
    out = node(body)
    raw = __import__("base64").b64decode(out["b64"])
    zf = zipfile.ZipFile(BytesIO(raw))
    files = {n: zf.read(n) for n in zf.namelist()}
    out["files"] = files
    out["raw"] = raw
    return out


@unittest.skipUnless(shutil.which("node"), "node missing")
class CupDocs(unittest.TestCase):
    def test_empty_input_is_tbd_not_blank_or_invented(self):
        r = node("""
          const b = cupBuild({publicMode:true, asOf:'2026-11-15', site:{}, plan:{}});
          const t = Object.values(b.docs).map(d => d.text).join('\\n');
          return {problems: b.problems, banner: b.docs.legal.text.startsWith(CUP_BANNER),
            undef: /\\\\bundefined\\\\b|\\\\bNaN\\\\b/.test(t),
            hasTbd: t.includes('TBD'), hasSurvey: t.includes('To be ordered (survey / title commitment)'),
            calls: (t.match(/Course /g) || []).length, compass: t.includes('Compass'),
            mw: /\\\\d+(?:\\\\.\\\\d+)? MW/.test(t)};
        """)
        self.assertEqual(r["problems"], [], r["problems"])
        self.assertTrue(r["banner"])
        self.assertFalse(r["undef"])
        self.assertTrue(r["hasTbd"])
        self.assertTrue(r["hasSurvey"])
        self.assertEqual(r["calls"], 0)
        self.assertFalse(r["compass"])
        self.assertFalse(r["mw"])

    def test_square_around_pin_is_not_a_legal(self):
        r = node("""
          const b = cupBuild({asOf:'2026-11-15', site:{name:'Empty'}, plan:{polySrc:'square', rings:[[[0,0],[10,0],[10,10],[0,0]]]}});
          return {problems: b.problems, text: b.docs.legal.text, calls: (b.docs.legal.text.match(/Course /g)||[]).length};
        """)
        self.assertEqual(r["problems"], [])
        self.assertIn("acreage square", r["text"])
        self.assertIn("not a boundary", r["text"])
        self.assertEqual(r["calls"], 0)
        self.assertNotIn("10.00 ft", r["text"])

    def test_sample_admin_fills_courses_and_marks(self):
        r = node("""
          const ring = cupSyntheticRing();
          const courses = shCourses(shOpen(ring));
          const sf = Math.round(Math.abs(shArea(ring)));
          const b = cupSampleBuild(false);
          const legal = b.docs.legal.text, ops = b.docs.operations.text, app = b.docs.application.text;
          const all = legal + '\\n' + ops + '\\n' + app;
          const marks = {AUTO: all.split('[AUTO').length-1, ASSUMED: all.split('[ASSUMED').length-1, TBD: all.split('[TBD').length-1, ORDER: all.split('[TO BE ORDERED').length-1};
          const missing = courses.filter(c => !legal.includes(c.brg) || !legal.includes(cupNum(c.dist, 2)));
          let order = 0, seq = true;
          const heads = %s;
          heads.forEach(h => { const i = ops.indexOf(h); if (i < order) seq = false; order = i < 0 ? order : i; });
          const absent = heads.filter(h => !ops.includes(h));
          return {problems: b.problems, n: b.fields.length, marks, missing: missing.map(c=>c.brg), sf: legal.includes(cupNum(sf, 0)),
            banner: legal.startsWith(CUP_BANNER), seq, absent, halls: (ops.match(/data hall/)||[]).length,
            both: app.includes('SYN-100-200-300') && app.includes('SYN-100-200-301'),
            qref: app.includes('QREF-SYN-1') && app.includes('TBD'),
            owner: app.includes('Sample Holdings LLC') && ops.includes('Sample Holdings LLC'),
            admin: ops.includes('ADMIN'), brands: %s.filter(w => all.includes(w)),
            assessorInCov: ops.includes('42.50 acres') , covUsesOutline: /campus-wide/.test(ops)};
        """ % (json.dumps(OPS_HEADS), json.dumps(list(BRANDS))))
        self.assertEqual(r["problems"], [], r["problems"])
        self.assertGreater(r["n"], 80)
        self.assertGreater(r["marks"]["AUTO"], 10)
        self.assertGreater(r["marks"]["ASSUMED"], 5)
        self.assertGreater(r["marks"]["TBD"], 10)
        self.assertGreater(r["marks"]["ORDER"], 10)
        self.assertEqual(r["missing"], [])
        self.assertTrue(r["sf"])
        self.assertTrue(r["banner"])
        self.assertTrue(r["seq"], r["absent"])
        self.assertEqual(r["absent"], [])
        self.assertTrue(r["both"])
        self.assertTrue(r["qref"])
        self.assertTrue(r["owner"])
        self.assertTrue(r["admin"])
        self.assertEqual(r["brands"], [])
        self.assertTrue(r["assessorInCov"])
        self.assertTrue(r["covUsesOutline"])

    def test_cardinal_setbacks_follow_the_solver(self):
        r = node("""
          const R = [[0,0],[1000,0],[1000,800],[0,800],[0,0]];
          const zone = {district:'I-2', setbacks_ft:{front:{v:25},side:{v:15},rear:{v:20}}, max_height_ft:{v:45}, treatment:{data_center:{status:'conditional'}}};
          const I = Object.assign({}, TF_DEF.land, {halls:1, sw:'off', setF:80, setS:50, setR:60, subAc:0, park:0, genAc:0, front:'S'});
          const solved = tfDC(R, I, {zone: tfZone(zone,'land')});
          const edges = cupEdgeSetbacks(solved);
          const by = {};
          edges.forEach(e => { (by[e.side] = by[e.side] || []).push(e.kind + ':' + e.ft); });
          return by;
        """)
        self.assertIn("front:80", r.get("S", []))
        self.assertIn("rear:60", r.get("N", []))
        self.assertTrue(any(x.startswith("side:50") for x in r.get("E", []) + r.get("W", [])))

    def test_public_redacts_injected_secrets_in_text_pdf_and_docx(self):
        extra = "{water:{peakGpm:9123,maxGpd:4567,annualGpy:891011},generators:17}"
        admin = packet_bytes(False, extra)
        public = packet_bytes(True, extra)
        self.assertEqual(admin["problems"], [])
        self.assertEqual(public["problems"], [])
        admin_text = "\n".join(admin["texts"].values())
        public_text = "\n".join(public["texts"].values())
        for token in SECRETS + ("9,123 gpm", "4,567 gpd", "891,011 gpy", "17 standby generators"):
            self.assertIn(token, admin_text, token)
            self.assertNotIn(token, public_text, token)
        self.assertIn("ADMIN", admin_text)
        self.assertIn("PUBLIC EXPORT", public_text)
        self.assertIsNone(__import__("re").search(r"\d+(?:\.\d+)? MW", public_text))
        self.assertRegex(admin_text, r"\d+\.\d MW")
        for pack, hidden in ((public, True), (admin, False)):
            for name, data in pack["files"].items():
                if not name.endswith((".pdf", ".docx", ".txt")):
                    continue
                blob = data
                if name.endswith(".docx"):
                    blob = zipfile.ZipFile(BytesIO(data)).read("word/document.xml")
                raw = blob.decode("latin1", errors="ignore")
                for token in SECRETS + ("9,123", "9123", "4,567", "891,011", "17 standby"):
                    if hidden:
                        self.assertNotIn(token, raw, name + " leaked " + token)
                if name.endswith(".pdf"):
                    self.assertTrue(data.startswith(b"%PDF-1.4"), name)
                    self.assertIn(b"Not a survey", data)
                    if "legal" in name:
                        self.assertIn(b"NOT A SURVEY", data)
        # docx zip opens
        docx = public["files"]["03-legal-description.docx"]
        xml = zipfile.ZipFile(BytesIO(docx)).read("word/document.xml").decode("utf-8")
        self.assertIn("NOT A SURVEY", xml)
        self.assertIn("Kansas PLS", xml)

    def test_packet_zip_roundtrip(self):
        pack = packet_bytes(True)
        names = sorted(pack["files"])
        self.assertEqual(names, [
            "00-README.txt",
            "01-operations-plan.docx",
            "01-operations-plan.pdf",
            "02-cup-application.docx",
            "02-cup-application.pdf",
            "03-legal-description.docx",
            "03-legal-description.pdf",
        ])
        readme = pack["files"]["00-README.txt"].decode()
        self.assertIn("Sample Ridge", readme)
        self.assertNotIn("Sample Holdings", readme)
        self.assertNotIn("SYN-100", readme)

    def test_ui_hook_and_inline_order(self):
        ui = (ROOT / "pipeline" / "testfit_ui.js").read_text()
        render = (ROOT / "pipeline" / "render.py").read_text()
        self.assertIn('id="tfCup"', ui)
        self.assertIn("cupFromPlan", ui)
        self.assertIn("isAdm", ui)
        self.assertNotIn("sheet.js", ui[ui.find("tfCup") - 80:ui.find("tfCup") + 40])
        i = render.find('"sheet.js", "cup_docs.js", "testfit_ui.js"')
        self.assertGreater(i, 0)
        # the plan-sheet file is not where this packet is implemented
        self.assertNotIn("cupPacket", (ROOT / "pipeline" / "sheet.js").read_text())

    def test_committed_samples_match_the_synthetic_site(self):
        if not (SAMPLES / "public" / "03-legal-description.pdf").exists():
            self.skipTest("samples not written yet")
        pub = (SAMPLES / "public").read_bytes() if False else None
        for folder, secret in (("public", True), ("admin", False)):
            base = SAMPLES / folder
            for name in ("01-operations-plan.pdf", "02-cup-application.pdf", "03-legal-description.pdf",
                         "01-operations-plan.docx", "02-cup-application.docx", "03-legal-description.docx"):
                data = (base / name).read_bytes()
                blob = data
                if name.endswith(".docx"):
                    blob = zipfile.ZipFile(BytesIO(data)).read("word/document.xml")
                raw = blob.decode("latin1", errors="ignore")
                if secret:
                    for token in SECRETS:
                        self.assertNotIn(token, raw, folder + "/" + name)
                    self.assertIsNone(__import__("re").search(r"\d+(?:\.\d+)? MW", raw), folder + "/" + name)
                else:
                    self.assertIn("Sample Holdings LLC", raw if "application" in name or "operations" in name else "Sample Holdings LLC")
            legal = (base / "03-legal-description.pdf").read_bytes()
            self.assertIn(b"NOT A SURVEY", legal)
            self.assertIn("Kansas PLS".encode(), legal)


def write_samples():
    body = """
      const fs = require('fs');
      const path = require('path');
      const root = process.env.CUP_SAMPLE_DIR;
      function dump(mode, built) {
        const dir = path.join(root, mode);
        fs.mkdirSync(dir, {recursive:true});
        const zip = cupPacket(built);
        fs.writeFileSync(path.join(dir, 'packet.zip'), Buffer.from(zip));
        ['operations','application','legal'].forEach(k => {
          const d = built.docs[k];
          fs.writeFileSync(path.join(dir, d.filename + '.pdf'), Buffer.from(cupPdf(d, built)));
          fs.writeFileSync(path.join(dir, d.filename + '.docx'), Buffer.from(cupDocx(d)));
          fs.writeFileSync(path.join(dir, d.filename + '.txt'), d.text);
        });
      }
      dump('public', cupSampleBuild(true));
      dump('admin', cupSampleBuild(false));
      const note = [
        '# Synthetic CUP packet',
        '',
        'Invented site used to show the draft export. Not a filing. Not a survey. Not a real parcel.',
        '',
        '- Name: Sample Ridge',
        '- Place: 1000 Sample Road, Example, Example County, KS',
        '- Outline: a five-sided ring in a local foot plane, not a deed and not State Plane',
        '- `public/` withholds MW, generator counts, water volumes, parcel ids, and the owner',
        '- `admin/` is marked ADMIN — NOT FOR DISTRIBUTION',
        '',
        'The legal description opens with: DRAFT — NOT A SURVEY. Boundary/ALTA survey by a Kansas PLS to be ordered.',
        ''
      ].join('\\n');
      fs.writeFileSync(path.join(root, 'README.md'), note);
      return {ok:true};
    """
    env = os.environ.copy()
    env["CUP_SAMPLE_DIR"] = str(SAMPLES)
    out = node(body, env=env)
    if not out.get("ok"):
        raise SystemExit(out)


if __name__ == "__main__":
    import sys
    if "--write-samples" in sys.argv:
        sys.argv.remove("--write-samples")
        write_samples()
    unittest.main()
