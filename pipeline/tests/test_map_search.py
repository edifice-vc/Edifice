"""Synthetic checks for the map AI search bar (no real site data, no network)."""
import json, re, subprocess, shutil, unittest, pathlib
ROOT = pathlib.Path(__file__).resolve().parents[2]
TPL = (ROOT / 'pipeline' / 'template.html').read_text()

def fn(name):
    m = re.search(r'^function %s\(.*?(?=^function |^const |^//|^let )' % name, TPL, re.S | re.M)
    assert m, name
    return m.group(0)

def const(name):
    m = re.search(r'^const %s=.*?\n' % name, TPL, re.M)
    assert m, name
    return m.group(0)

@unittest.skipUnless(shutil.which('node'), 'node missing')
class MapSearch(unittest.TestCase):
    def js(self, body, extra=''):
        src = ('const SP={sd:{sites:{f1:{flood:{sfha_pct:40}}}}},D={};function spGridEst0(o){return o.g!=null?{mw:o.g}:null}\n'
               'function LS(v,o){return o.score||0}\n' + const('hvm') + extra
               + ''.join(fn(n) for n in ['kmaNorm', 'kmaNear', 'kmaLev1', 'kmaFuzzy', 'kmaBiz', 'aiMW', 'aiFlood'])
               + 'console.log(JSON.stringify((()=>{' + body + '})()))')
        return json.loads(subprocess.run(['node', '-e', src], capture_output=True, text=True, check=True).stdout)

    def test_near_phrases(self):
        r = self.js("return ['storage deals near Wichita at LOI','within 10 mi of Hays','sites near 345 kV','near a substation','around Great Bend, ks','McPherson'].map(kmaNear)")
        self.assertEqual(r[0]['place'], 'wichita'); self.assertEqual(r[0]['mi'], 25); self.assertEqual(r[0]['rest'], 'storage deals at loi')
        self.assertEqual((r[1]['place'], r[1]['mi']), ('hays', 10))
        self.assertNotIn('place', r[2]); self.assertNotIn('place', r[3])
        self.assertEqual(r[4]['place'], 'great bend')
        self.assertNotIn('place', r[5])

    def test_business_intent(self):
        r = self.js("return ['storage deals near wichita','data center sites over 50 mw','mcpherson','345 kv sites'].map(kmaBiz)")
        self.assertEqual(r, ['storage', 'land', None, 'land'])

    def test_fuzzy_fallback(self):
        r = self.js("const P=[['land',{id:'a',name:'I-135 Corridor',city:'McPherson',county:'McPherson',score:5}],['storage',{id:'b',name:'Kellogg lot',city:'Wichita',county:'Sedgwick',score:9}]];"
                    "return [kmaFuzzy('mcphersn',P).map(x=>x[1].id),kmaFuzzy('wich',P).map(x=>x[1].id),kmaFuzzy('topeka',P).length,kmaLev1('salina','salna')]")
        self.assertEqual(r, [['a'], ['b'], 0, True])

    def test_mw_and_flood_sources(self):
        r = self.js("return [aiMW({mw:80,g:10}),aiMW({edits:{mw:'60'}}),aiMW({g:120}),aiMW({}),aiFlood({floodplain:{pct:12}}),aiFlood({id:'f1'}),aiFlood({id:'zz'})]")
        self.assertEqual(r, [80, 60, 120, None, 12, 40, None])

    def test_aiok_map_filters(self):
        aiok = fn('aiOK')
        body = ("const near={lat:37.69,lon:-97.34,mi:25};"
                "const S1={id:'s1',lat:37.7,lon:-97.3,mw:80},S2={id:'f1',lat:37.7,lon:-97.3,mw:80},S3={id:'s3',lat:39.0,lon:-95.7,mw:80},S4={id:'s4',lat:37.7,lon:-97.3,g:20};"
                "AI.land.x={mwMin:50,noFlood:true,near};"
                "return [S1,S2,S3,S4].map(o=>aiOK('land',o))")
        extra = "const AI={land:{x:{},terms:[]},storage:{x:{},terms:[]}};function aiHay(){return ''}function $(){return {value:''}}\n" + aiok
        self.assertEqual(self.js(body, extra), [True, False, False, False])

    def test_parse_extracts_mw_flood(self):
        for pat in [r"mwMin:\+m\[1\]", r"noFlood:true", r"mwMax:\+m\[1\]"]:
            self.assertRegex(TPL, pat)
        self.assertRegex(TPL, r"function aiParse\(raw,force,keep\)")

class Guards(unittest.TestCase):
    def mod(self):
        a = TPL.index('// ---- map AI search'); b = TPL.index('// ---- learning loop')
        return '\n'.join(l for l in TPL[a:b].splitlines() if not l.startswith('//'))

    def test_no_admin_or_zoning_fields(self):
        m = self.mod()
        for bad in ['site_constraints', 'parcel', 'owner', 'zoneomics', 'spGridEst(', 'firestore', 'getDoc', 'onSnapshot']:
            self.assertNotIn(bad, m.lower() if bad.islower() else m)

    def test_no_token_literal(self):
        self.assertNotRegex(TPL, r"pk\.eyJ[0-9A-Za-z_-]{10,}")
        self.assertIn("encodeURIComponent(KM_TOK)", self.mod())

    def test_bar_visible_on_full_map(self):
        self.assertIn('body.mapfull .ais:not(.kmais)', TPL)
        self.assertIn('id="kmQ"', TPL)


class MapCamera(unittest.TestCase):
    def test_clear_never_moves_camera(self):
        body = fn('kmaClear')
        for bad in ('ksMinZoom', 'fitBounds', 'flyTo', 'jumpTo', 'easeTo', 'kmaFit'):
            self.assertNotIn(bad, body)
        # empty input goes straight to kmaClear, never schedules kmAsk
        self.assertRegex(TPL, r"if\(!e\.target\.value\.trim\(\)\)\{kmaClear\(\);return\}")
        self.assertRegex(TPL, r"async function kmAsk\(raw\)\{[^\n]*?if\(!raw\)\{kmaClear\(\);return\}")

    def test_zoom_all_control(self):
        self.assertIn("new G.NavigationControl({showCompass:false}),'top-right');map.addControl(new KmZoomAll(),'top-right')", TPL)
        self.assertIn('title="Zoom out to all"', TPL)
        z = re.search(r'^function kmaZoomAll\(\).*$', TPL, re.M).group(0)
        self.assertIn('kmaAll()', z)
        self.assertNotIn('kmaVis', z)
        self.assertNotIn('flyTo', z)
        self.assertNotIn('kmaFit', z)
        self.assertIn('maxZoom:9', z)
        self.assertIn('ksMinZoom(M.map,true)', z)
        self.assertNotIn('kmQ', z)
        self.assertNotIn('kmaClear', z)
