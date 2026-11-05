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
        return json.loads(subprocess.run(['node'], input=src, capture_output=True, text=True, check=True).stdout)

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


@unittest.skipUnless(shutil.which('node'), 'node missing')
class TracedPolygon(NoBuild):
    def test_polygon_easement_is_hard_no_build(self):
        r = self.run_js('''
const s={id:'t',lat:38,lon:-97};
SP.cx.t={easements:[{type:'hl',width_ft:75,setback_ft:20,approx:false,geometry:{type:'Polygon',coordinates:[[[-97.003,37.9999],[-96.997,37.9999],[-96.997,38.0001],[-97.003,38.0001],[-97.003,37.9999]]]}}]};
const N=spNB(s,{flood:1});
console.log(JSON.stringify({inside:spNBhit(0,0,N),sb:spNBhit(0,50,N),out:spNBhit(0,80,N)}))''')
        self.assertEqual(r['inside'], 1)   # inside the traced polygon (±36 ft)
        self.assertEqual(r['sb'], 1)       # within the 20 ft setback of its edge
        self.assertEqual(r['out'], 0)


class TraceCommand(unittest.TestCase):
    def test_trace_replaces_osm_easement(self):
        import sys, tempfile, types
        sys.path.insert(0, str(ROOT / 'pipeline')); import site_constraints as sc
        d = pathlib.Path(tempfile.mkdtemp())
        (d / 'src.json').write_text(json.dumps({'x': {'lat': 38, 'lon': -97, 'acres': 10,
            'easements': [{'id': 'p', 'type': 'hl', 'osm_way': 1, 'approx': True}]}}))
        (d / 'l.geojson').write_text(json.dumps({'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': [[-97.01, 37.99], [-96.99, 38.01]]}}))
        a = types.SimpleNamespace(site='x', file=str(d / 'l.geojson'), id='p', type=None, label=None, basis=None, width=75.0, setback=50.0)
        sc.trace(a, str(d / 'src.json'))
        e = json.loads((d / 'src.json').read_text())['x']['easements']
        self.assertEqual(len(e), 1); self.assertFalse(e[0]['approx']); self.assertEqual(e[0]['width_ft'], 75.0)
        self.assertNotIn('osm_way', e[0]); self.assertEqual(e[0]['geometry']['type'], 'LineString')
        a.width = None
        with self.assertRaises(SystemExit): sc.trace(a, str(d / 'src.json'))


class StoredParcel(unittest.TestCase):
    @unittest.skipUnless(shutil.which('node'), 'node missing')
    def test_parcel_replaces_square(self):
        et = re.search(r'^const SP_ET=.*?\n(?=function )', TPL, re.S | re.M).group(0)
        src = 'const SP={sd:{sites:{}},cx:{}};\n' + et + fn('spParcelParts') + fn('spParcel') + '''
const s={id:'t'};
const a=spParcel(s);SP.cx.t={parcel:{type:'Polygon',coordinates:[[[-97,38],[-96.99,38],[-96.99,38.01],[-97,38.01],[-97,38]]]}};
console.log(JSON.stringify({a,b:spParcel(s).length}))'''
        r = json.loads(subprocess.run(['node'], input=src, capture_output=True, text=True, check=True).stdout)
        self.assertIsNone(r['a']); self.assertEqual(r['b'], 5)
        self.assertIn("SP.polySrc='parcel'", TPL)            # loaded parcel replaces the square, not a drawn boundary
        self.assertIn("SP.polySrc==='square')spSetParcel(s)", TPL)

    def test_parcel_command(self):
        import sys, tempfile, types
        sys.path.insert(0, str(ROOT / 'pipeline')); import site_constraints as sc
        d = pathlib.Path(tempfile.mkdtemp())
        (d / 'src.json').write_text(json.dumps({'x': {'lat': 38, 'lon': -97, 'acres': 10}}))
        (d / 'p.geojson').write_text(json.dumps({'type': 'Polygon', 'coordinates': [[[-97, 38], [-96.99, 38], [-96.99, 38.01], [-97, 38]]]}))
        sc.parcel(types.SimpleNamespace(site='x', file=str(d / 'p.geojson'), src='ALTA', acres=144.58), str(d / 'src.json'))
        c = json.loads((d / 'src.json').read_text())['x']
        self.assertEqual(c['parcel']['type'], 'Polygon'); self.assertEqual(c['parcel_ac'], 144.58)
        (d / 'l.geojson').write_text(json.dumps({'type': 'LineString', 'coordinates': [[-97, 38], [-96.99, 38]]}))
        with self.assertRaises(SystemExit):
            sc.parcel(types.SimpleNamespace(site='x', file=str(d / 'l.geojson'), src=None, acres=None), str(d / 'src.json'))


@unittest.skipUnless(shutil.which('node'), 'node missing')
class FuelCell(unittest.TestCase):
    def solve(self, gen):
        et = re.search(r'^const SP_ET=.*?\n(?=function )', TPL, re.S | re.M).group(0)
        defs = re.search(r'^const SP_DEF=.*?\n', TPL, re.M).group(0) + re.search(r'^const SP_GEN=.*?\n', TPL, re.M).group(0)
        src = ('const SP={sd:{sites:{}},cx:{},ly:{}};function own(x){return x}function fmt(x){return x}function spN(x){return x}\n'
               'const SP_KV=[[345,450],[230,225],[161,150],[138,110],[115,75],[69,35]];\n' + et + defs + ''.join(fn(n) for n in [
                   'spGenInp', 'spProj', 'spInside', 'spSegD', 'spArea', 'spSquare', 'spNB', 'spNBhit', 'spGrid', 'spPack', 'spPlantFree',
                   'spSolve', 'spSub', 'spGridEst', 'spGridEst0', 'spGasEst', 'spGasEst0', 'spKvMW']) + '''
const s={id:'t',lat:38,lon:-97};SP.cx.t=%s;
const inp=Object.assign({},SP_DEF,{hallL:800,wsf:150});const r=spSolve(s,spSquare(s,144),inp);
console.log(JSON.stringify({it:r.best.it,k:r.best.k,inst:r.best.inst,gasUse:r.best.gasUse,gas:r.best.gas||null,gen:r.gen,grid:r.grid}))''' % json.dumps(gen))
        return json.loads(subprocess.run(['node'], input=src, capture_output=True, text=True, check=True).stdout)

    def test_fuel_cell_vs_recip(self):
        fc = self.solve({'gen': {'type': 'fuel_cell', 'grid_mw': 50, 'uncapped': True}})
        self.assertEqual(fc['gen'], 'fuel_cell'); self.assertEqual(fc['grid'], 50)
        self.assertGreater(fc['it'], 0)
        run = fc['it'] * 1.3 - 50
        self.assertAlmostEqual(fc['gasUse'], run, 3)
        self.assertGreaterEqual(fc['k'] * 0.325 / 1.31, run - 1e-6)           # 1.31x installed covers running load
        self.assertLess((fc['k'] - 1) * 0.325 / 1.31, run)
        self.assertAlmostEqual(fc['gas']['mmcfd'], run * 7000 / 1000 * 24 / 1037, 3)
        rc = self.solve({'caps': {'grid_mw': 50, 'gas_mw': 0.6}})              # no gen setting: recip, gas capped
        self.assertEqual(rc['gen'], 'recip'); self.assertIsNone(rc['gas'])
        self.assertLess(rc['it'], fc['it'])

    def test_plan_command(self):
        import sys, tempfile, types
        sys.path.insert(0, str(ROOT / 'pipeline')); import site_constraints as sc
        d = pathlib.Path(tempfile.mkdtemp())
        (d / 'src.json').write_text(json.dumps({'x': {'lat': 38, 'lon': -97, 'acres': 10}}))
        sq = {'type': 'Polygon', 'coordinates': [[[-97, 38], [-96.99, 38], [-96.99, 38.01], [-97, 38]]]}
        (d / 'p.json').write_text(json.dumps({'gen': {'type': 'fuel_cell', 'grid_mw': 50, 'uncapped': True},
            'plan': {'name': 'A', 'k': {'it': 180}, 'layout': {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'properties': {'kind': 'hall'}, 'geometry': sq}]}}}))
        sc.plan(types.SimpleNamespace(site='x', file=str(d / 'p.json')), str(d / 'src.json'))
        c = json.loads((d / 'src.json').read_text())['x']
        self.assertEqual(c['gen']['type'], 'fuel_cell'); self.assertEqual(c['plan']['k']['it'], 180)
        (d / 'b.json').write_text(json.dumps({'gen': {'type': 'nuclear'}}))
        with self.assertRaises(SystemExit):
            sc.plan(types.SimpleNamespace(site='x', file=str(d / 'b.json')), str(d / 'src.json'))


class AdoptedPlanView(unittest.TestCase):
    def test_live_repack_collapsed_under_adopted_plan(self):
        out = fn('spOut')
        self.assertIn('<details class="spvar">', out)
        self.assertIn("Explore variants", out)
        self.assertIn("(AP?'</details>':'')", out)
        self.assertTrue(out.index('AP+(AP?') < out.index('<div class="spbig">'))  # adopted panel stays the headline

    @unittest.skipUnless(shutil.which('node'), 'node missing')
    def test_gas_note(self):
        gen = re.search(r'^const SP_GEN=.*?\n', TPL, re.M).group(0)
        src = ('const SP={cx:{}};const spCx=s=>SP.cx[s.id]||null;' + gen + fn('spGasNote') + '''
SP.cx.a={gen:{type:'fuel_cell',uncapped:true},caps:{gas_mw:0.6},plan:{k:{run:184}}};
SP.cx.b={gen:{type:'fuel_cell',uncapped:false},caps:{gas_mw:0.6}};SP.cx.c={caps:{gas_mw:0.6}};
SP.cx.d={gen:{type:'fuel_cell',uncapped:true}};
console.log(JSON.stringify([spGasNote({id:'a'}),spGasNote({id:'b'}),spGasNote({id:'c'}),spGasNote({id:'d'},{gas:{mmcfd:12.4}})]))''')
        r = json.loads(subprocess.run(['node'], input=src, capture_output=True, text=True, check=True).stdout)
        self.assertEqual(r, ['Needs new gas supply (~30 MMcf/d)', '', '', 'Needs new gas supply (~12 MMcf/d)'])
        self.assertIn('spGasNote(s)?', TPL)  # caps line in the constraints panel drops the 0.6 MW gas cap
