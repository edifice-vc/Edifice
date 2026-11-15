"""Plan-set export: true scale, public redaction, tagged summary, sheet order, DXF pens.

Synthetic square only. No parcel, owner or Zoneomics data.
"""
import io, json, math, os, re, shutil, subprocess, tempfile, unittest, zipfile
from pathlib import Path

import pypdf

ROOT = Path(__file__).resolve().parents[2]
CHK = (ROOT / 'pipeline' / 'jurisdiction_checklists.json').read_text()
SRC = ('const CV_REF=' + (ROOT / 'pipeline' / 'civil_ref.json').read_text().strip() + ';\n'
       + 'const SS_CHECKLISTS=' + CHK.strip() + ';\n'
       + '\n'.join((ROOT / 'pipeline' / f).read_text() for f in ('planEditSchema.js', 'testfit.js', 'civil.js', 'sheet.js', 'sheetset.js')))
ORDER = ['G-001', 'C-100', 'C-200', 'C-300', 'C-400', 'L-100', 'E-001', 'NZ-101', 'V-101', 'V-201']
SECRETS = ['SYNTHOWNER', 'APN99-12345']
TOKEN = re.compile(r'\bMW\b|generator|\bgpm\b|\bgpd\b|\bgpy\b|SYNTHOWNER|APN99-12345', re.I)


def js(body):
    src = SRC + '\nconsole.log(JSON.stringify((()=>{' + body + '})()))'
    r = subprocess.run(['node'], input=src, capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(r.stderr[-2000:] or r.stdout[-2000:])
    return json.loads(r.stdout)


def export(paper, mode):
    """Return parsed export plus the PDF and DXF bytes, written by node to temp files (binary-safe)."""
    body = r'''
const h=Math.sqrt(80*43560)/2,R=[[-h,-h],[h,-h],[h,h],[-h,h],[-h,-h]];
const r=tfDC(R,Object.assign({},TF_DEF.land,{halls:4,sw:'on'}),{gridMW:40});
const meta={polySrc:'parcel',bsrc:'synthetic',apn:'APN99-12345',owner:'SYNTHOWNER',waterGpm:1250,waterGpd:1800000,
 zone:{has:false},ext:{roads:[{name:'SYNTHETIC RD',row:60,L:[[-h-400,0],[h+400,0]],src:'TIGER'}],flood:[],streams:[],tx:[],places:[]}};
const out=ssExport(r,meta,{paper:%s,mode:%s,date:'2026-11-15'});
const side=Math.hypot(R[1][0]-R[0][0],R[1][1]-R[0][1]);
return {sheets:out.sheets,scale:out.scale,barFt:out.barFt,half:out.half,scales:out.scales,paper:out.paper,mode:out.mode,
 summary:out.summary.map(x=>({value:x.value,tag:x.tag,assumed:x.assumed,sensitive:x.sensitive,print:x.print})),
 check:out.check.map(x=>({n:x.n,status:x.status,title:x.title})),
 registry:ssRegistry(),pens:ssPenTable(),side,
 pdf:out.pdf,dxf:out.dxf.map(d=>({name:d.name,text:d.text})),info:out.info};
''' % (json.dumps(paper), json.dumps(mode))
    return js(body)


def content_streams(pdf_bytes):
    reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
    out = []
    for page in reader.pages:
        out.append(page.get_contents().get_data().decode('latin1'))
    return reader, out


def segments(stream):
    layer, segs, cur = None, [], None
    for line in stream.splitlines():
        if line.startswith('% SS_LAYER '):
            layer = line.split()[-1]
            continue
        parts = line.split()
        if len(parts) == 3 and parts[2] == 'm':
            cur = (float(parts[0]), float(parts[1]))
        elif len(parts) == 3 and parts[2] == 'l' and cur:
            nxt = (float(parts[0]), float(parts[1]))
            segs.append((layer, math.hypot(nxt[0] - cur[0], nxt[1] - cur[1])))
            cur = nxt
        elif line.strip() in ('S', 'h'):
            cur = None
    return segs


def rects(stream):
    layer, out = None, []
    for line in stream.splitlines():
        if line.startswith('% SS_LAYER '):
            layer = line.split()[-1]
        parts = line.split()
        if len(parts) == 5 and parts[4] == 're':
            out.append((layer, float(parts[2]), float(parts[3])))
    return out


def layers_in(stream):
    return {ln.split()[-1] for ln in stream.splitlines() if ln.startswith('% SS_LAYER ')}


def pdf_text(raw):
    """Text-layer strings, with PDF literal escapes removed."""
    out = []
    for m in re.finditer(r'\((?:\\.|[^\\)])*\)', raw):
        s = m.group(0)[1:-1]
        s = re.sub(r'\\([()\\])', r'\1', s)
        out.append(s)
    return '\n'.join(out)


def dxf_table(text):
    rows, ents = {}, set()
    lines = text.splitlines()
    i, section = 0, ''
    while i < len(lines) - 1:
        code, val = lines[i].strip(), lines[i + 1].strip()
        if code == '0' and val == 'SECTION':
            section = lines[i + 3].strip() if i + 3 < len(lines) else ''
        if section == 'TABLES' and code == '0' and val == 'LAYER':
            name = lt = None
            j = i + 2
            while j < len(lines) - 1 and not (lines[j].strip() == '0' and lines[j + 1].strip() in ('LAYER', 'ENDTAB')):
                if lines[j].strip() == '2':
                    name = lines[j + 1].strip()
                if lines[j].strip() == '6':
                    lt = lines[j + 1].strip()
                j += 2
            if name:
                rows[name] = lt
        if section == 'ENTITIES' and code == '8':
            ents.add(val)
        i += 2
    return rows, ents


def thick_runs(ppm_path, dpi, expected_pt):
    raw = Path(ppm_path).read_bytes()
    assert raw.startswith(b'P6')
    header, _, rest = raw.partition(b'\n')
    # pdftoppm writes P6\nW H\n255\n
    parts = raw.split(b'\n', 3)
    w, h = map(int, parts[1].split())
    pix = parts[3]
    expect = expected_pt * dpi / 72
    hits = []
    row_bytes = w * 3
    dark = bytearray(w)
    for y in range(h):
        row = pix[y * row_bytes:(y + 1) * row_bytes]
        for x in range(w):
            dark[x] = 1 if row[x * 3] < 40 and row[x * 3 + 1] < 40 and row[x * 3 + 2] < 40 else 0
        x = 0
        while x < w:
            if not dark[x]:
                x += 1
                continue
            x2 = x
            while x2 < w and dark[x2]:
                x2 += 1
            length = x2 - x
            if abs(length - expect) / expect < 0.02:
                hits.append((y, x, length))
            x = x2
    # a scale bar is many rows tall; a hairline is not
    bands = []
    for y, x, length in hits:
        if bands and abs(bands[-1][0] - y) <= 2 and abs(bands[-1][1] - x) <= 2:
            bands[-1][2].append(length)
            bands[-1][0] = y
        else:
            bands.append([y, x, [length]])
    thick = [sum(b[2]) / len(b[2]) for b in bands if len(b[2]) >= 6]
    return thick, expect


@unittest.skipUnless(shutil.which('node'), 'node missing')
class SheetSet(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pub = export('ARCH_D', 'public')
        cls.adm = export('ARCH_D', 'admin')
        cls.tab = export('TABLOID', 'public')
        cls.arch_e = export('ARCH_E', 'public')

    def test_registry_order_and_pages(self):
        self.assertEqual(self.pub['registry'], ORDER)
        self.assertEqual(self.pub['sheets'], ['G-001', 'C-100'])
        self.assertEqual(len(self.pub['sheets']), len(set(self.pub['sheets'])))
        pdf = self.pub['pdf'].encode('latin1')
        reader, streams = content_streams(pdf)
        self.assertEqual(len(reader.pages), 2)
        self.assertEqual([float(v) for v in reader.pages[1].mediabox], [0, 0, 2592, 1728])
        t0, t1 = streams[0], streams[1]
        self.assertIn('G-001', t0)
        self.assertIn('C-100', t1)
        self.assertLess(t0.find('G-001'), t1.find('C-100') + len(t0))

    def test_public_redaction_and_admin_keeps_tokens(self):
        pdf = self.pub['pdf'].encode('latin1')
        reader, streams = content_streams(pdf)
        blob = '\n'.join(streams) + '\n' + '\n'.join(d['text'] for d in self.pub['dxf'])
        meta = ' '.join(str(reader.metadata.get(k) or '') for k in ('/Title', '/Subject', '/Keywords', '/Author'))
        self.assertIsNone(TOKEN.search(blob), TOKEN.search(blob).group(0) if TOKEN.search(blob) else '')
        self.assertIsNone(TOKEN.search(meta))
        self.assertIsNone(TOKEN.search(self.pub['pdf']))
        admin_blob = self.adm['pdf'] + '\n' + '\n'.join(d['text'] for d in self.adm['dxf'])
        for token in ('MW', 'GENERATOR', '1250 gpm', '1800000 gpd', 'SYNTHOWNER', 'APN99-12345'):
            self.assertIn(token, admin_blob, token)
        self.assertIn('ADMIN - NOT FOR DISTRIBUTION', self.adm['pdf'])
        self.assertNotIn('ADMIN - NOT FOR DISTRIBUTION', self.pub['pdf'])

    def test_scale_bar_and_boundary_within_half_percent(self):
        for pack, size in ((self.pub, (2592, 1728)), (self.arch_e, (3456, 2592)), (self.tab, (1224, 792))):
            pdf = pack['pdf'].encode('latin1')
            reader, streams = content_streams(pdf)
            self.assertEqual((float(reader.pages[1].mediabox[2]), float(reader.pages[1].mediabox[3])), size)
            site = streams[1]
            scale = int(re.search(r'SCALE: 1 IN = (\d+) FT', site).group(1))
            bar_ft = int(re.search(r'SCALE BAR (\d+) FT', site).group(1))
            self.assertEqual(scale, pack['scale'])
            self.assertAlmostEqual(bar_ft / scale, 2.0, places=6)
            rs = [w for layer, w, h in rects(site) if layer == 'SCALEBAR' and h >= 5]
            bar = min(rs, key=lambda w: abs(w - bar_ft * 72 / scale))
            check = min(rs, key=lambda w: abs(w - 72))
            self.assertAlmostEqual(bar, bar_ft * 72 / scale, delta=bar * 0.005)
            self.assertAlmostEqual(check, 72, delta=72 * 0.005)
            bounds = [length for layer, length in segments(site) if layer == 'BOUNDARY']
            self.assertTrue(bounds, 'no boundary segments')
            got = max(bounds)
            expect = pack['side'] * 72 / scale
            self.assertAlmostEqual(got, expect, delta=expect * 0.005)
        self.assertTrue(self.tab['half'])
        shown = pdf_text(self.tab['pdf'])
        self.assertIn('1 IN = %d FT AT 11x17 (1 IN = %d FT AT ARCH D)' % (self.tab['scale'], self.tab['scales']['ARCH_D']), shown)
        self.assertEqual(self.tab['scale'], self.tab['scales']['ARCH_D'] * 2)

    def test_raster_scale_bar(self):
        self.assertTrue(shutil.which('pdftoppm'), 'pdftoppm missing')
        pdf = self.pub['pdf'].encode('latin1')
        _, streams = content_streams(pdf)
        scale = int(re.search(r'SCALE: 1 IN = (\d+) FT', streams[1]).group(1))
        bar_ft = int(re.search(r'SCALE BAR (\d+) FT', streams[1]).group(1))
        with tempfile.TemporaryDirectory() as td:
            src = os.path.join(td, 'set.pdf')
            open(src, 'wb').write(pdf)
            subprocess.run(['pdftoppm', '-r', '150', '-f', '2', '-l', '2', src, os.path.join(td, 'p')], check=True)
            ppm = next(Path(td).glob('*.ppm'))
            for pt in (bar_ft * 72 / scale, 72):
                thick, expect = thick_runs(ppm, 150, pt)
                self.assertTrue(thick, 'no thick bar near %.1f px' % expect)
                best = min(thick, key=lambda n: abs(n - expect))
                self.assertAlmostEqual(best, expect, delta=expect * 0.005)

    def test_summary_tags_survey_notes_and_checklist(self):
        self.assertTrue(all(re.fullmatch(r'\[[ZCFNTHOUA]\]', row['tag']) for row in self.pub['summary']))
        for row in self.pub['summary']:
            if re.search(r'\d', row['value']):
                self.assertRegex(row['tag'], r'^\[[ZCFNTHOUA]\]$')
            if row['assumed']:
                self.assertIn('ASSUMED', row['print'])
        shown = pdf_text(self.pub['pdf'])
        public_rows = [row for row in self.pub['summary'] if not row['sensitive']]
        for row in public_rows:
            self.assertIn(row['print'], shown, row['print'])
        self.assertTrue(any(row['sensitive'] == 'mw' and 'MW' in row['value'] for row in self.pub['summary']))
        self.assertNotIn('SYNTHOWNER', self.pub['pdf'])
        bad = js("let threw=false; try{ssRow('Area','12','')}catch(e){threw=true} return {threw, ok:ssRowsOk([{value:'12',tag:''},{value:'TBD',tag:'[F]'}])}")
        self.assertTrue(bad['threw'])
        self.assertFalse(bad['ok'])
        self.assertIn('Survey to be ordered', shown)
        self.assertIn('FLOOD ELEVATION: TBD', shown)
        self.assertIn('LEGAL DESCRIPTION: Survey to be ordered', shown)
        self.assertEqual([c['n'] for c in self.pub['check']], list(range(1, 25)))
        allowed = {'PRESENT', 'WAIVER REQUESTED', 'N/A', 'MISSING'}
        self.assertTrue(all(c['status'] in allowed for c in self.pub['check']))
        by = {c['n']: c['status'] for c in self.pub['check']}
        self.assertEqual(by[3], 'PRESENT')  # ARCH D is 36x24
        self.assertEqual(by[6], 'MISSING')  # no legal description
        self.assertEqual(by[7], 'MISSING')  # no DEM in the fixture
        self.assertEqual(by[18], 'MISSING')
        self.assertEqual(by[21], 'MISSING')  # no BFE; the sheet says TBD
        tab_by = {c['n']: c['status'] for c in self.tab['check']}
        self.assertEqual(tab_by[3], 'MISSING')
        for n in range(1, 25):
            self.assertIn('(a)(%d) ' % n, shown)

    def test_dxf_layers_match_pen_table_and_pdf(self):
        pens = {p['layer']: p['ltype'] for p in self.pub['pens']}
        _, streams = content_streams(self.pub['pdf'].encode('latin1'))
        pdf_layers = set()
        for stream in streams:
            pdf_layers |= layers_in(stream)
        pdf_layers.discard('PAGE')
        dxf_layers = set()
        for doc in self.pub['dxf']:
            table, ents = dxf_table(doc['text'])
            self.assertEqual(table, pens)
            self.assertTrue(ents <= set(pens))
            dxf_layers |= ents
            self.assertIsNone(TOKEN.search(doc['text']))
        self.assertEqual(pdf_layers, dxf_layers)
        z = self.pub  # zip is not in the JSON (binary). Rebuild from the dxf texts.
        # The export returns zip only inside node; round-trip the DXF texts through the same writer.
        packed = js("const files=%s; return {n:ssZip(files).length, crc:ssCrc(files[0].text)}" % json.dumps(self.pub['dxf']))
        self.assertGreater(packed['n'], 100)

    def test_zip_round_trip(self):
        raw = js("const h=Math.sqrt(10*43560)/2,R=[[-h,-h],[h,-h],[h,h],[-h,h],[-h,-h]]; const r=tfDC(R,Object.assign({},TF_DEF.land,{halls:1,sw:'off'}),{}); const out=ssExport(r,{polySrc:'square',ext:{roads:[],flood:[],places:[]}},{paper:'ARCH_D',mode:'public',date:'2026-11-15'}); return out.zip")
        blob = raw.encode('latin1')
        zf = zipfile.ZipFile(io.BytesIO(blob))
        names = set(zf.namelist())
        self.assertIn('G-001.dxf', names)
        self.assertIn('C-100.dxf', names)
        self.assertIn('plan-set.pdf', names)
        text = zf.read('C-100.dxf').decode('latin1')
        self.assertIn('LAYER', text)
        self.assertIsNone(TOKEN.search(text))


if __name__ == '__main__':
    unittest.main()
