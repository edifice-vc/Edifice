"""Synthetic checks for Site Planning no-build constraints (no real site data)."""
import json, re, subprocess, shutil, unittest, pathlib
ROOT = pathlib.Path(__file__).resolve().parents[2]
TPL = (ROOT / 'pipeline' / 'template.html').read_text()

def fn(name):
    m = re.search(r'^function %s\(.*?(?=^function |^const |^//)' % name, TPL, re.S | re.M)
    assert m, name
    return m.group(0)

@unittest.skipUnless(shutil.which('node'), 'node missing')
class NoBuild(unittest.TestCase):
    def run_js(self, body):
        et = re.search(r'^const SP_ET=.*?\n(?=function )', TPL, re.S | re.M).group(0)
        src = 'const SP={sd:{sites:{}},cx:{}};function own(x){return x}function fmt(x){return x}\n' + et + ''.join(
            fn(n) for n in ['spProj', 'spInside', 'spSegD', 'spNB', 'spNBhit', 'spGridEst', 'spGridEst0', 'spKvMW']) \
            + 'const SP_KV=[[345,450],[230,225],[161,150],[138,110],[115,75],[69,35]];\n' + body
        return json.loads(subprocess.run(['node', '-e', src], capture_output=True, text=True, check=True).stdout)

    def test_hits_and_caps(self):
        r = self.run_js('''
const s={id:'t',lat:38,lon:-97,power:{lines_by_class:[{kv:345,mi:1}]}};
SP.cx.t={caps:{grid_mw:25},easements:[{type:'hl',geometry:{type:'LineString',coordinates:[[-97.01,38],[-96.99,38]]}}],
 exclusions:[{type:'Polygon',coordinates:[[[-97.001,38.002],[-96.999,38.002],[-96.999,38.004],[-97.001,38.004],[-97.001,38.002]]]}]};
SP.sd.sites.t={geo:{sfha:{type:'Polygon',coordinates:[[[-97.001,37.996],[-96.999,37.996],[-96.999,37.998],[-97.001,37.998],[-97.001,37.996]]]}}};
const N=spNB(s,{flood:1}),N0=spNB(s,{flood:0});
console.log(JSON.stringify({on:spNBhit(0,60,N),off:spNBhit(0,90,N),ex:spNBhit(0,1090,N),fl:spNBhit(0,-1090,N),fl0:spNBhit(0,-1090,N0),g:spGridEst(s)}))''')
        self.assertEqual(r['on'], 1)   # within 25+50 ft of centreline
        self.assertEqual(r['off'], 0)
        self.assertEqual(r['ex'], 3)
        self.assertEqual(r['fl'], 2)
        self.assertEqual(r['fl0'], 0)
        self.assertEqual(r['g']['mw'], 25)
        self.assertEqual(r['g']['cap'], 1)

class Rules(unittest.TestCase):
    def test_rules_admin_only(self):
        r = (ROOT / 'firebase' / 'firestore.rules').read_text()
        blk = r[r.index('match /site_constraints/'):][:600]
        self.assertIn('admin()', blk)
        self.assertNotIn('if true', blk)

class Syntax(unittest.TestCase):
    @unittest.skipUnless(shutil.which('node'), 'node missing')
    def test_template_scripts_parse(self):
        for i, s in enumerate(re.findall(r'<script>(.*?)</script>', TPL, re.S)):
            p = subprocess.run(['node', '--check', '-'], input=s, capture_output=True, text=True)
            self.assertEqual(p.returncode, 0, p.stderr[:500])
