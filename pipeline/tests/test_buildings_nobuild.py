"""Existing building footprints are no-build (kind 7) with a buffer; owner≠seller banner flag."""
import json, re, subprocess, shutil, unittest, pathlib
ROOT = pathlib.Path(__file__).resolve().parents[2]
TPL = (ROOT / 'pipeline' / 'template.html').read_text()
UI = (ROOT / 'pipeline' / 'testfit_ui.js').read_text()
CIV = (ROOT / 'pipeline' / 'civil.js').read_text()
SHEET = (ROOT / 'pipeline' / 'sheet.js').read_text()

def fn(name, src=None):
    src = src or TPL
    m = re.search(r'^function %s\(.*?(?=^function |^const |^//)' % name, src, re.S | re.M)
    assert m, name
    return m.group(0)

@unittest.skipUnless(shutil.which('node'), 'node missing')
class BuildingsNoBuild(unittest.TestCase):
    def run_js(self, body):
        et = re.search(r'^const SP_ET=.*?\n(?=function )', TPL, re.S | re.M).group(0)
        src = ('const SP={sd:{sites:{}},cx:{},ly:{},pd:{},inp:{}};const SHX={};\n'
               'function own(x){return x}function fmt(x){return x}function esc(x){return x}\n'
               + et + ''.join(fn(n) for n in ['spOwnerFlag', 'spProj', 'spInside', 'spSegD', 'spNB', 'spNBhit', 'spArea', 'spGrid'])
               + body)
        r = subprocess.run(['node'], input=src, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr[:800])
        return json.loads(r.stdout)

    def test_building_poly_and_buffer_are_kind_7(self):
        # 100x100 ft building centered at origin in local ft ≈ 0,0 at lat/lon of pin
        # use SHX.bld with local-ft rings already (spNB expects local ft in X.bld.R)
        r = self.run_js(r'''
const s={id:'t',lat:38,lon:-97,name:'Salina Airport Authority'};
SHX.t={roads:[],streams:[],tx:[],flood:[],bld:[{name:'Warehouse',R:[[[-50,-50],[50,-50],[50,50],[-50,50],[-50,-50]]] }],bldBuf:50};
const N=spNB(s,{flood:1});
console.log(JSON.stringify({
  inside:spNBhit(0,0,N),
  edgeBuf:spNBhit(0,90,N),
  outside:spNBhit(0,120,N),
  kinds:[...new Set(N.polys.map(p=>p[1]).concat(N.segs.map(q=>q[5]).filter(Boolean)))]
}))''')
        self.assertEqual(r['inside'], 7)
        self.assertEqual(r['edgeBuf'], 7)   # 50 ft past the 50 ft building edge
        self.assertEqual(r['outside'], 0)
        self.assertIn(7, r['kinds'])

    def test_nbB_in_grid(self):
        r = self.run_js(r'''
const s={id:'t',lat:38,lon:-97};
SHX.t={roads:[],streams:[],tx:[],flood:[],bld:[{name:'B',R:[[[-40,-40],[40,-40],[40,40],[-40,40],[-40,-40]]] }],bldBuf:50};
const poly=[[-97.002,37.998],[-96.998,37.998],[-96.998,38.002],[-97.002,38.002],[-97.002,37.998]];
const G=spGrid(poly,{ease:0,flood:1,set:0},s);
console.log(JSON.stringify({nbB:G.nbB,build:G.buildAc,area:G.areaAc}))''')
        self.assertGreater(r['nbB'], 0.05)
        self.assertLess(r['build'], r['area'])

    def test_owner_flag(self):
        r = self.run_js(r'''
SP.pd={a:{deal:{owner:'AMAZON.COM SERVICES LLC',seller:'Salina Airport Authority'}},
       b:{deal:{owner:'SALINA AIRPORT AUTHORITY TERMINAL BLDG 120',seller:'Salina Airport Authority'}},
       c:{deal:{owner:'SALINA AIRPORT AUTHORITY',seller:null}}};
console.log(JSON.stringify({
  mism:spOwnerFlag({id:'a',name:'Water Well Rd lots (Salina Airport Authority)'}),
  ok:spOwnerFlag({id:'b',name:'Water Well Rd lots (Salina Airport Authority)'}),
  okName:spOwnerFlag({id:'c',name:'Salina Airport Authority lots'}),
  none:spOwnerFlag({id:'z',name:'x'})
}))''')
        self.assertIn('OWNER', r['mism'])
        self.assertIn('AMAZON', r['mism'])
        self.assertEqual(r['ok'], '')
        self.assertEqual(r['okName'], '')
        self.assertEqual(r['none'], '')

class SourceWiring(unittest.TestCase):
    def test_shx_loads_buildings(self):
        self.assertIn('v===4', UI)
        self.assertIn('bldBuf:50', UI)
        self.assertIn('MSBFP2', UI)
        self.assertIn('way["building"]', UI)
        self.assertIn("Existing buildings + 50 ft buffer", UI)

    def test_civil_and_sheet_budget(self):
        self.assertIn('if(k===7){o.bld++;continue}', CIV)
        self.assertIn('Existing buildings', SHEET)
        self.assertIn('id="hB"', SHEET)
        self.assertIn('nbB:ac(k=>nb[k]===7)', TPL)
        self.assertIn('existing buildings ${spN(G.nbB,1)}', TPL)
        # public hint must not surface parcel numbers from the parcels doc
        self.assertNotIn("deal.apn?' · '+SP.pd[s.id].deal.apn", TPL)

if __name__ == '__main__':
    unittest.main()
