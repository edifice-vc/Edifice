"""Sheet-set export: true-scale paper, public redaction, DXF pens, Shawnee Sec. 39.05.

Fixtures are synthetic. Nothing here is a real parcel, owner, or filing.
"""
import json, math, os, pathlib, re, shutil, subprocess, tempfile, unittest
from pypdf import PdfReader

ROOT = pathlib.Path(__file__).resolve().parents[2]
JSPDF = ROOT / 'sunflower' / 'vendor' / 'jspdf.umd.min.js'
ORDER = ['G-001', 'C-100', 'C-200', 'C-300', 'C-400', 'L-100', 'E-001', 'NZ-101', 'V-101', 'V-201', 'OP-001']
BANNED = [
    re.compile(r'\bMW\b'),
    re.compile(r'\bAPN\b', re.I),
    re.compile(r'\bOWNER\b', re.I),
    re.compile(r'\bGENERATORS?\b', re.I),
    re.compile(r'\bGPM\b|\bGPD\b|\bGPY\b|\bAC-FT\b|\bGALLONS?\b', re.I),
    re.compile(r'SYN-APN-88421'),
    re.compile(r'SYN-OWNER-QUINBY'),
]


def _sources():
    cv = (ROOT / 'pipeline' / 'civil_ref.json').read_text().strip()
    chk = (ROOT / 'pipeline' / 'jurisdiction_checklists.json').read_text().strip()
    js = '\n'.join((ROOT / 'pipeline' / f).read_text() for f in (
        'planEditSchema.js', 'testfit.js', 'civil.js', 'sheet.js', 'sheetset.js'))
    return ("const CV_REF=" + cv + ";\nconst SS_CHECKLISTS=" + chk + ";\n" + js
            + "\nconst sq=a=>{const h=Math.sqrt(a*43560)/2;return [[-h,-h],[h,-h],[h,h],[-h,h],[-h,-h]]};\n")


def run_js(body, pdf=False):
    pre = ''
    if pdf:
        pre = "const {jsPDF}=require(" + json.dumps(str(JSPDF)) + "); globalThis.jspdf={jsPDF};\n"
    src = pre + _sources() + "console.log(JSON.stringify((()=>{" + body + "})()))"
    r = subprocess.run(['node'], input=src, capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(r.stderr[-2500:] or r.stdout[-2500:])
    return json.loads(r.stdout)


def meta_js(mode):
    return """const meta={polySrc:'parcel', bsrc:'synthetic GIS', apn:'SYN-APN-88421', owner:'SYN-OWNER-QUINBY',
 project:'Synthetic Campus', address:'100 Example Road', projectNo:'ED-TEST-001', deed:'Book 1 Page 2',
 s:{name:'Synthetic Campus', id:'syn'}, zone:{district:'I-1', has:true, front:100, side:50, rear:50, maxH:75},
 floodKnown:false, date:'2026-11-15', mode:%(mode)s,
 vicinity:{src:'Census TIGERweb', center:[-95.7,39], roads:[{name:'SW EXAMPLE RD', L:[[-95.72,39],[-95.68,39]]}],
  places:[{name:'EXAMPLE CITY', R:[[[-95.73,38.99],[-95.67,38.99],[-95.67,39.02],[-95.73,39.02],[-95.73,38.99]]]}]}};
 const R=sq(80), r=tfDC(R, Object.assign({}, TF_DEF.land, {halls:4, sw:'off', subAc:2, genAc:1}), {gridMW:40});
""" % {'mode': json.dumps(mode)}


def pdf_text(data):
    reader = PdfReader(data)
    text = '\n'.join((p.extract_text() or '') for p in reader.pages)
    meta = {k: str(v) for k, v in (reader.metadata or {}).items()}
    return reader, text, meta


def rect_widths(page):
    raw = page.get_contents().get_data().decode('latin1')
    return [abs(float(m.group(3))) for m in re.finditer(
        r'([-+0-9.]+)\s+([-+0-9.]+)\s+([-+0-9.]+)\s+([-+0-9.]+)\s+re', raw)]


def dxf_layers(text):
    lines = text.splitlines()
    layers = {}
    i = 0
    while i + 1 < len(lines):
        if lines[i].strip() == '0' and lines[i + 1].strip() == 'LAYER':
            name = ltype = None
            i += 2
            while i + 1 < len(lines) and lines[i].strip() != '0':
                if lines[i].strip() == '2':
                    name = lines[i + 1].strip()
                if lines[i].strip() == '6':
                    ltype = lines[i + 1].strip()
                i += 2
            if name:
                layers[name] = ltype
            continue
        i += 2
    return layers


def dxf_ltypes(text):
    lines = text.splitlines()
    names = set()
    i = 0
    while i + 1 < len(lines):
        if lines[i].strip() == '0' and lines[i + 1].strip() == 'LTYPE':
            i += 2
            while i + 1 < len(lines) and lines[i].strip() != '0':
                if lines[i].strip() == '2':
                    names.add(lines[i + 1].strip())
                i += 2
            continue
        i += 2
    return names


def dxf_text(text):
    lines = text.splitlines()
    out = []
    i = 0
    while i + 1 < len(lines):
        if lines[i].strip() == '1':
            out.append(lines[i + 1])
        i += 2
    return '\n'.join(out)


def ppm_runs(path, y):
    with open(path, 'rb') as fh:
        data = fh.read()
    assert data.startswith(b'P6')
    i = 3

    def tok():
        nonlocal i
        while data[i:i + 1] in b' \t\r\n':
            i += 1
        if data[i:i + 1] == b'#':
            while data[i:i + 1] != b'\n':
                i += 1
            return tok()
        j = i
        while data[i:i + 1] not in b' \t\r\n':
            i += 1
        return data[j:i]

    w, h, _ = int(tok()), int(tok()), int(tok())
    if data[i:i + 1] in b' \t\r\n':
        i += 1
    raw = data[i:]
    y = max(0, min(h - 1, int(y)))
    row = raw[y * w * 3:(y + 1) * w * 3]
    best = cur = 0
    for x in range(w):
        p = x * 3
        if row[p] < 40 and row[p + 1] < 40 and row[p + 2] < 40:
            cur += 1
            best = max(best, cur)
        else:
            cur = 0
    return best, w, h


@unittest.skipUnless(shutil.which('node'), 'node missing')
class SheetSet(unittest.TestCase):
    def test_registry_order_and_extension(self):
        r = run_js("""
          const before=ssRegistry().map(s=>s.no);
          ssRegister({no:'E-001', title:'PHOTOMETRIC PLAN', order:70, render:()=>null});
          ssRegister({no:'NZ-101', title:'NOISE SCREENING', order:80, render:(ctx,sh)=>{const d=ssDrawBuf(ctx); return ssPage(sh,d);}});
          const mid=ssRegistry().map(s=>s.no);
          ssResetRegistry();
          return {before, mid, after:ssRegistry().map(s=>s.no), dup:new Set(before).size};
        """)
        self.assertEqual(r['before'], ORDER)
        self.assertEqual(r['dup'], len(ORDER))
        self.assertEqual(r['mid'], ORDER)
        self.assertEqual(r['after'], ORDER)

    def test_scale_picker_and_paper(self):
        r = run_js("""
          return {a:ssPickScale(3000,2000,30,20), b:ssPickScale(8000,5000,30,20), c:ssPickScale(200,200,30,20),
            d:[SS_PAPER.ARCH_D.w, SS_PAPER.ARCH_D.h], e:[SS_PAPER.ARCH_E.w, SS_PAPER.ARCH_E.h],
            t:[SS_PAPER.TABLOID.w, SS_PAPER.TABLOID.h], scales:SS_SCALES};
        """)
        self.assertEqual(r['a'], 100)          # 3000/30 = 100
        self.assertEqual(r['b'], 300)          # 8000/30 = 266.7 -> 300
        self.assertEqual(r['c'], 20)
        self.assertEqual(r['d'], [2592, 1728])
        self.assertEqual(r['e'], [3456, 2592])
        self.assertEqual(r['t'], [1224, 792])
        for s in (20, 30, 40, 50, 60, 100, 200, 300, 400, 500, 600):
            self.assertIn(s, r['scales'])

    def test_summary_tags_survey_and_checklist(self):
        r = run_js(meta_js('public') + """
          const built=ssBuild(r, meta, {paper:'ARCH_D', mode:'public', date:'2026-11-15'});
          let threw=false; try{ssNum(12, null)}catch(e){threw=true}
          let threw2=false; try{ssAssertTagged([{id:'x', v:3, text:'3'}])}catch(e){threw2=true}
          return {threw, threw2, summary:built.summary.map(s=>s.text), survey:built.survey.map(s=>s.label+': '+s.text),
            check:built.check.map(c=>[c.n, c.id, c.status]), pages:built.pages.map(p=>p.no)};
        """)
        self.assertTrue(r['threw'])
        self.assertTrue(r['threw2'])
        self.assertEqual(r['pages'], ['G-001', 'C-100'])
        for text in r['summary']:
            if text.startswith('TBD'):
                self.assertRegex(text, r'^TBD \([^)]+\)$')
            else:
                self.assertRegex(text, r'\[[ZCFNTHOUA]\]')
                if '[A]' in text:
                    self.assertIn('[ASSUMED]', text)
        joined = '\n'.join(r['survey'])
        for label in ('Legal description', 'Survey control', 'Boundary survey', 'Flood elevation'):
            self.assertIn(label + ': SURVEY REQUIRED — TO BE ORDERED', joined)
        self.assertEqual([c[0] for c in r['check']], list(range(1, 25)))
        by = {c[1]: c[2] for c in r['check']}
        self.assertEqual(by['preparer'], 'PRESENT')
        self.assertEqual(by['title'], 'PRESENT')
        self.assertEqual(by['papersize'], 'PRESENT')
        self.assertEqual(by['vicinity'], 'PRESENT')
        self.assertEqual(by['boundary'], 'SURVEY REQUIRED')
        self.assertEqual(by['flood'], 'SURVEY REQUIRED')
        self.assertEqual(by['plat'], 'SURVEY REQUIRED')
        self.assertEqual(by['contours'], 'MISSING')
        self.assertEqual(by['utilities'], 'MISSING')
        self.assertEqual(by['lighting'], 'MISSING')

    def test_registered_sheet_lands_in_order(self):
        r = run_js(meta_js('public') + """
          ssRegister({no:'E-001', title:'PHOTOMETRIC PLAN', order:70, render:(ctx, sh)=>{
            const d=ssDrawBuf(ctx); ssChrome(d, ctx, sh); d.text(ctx.fr.vx+20, ctx.fr.vy+30, 'PHOTOMETRIC MODULE', {size:10, font:'sans'});
            return ssPage(sh, d);}});
          const pages=ssBuild(r, meta, {paper:'ARCH_D', mode:'public', date:'2026-11-15'}).pages.map(p=>p.no);
          ssResetRegistry();
          return pages;
        """)
        self.assertEqual(r, ['G-001', 'C-100', 'E-001'])

    def test_public_pdf_and_dxf_are_redacted(self):
        r = run_js(meta_js('public') + """
          const built=ssBuild(r, meta, {paper:'ARCH_D', mode:'public', date:'2026-11-15'});
          const files=ssDxfFiles(built);
          return {pdf:Buffer.from(ssPdf(built)).toString('base64'), dxf:files.map(f=>f.data).join('\\n'),
            meta:ssDocMeta(built), pages:built.pages.map(p=>p.no)};
        """, pdf=True)
        raw = __import__('base64').b64decode(r['pdf'])
        reader, text, info = pdf_text(__import__('io').BytesIO(raw))
        self.assertEqual(float(reader.pages[0].mediabox.width), 2592)
        self.assertEqual(float(reader.pages[0].mediabox.height), 1728)
        blob = text + '\n' + '\n'.join(info.values()) + '\n' + r['dxf']
        for rx in BANNED:
            self.assertIsNone(rx.search(blob), rx.pattern)
        self.assertNotIn('SYN-APN-88421', r['meta']['title'] + r['meta']['subject'] + r['meta']['keywords'])
        self.assertIn('NOT FOR CONSTRUCTION', text)
        self.assertIn('PRELIMINARY', text)
        self.assertIn('SURVEY REQUIRED — TO BE ORDERED', text)
        self.assertIn('CENSUS TIGER', text)
        layers = dxf_layers(r['dxf'])
        ltypes = dxf_ltypes(r['dxf'])
        pens = run_js("return SS_PEN_LIST.map(p=>({layer:p.layer, ltype:p.ltype}))")
        self.assertEqual(set(layers), {p['layer'] for p in pens})
        for p in pens:
            self.assertEqual(layers[p['layer']], p['ltype'])
            self.assertIn(p['ltype'], ltypes)
        self.assertNotRegex(dxf_text(r['dxf']), r'\bMW\b|SYN-APN-88421|SYN-OWNER-QUINBY')

    def test_admin_pdf_keeps_sensitive_fields(self):
        r = run_js(meta_js('admin') + """
          const built=ssBuild(r, meta, {paper:'ARCH_D', mode:'admin', date:'2026-11-15'});
          return {pdf:Buffer.from(ssPdf(built)).toString('base64'), dxf:ssDxf(built.pages.find(p=>p.no==='C-100'), built)};
        """, pdf=True)
        _, text, info = pdf_text(__import__('io').BytesIO(__import__('base64').b64decode(r['pdf'])))
        blob = text + '\n' + info.get('/Subject', '') + '\n' + info.get('/Keywords', '') + '\n' + r['dxf']
        self.assertRegex(blob, r'\bMW\b')
        self.assertIn('SYN-APN-88421', blob)
        self.assertIn('SYN-OWNER-QUINBY', blob)
        self.assertIn('ADMIN — NOT FOR DISTRIBUTION', text)
        self.assertIn('Generator yards', text)

    def test_scale_within_half_percent(self):
        r = run_js(meta_js('public') + """
          const out={};
          for (const paper of ['ARCH_D','ARCH_E','TABLOID']){
            const built=ssBuild(r, meta, {paper, mode:'public', date:'2026-11-15'});
            const page=built.pages.find(p=>p.no==='C-100');
            out[paper]={w:built.paper.w, h:built.paper.h, scale:built.scale, scaleFull:built.scaleFull, fit:built.fit,
              bar:page.bar, check:page.check, pdf:Buffer.from(ssPdf(built)).toString('base64')};
          }
          return out;
        """, pdf=True)
        for paper, spec in r.items():
            reader, text, _ = pdf_text(__import__('io').BytesIO(__import__('base64').b64decode(spec['pdf'])))
            page = reader.pages[1]
            self.assertEqual(float(page.mediabox.width), spec['w'])
            self.assertEqual(float(page.mediabox.height), spec['h'])
            bar_pt = spec['bar']['x2'] - spec['bar']['x1']
            stated = spec['bar']['feet'] / (bar_pt / 72.0)
            self.assertLess(abs(stated - spec['scale']) / spec['scale'], 0.005)
            widths = rect_widths(page)
            nearest = min(widths, key=lambda w: abs(w - bar_pt))
            self.assertLess(abs(nearest - bar_pt) / bar_pt, 0.005)
            check = spec['check']['w']
            self.assertLess(abs(check - 72) / 72, 0.005)
            nearest_c = min(widths, key=lambda w: abs(w - check))
            self.assertLess(abs(nearest_c - check) / check, 0.005)
            self.assertIn('1" = ', text)
            if paper == 'ARCH_D':
                self.assertIn(str(int(spec['scaleFull'])) if spec['scaleFull'] == int(spec['scaleFull']) else '', text)
                self.assertAlmostEqual(spec['fit'], 1)
                self.assertIn(spec['scaleFull'], run_js("return SS_SCALES"))
            if paper == 'TABLOID':
                self.assertAlmostEqual(spec['fit'], 11 / 24, places=6)
                self.assertAlmostEqual(spec['scale'], spec['scaleFull'] / spec['fit'], places=4)
                self.assertIn('11×17', text)
                self.assertIn('ARCH D', text)

    @unittest.skipUnless(shutil.which('pdftoppm'), 'pdftoppm missing')
    def test_scale_bar_raster(self):
        r = run_js(meta_js('public') + """
          const built=ssBuild(r, meta, {paper:'ARCH_D', mode:'public', date:'2026-11-15'});
          const page=built.pages.find(p=>p.no==='C-100');
          return {check:page.check, pdf:Buffer.from(ssPdf(built)).toString('base64')};
        """, pdf=True)
        dpi = 200
        with tempfile.TemporaryDirectory() as d:
            pdf = os.path.join(d, 's.pdf')
            with open(pdf, 'wb') as fh:
                fh.write(__import__('base64').b64decode(r['pdf']))
            subprocess.run(['pdftoppm', '-r', str(dpi), '-f', '2', '-l', '2', pdf, os.path.join(d, 'p')], check=True)
            ppm = os.path.join(d, 'p-2.ppm')
            y = int(round((r['check']['y'] + r['check']['h'] / 2) * dpi / 72))
            best = 0
            w = h = 0
            for dy in range(-3, 4):
                got, w, h = ppm_runs(ppm, y + dy)
                best = max(best, got)
        expect = r['check']['w'] * dpi / 72.0
        self.assertGreater(best, 20)
        self.assertLessEqual(abs(best - expect) / expect, 0.005)
        self.assertEqual(w, int(round(2592 * dpi / 72)))
        self.assertEqual(h, int(round(1728 * dpi / 72)))

    def test_button_is_admin_only_and_renderer_inlines_engine(self):
        ui = (ROOT / 'pipeline' / 'testfit_ui.js').read_text()
        render = (ROOT / 'pipeline' / 'render.py').read_text()
        self.assertIn('Sheet set (beta)', ui)
        self.assertIn("id==='tfSet'", ui)
        self.assertRegex(ui, r"isAdm\(\)\?`[^`]*id=\"tfSet\"")
        self.assertIn("if(typeof isAdm!=='function'||!isAdm())", ui)
        self.assertIn('sheetset.js', render)
        self.assertIn('jurisdiction_checklists.json', render)
        self.assertLess(render.index('sheet.js'), render.index('sheetset.js'))
        self.assertLess(render.index('sheetset.js'), render.index('testfit_ui.js'))


if __name__ == '__main__':
    unittest.main()
