"""ISO 9613-2 screening engine. Hand checks against the standard's formulas, not a vendor model.

The published ±3 dB (ISO 9613-2 Table 5) applies when the inputs are known. These tests
lock the arithmetic. They do not make an assumed equipment spectrum into a sound study.
"""
import json, math, pathlib, shutil, subprocess, sys, unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
FILES = ('isolines.js', 'noise.js')

def load(*names):
    return '\n'.join((ROOT / 'pipeline' / n).read_text() for n in names)

def js(body, files=FILES, promise=False):
    if promise:
        src = load(*files) + '\n(async()=>{try{const v=await (async()=>{' + body + '\n})();console.log(JSON.stringify(v))}catch(e){console.error(e&&e.stack||e);process.exit(1)}})()'
    else:
        src = load(*files) + '\nconsole.log(JSON.stringify((()=>{' + body + '\n})()))'
    r = subprocess.run(['node'], input=src, capture_output=True, text=True)
    if r.returncode:
        raise AssertionError(r.stderr[-2000:])
    return json.loads(r.stdout)

def py_alpha(freq, temp_c, rh, p_kpa=101.325):
    """ISO 9613-1 eq. 5, written out here so the JS result has a second implementation."""
    T = temp_c + 273.15
    T0, T01, pr = 293.15, 273.16, 101.325
    psat = 10 ** (-6.8346 * (T01 / T) ** 1.261 + 4.6151)
    h = rh * psat * (pr / p_kpa)
    frO = (p_kpa / pr) * (24 + 4.04e4 * h * (0.02 + h) / (0.391 + h))
    frN = (p_kpa / pr) * (T / T0) ** -0.5 * (9 + 280 * h * math.exp(-4.170 * ((T / T0) ** (-1 / 3) - 1)))
    f2 = freq * freq
    classical = 1.84e-11 * (pr / p_kpa) * math.sqrt(T / T0)
    relax = (T / T0) ** -2.5 * (
        0.01275 * math.exp(-2239.1 / T) / (frO + f2 / frO)
        + 0.1068 * math.exp(-3352.0 / T) / (frN + f2 / frN)
    )
    return 8.686 * f2 * (classical + relax) * 1000

def py_dz(freq, z, dss, dsr, d, e, c):
    lam = c / freq
    C3 = 1.0 if not e else (1 + (5 * lam / e) ** 2) / (1 / 3 + (5 * lam / e) ** 2)
    K = 1.0 if z <= 0 else math.exp(-math.sqrt(max(0.0, dss * dsr * d / (2 * z))) / 2000)
    arg = 3 + (20 / lam) * C3 * z * K
    Dz = 10 * math.log10(arg if arg > 1 else 1)
    return min(Dz, 25 if e else 20)


@unittest.skipUnless(shutil.which('node'), 'node missing')
class NoiseTerms(unittest.TestCase):
    def test_divergence_and_inverse_square(self):
        r = js('return {a:nzAdiv(100), b:nzAdiv(200)-nzAdiv(100), c:nzSumDb([60,60])}')
        self.assertAlmostEqual(r['a'], 51, places=9)
        self.assertAlmostEqual(r['b'], 20 * math.log10(2), places=9)
        self.assertAlmostEqual(r['c'], 63.0103, places=3)

    def test_weights_match_iec_rounded_values(self):
        r = js('return {A:NZ_BANDS.map(nzDbA), C:NZ_BANDS.map(nzDbC)}')
        A = [-26.2, -16.1, -8.6, -3.2, 0, 1.2, 1.0, -1.1]
        C = [-0.8, -0.2, 0, 0, 0, -0.2, -0.8, -3.0]
        for got, exp in zip(r['A'], A):
            self.assertAlmostEqual(got, exp, delta=0.1)
        for got, exp in zip(r['C'], C):
            self.assertAlmostEqual(got, exp, delta=0.1)

    def test_alpha_matches_iso_9613_1_table(self):
        # 20 °C / 50% is the phonometry reproduction of ISO 9613-1 Table 1 (dB/km).
        published_20_50 = [0.12, 0.44, 1.31, 2.73, 4.66, 9.89, 29.67, 105.29]
        # 10 °C / 70% is the rounded table used by ISO 9613-2 screening write-ups.
        # 8 kHz rounds to 117; the formula (and the ETH lecture's "117") sits near 118.
        published_10_70 = [0.1, 0.4, 1.0, 1.9, 3.7, 9.7, 33, 117]
        r = js('return {a:NZ_BANDS.map(f=>nzAlpha(f,20,50,101.325)), b:NZ_BANDS.map(f=>nzAlpha(f,10,70,101.325))}')
        for got, exp, f in zip(r['a'], published_20_50, [63, 125, 250, 500, 1000, 2000, 4000, 8000]):
            self.assertAlmostEqual(got, exp, delta=0.02, msg=f)
            self.assertAlmostEqual(got, py_alpha(f, 20, 50), places=6)
        for got, exp, f in zip(r['b'], published_10_70, [63, 125, 250, 500, 1000, 2000, 4000, 8000]):
            tol = 2.0 if f == 8000 else 0.2
            self.assertAlmostEqual(got, exp, delta=tol, msg=f)

    def test_soft_ground_63_hz_is_minus_3(self):
        # q = 0 when dp <= 30(hs+hr). 100 m < 30*(5+1.5). Table 3 then gives As = Ar = -1.5, Am = 0.
        r = js("""return nzPropagate({units:'m', met:{tempC:10,rh:70}, ground:{G:1},
          source:{x:0,y:0,z:5,lw:[100,null,null,null,null,null,null,null]},
          receiver:{x:100,y:0,z:1.5}}).bands[0]""")
        self.assertAlmostEqual(r['Agr'], -3, places=6)
        self.assertAlmostEqual(r['Adiv'], 20 * math.log10(r['d']) + 11, places=6)
        self.assertAlmostEqual(r['Lp'], r['Lw'] + r['Dc'] - r['A'], places=9)
        self.assertFalse(r['blocked'])
        self.assertEqual(r['Abar'], 0)

    def test_blocking_barrier_matches_hand_geometry(self):
        # Wall top at z=5, line of sight at the wall is 1.25 m, so the edge blocks.
        S, E, R = (0, 0, 1), (20, 0, 5), (40, 0, 1.5)
        dss, dsr, d = math.dist(S, E), math.dist(E, R), math.dist(S, R)
        z = dss + dsr - d
        r = js("""const p=nzPropagate({units:'m', met:{tempC:10,rh:70,speed:340}, ground:{G:0.5},
          source:{x:0,y:0,z:1,lw:[90,90,90,90,90,90,90,90]},
          receiver:{x:40,y:0,z:1.5},
          barriers:[{id:'wall',kind:'berm',line:[[20,-30],[20,30]],z:5}]});
          const open=nzPropagate({units:'m', met:{tempC:10,rh:70,speed:340}, ground:{G:0.5},
          source:{x:0,y:0,z:1,lw:[90,90,90,90,90,90,90,90]}, receiver:{x:40,y:0,z:1.5}});
          return {b:p.bands[3], drop:open.dBA-p.dBA}""")
        b = r['b']
        self.assertTrue(b['blocked'])
        self.assertAlmostEqual(b['z'], z, places=3)
        self.assertAlmostEqual(b['Dz'], py_dz(500, z, dss, dsr, d, 0, 340), places=2)
        self.assertAlmostEqual(b['Abar'], max(0, b['Dz'] - b['Agr']), places=6)
        self.assertGreater(r['drop'], 2)  # the wall has to lower the level

    def test_wall_below_the_line_of_sight_gets_a_negative_z(self):
        # The worked example that is often copied with the sign flipped: barrier 2.4 m,
        # line of sight at the wall 4.2 m. ISO gives z a negative sign. d is the slant, not 200 m.
        ds = math.hypot(80, 6 - 2.4)
        dr = math.hypot(120, 2.4 - 1.5)
        slant = math.hypot(200, 6 - 1.5)
        zmag = ds + dr - slant
        r = js("""return nzPropagate({units:'m', met:{tempC:10,rh:70,speed:340}, ground:{G:1},
          source:{x:0,y:0,z:6,lw:[100,98,95,92,88,84,79,70]},
          receiver:{x:200,y:0,z:1.5},
          barriers:[{id:'wall',kind:'berm',line:[[80,-5],[80,5]],z:2.4}]}).bands[4]""")
        self.assertFalse(r['blocked'])
        self.assertLess(r['z'], 0)
        self.assertAlmostEqual(abs(r['z']), zmag, delta=0.002)
        self.assertAlmostEqual(r['Adiv'], 20 * math.log10(max(slant, 1)) + 11, places=3)

    def test_building_is_double_diffraction(self):
        S, E1, E2, R = (-10, 0, 1), (10, 0, 8), (30, 0, 8), (50, 0, 1.5)
        z = math.dist(S, E1) + math.dist(E1, E2) + math.dist(E2, R) - math.dist(S, R)
        r = js("""return nzPropagate({units:'m', met:{speed:340,tempC:10,rh:70}, ground:{G:0.5},
          source:{x:-10,y:0,z:1,lw:[80,80,80,80,80,80,80,80]},
          receiver:{x:50,y:0,z:1.5},
          barriers:[{id:'hall',kind:'building',polygon:[[10,-10],[30,-10],[30,10],[10,10]],roofZ:8}]}).bands[0]""")
        self.assertTrue(r['blocked'])
        self.assertAlmostEqual(r['z'], z, places=2)
        self.assertGreater(r['Dz'], 0)
        self.assertLessEqual(r['Dz'], 25)

    def test_short_barrier_does_not_screen_63_hz(self):
        r = js("""const p=nzPropagate({units:'m', met:{tempC:10,rh:70}, ground:{G:0.5},
          source:{x:0,y:0,z:1,lw:[90,90,90,90,90,90,90,90]}, receiver:{x:20,y:0,z:1.5},
          barriers:[{id:'post',kind:'berm',line:[[10,-0.5],[10,0.5]],z:8}]});
          return {low:p.bands[0].Abar, high:p.bands[7].Abar, lowBlock:p.bands[0].blocked}""")
        self.assertEqual(r['low'], 0)
        self.assertFalse(r['lowBlock'])
        self.assertGreater(r['high'], 0)

    def test_two_sources_add_as_energy(self):
        r = js("""const lw=[null,null,null,null,100,null,null,null];
          const base={units:'m',ground:{G:0},met:{tempC:10,rh:70}};
          const one=nzLevelAt(Object.assign({},base,{sources:[{id:'a',x:0,y:0,z:5,lw,assumed:false}]}),80,0,'typical_day');
          const two=nzLevelAt(Object.assign({},base,{sources:[{id:'a',x:0,y:0,z:5,lw,assumed:false},{id:'b',x:0,y:0,z:5,lw,assumed:false}]}),80,0,'typical_day');
          return {one:one.dBA, two:two.dBA}""")
        self.assertAlmostEqual(r['two'] - r['one'], 10 * math.log10(2), places=2)


@unittest.skipUnless(shutil.which('node'), 'node missing')
class NoiseScreen(unittest.TestCase):
    def test_label_scenarios_and_assumed_defaults(self):
        r = js("""const g=nzLibrarySpectrum('genset_enclosed');
          const s=nzScreen({units:'m',
            sources:[nzEquipment('genset_enclosed',{id:'g',x:0,y:0,z:2})],
            receptors:[{id:'r1',name:'House',kind:'residence',x:100,y:0}],
            grid:{xmin:-45,ymin:-45,xmax:45,ymax:45,spacing_m:15,height_m:1.5},
            limits:{day:{dBA:70,dBC:80,tag:'[Z]'},night:{dBA:55,dBC:65,tag:'[Z]'}}});
          const row=s.receptors[0];
          return {label:s.label, keys:Object.keys(s.scenarios), tag:s.equipment[0].tag, cite:s.equipment[0].cite,
            dist:row.distance_m, amb:row.ambientNote, epa:row.epaGuideline_dBA,
            day:row.levels.emergency_day, night:row.levels.emergency_night,
            typical:row.levels.typical_night, maint:row.levels.maintenance_day, maintN:row.levels.maintenance_night,
            contour:s.scenarios.emergency_night.contours.dBA.features[0].properties.label,
            note:s.limitsNote}""")
        self.assertEqual(r['label'], 'EDIFICE SCREENING MODEL — NOT A SOUND STUDY')
        self.assertEqual(r['contour'], r['label'])
        self.assertTrue(r['note'].startswith(r['label']))
        self.assertEqual(r['keys'], ['typical_day', 'typical_night', 'maintenance_day', 'maintenance_night', 'emergency_day', 'emergency_night'])
        self.assertEqual(r['tag'], 'ASSUMED')
        self.assertIn('ASSUMED', r['cite'])
        self.assertAlmostEqual(r['dist'], 100, delta=0.2)
        self.assertEqual(r['amb'], 'TBD (not measured)')
        self.assertEqual(r['epa'], 55)
        self.assertIsNone(r['typical']['dBA'])  # genset is off in typical
        self.assertGreater(r['day']['dBA'], 40)
        self.assertGreater(r['day']['dBC'], r['day']['dBA'])
        self.assertAlmostEqual(r['day']['margin_dBA'], 70 - r['day']['dBA'], places=1)
        self.assertAlmostEqual(r['night']['margin_dBA'], 55 - r['night']['dBA'], places=1)
        self.assertEqual(r['night']['limitTag'], '[Z]')
        self.assertIsNotNone(r['maint']['dBA'])
        self.assertIsNone(r['maintN']['dBA'])  # testing is daytime

    def test_user_spectrum_is_not_marked_assumed(self):
        r = js("""const s=nzScreen({units:'m', scenarios:['typical_day'], contourMetrics:[],
          sources:[{id:'s',x:0,y:0,z:2,lw:[90,90,90,90,90,90,90,90],assumed:false,duty:{typical:{day:1,night:1},maintenance:{day:1,night:1},emergency:{day:1,night:1}}}],
          receptors:[], grid:{xmin:0,ymin:0,xmax:30,ymax:30,spacing_m:15}});
          return s.equipment[0].tag""")
        self.assertEqual(r, 'INPUT')

    def test_measured_ambient_is_passed_through(self):
        r = js("""return nzScreen({units:'m', scenarios:['typical_day'], contourMetrics:[],
          sources:[nzEquipment('dry_cooler',{id:'c',x:0,y:0,z:3})],
          receptors:[{id:'r',name:'House',x:80,y:0}],
          ambient:{L90:42,L10:51,source:'attended survey'},
          grid:{xmin:0,ymin:0,xmax:15,ymax:15,spacing_m:15}}).receptors[0]""")
        self.assertEqual(r['ambient_L90'], 42)
        self.assertEqual(r['ambient_L10'], 51)
        self.assertEqual(r['ambientNote'], 'attended survey')

    def test_consultant_csv_and_geojson(self):
        r = js(r"""const csv=['x,y,dBA'];
          for(let j=0;j<4;j++)for(let i=0;i<4;i++)csv.push([i*15,j*15,40+i*10].join(','));
          const a=nzImportGrid(csv.join('\n'),{firm:'Test Acoustics'});
          const gj=nzImportGrid(JSON.stringify({type:'FeatureCollection',features:[
            {type:'Feature',properties:{dBA:61,dBC:68,scenario:'measured'},geometry:{type:'Point',coordinates:[1,2]}},
            {type:'Feature',properties:{dBA:47},geometry:{type:'Point',coordinates:[4,2]}}]}),{firm:'Other'});
          let bad=null; try{nzImportGrid('x,y\n1,2')}catch(e){bad=e.message}
          return {label:a.label, n:a.contours.features.length, firm:a.firm, pts:gj.points.length, gj:gj.label, sc:gj.scenario, bad, lattice:a.lattice}""")
        self.assertEqual(r['label'], 'MODEL BY Test Acoustics')
        self.assertTrue(r['lattice'])
        self.assertGreater(r['n'], 0)
        self.assertEqual(r['pts'], 2)
        self.assertEqual(r['gj'], 'MODEL BY Other')
        self.assertIn('dBA', r['bad'])

    def test_footprints_within_one_mile(self):
        r = js("""return nzReceptorsFromFootprints([
          {id:'near',name:'School',kind:'school',ring:[[90,0],[110,0],[110,20],[90,20]]},
          {id:'far',name:'Far house',kind:'residence',ring:[[3000,0],[3010,0],[3010,10],[3000,10]]}
        ], [0,0], {units:'m'}).map(p=>[p.id,p.kind])""")
        self.assertEqual(r, [['near', 'school']])

    def test_worker_matches_sync(self):
        r = js(r"""
          const input={units:'m', scenarios:['emergency_day'], contourMetrics:['dBA'],
            sources:[nzEquipment('transformer',{id:'t',x:0,y:0,z:3})],
            receptors:[{id:'r1',name:'House',x:60,y:20}],
            grid:{xmin:-30,ymin:-30,xmax:30,ymax:30,spacing_m:15}};
          const sync=nzScreen(input);
          const {Worker}=require('worker_threads');
          const src='const {parentPort}=require("worker_threads");function postMessage(m){parentPort.postMessage(m);}parentPort.on("message",(data)=>{onmessage({data});});\n'+nzWorkerSource();
          const out=await new Promise((res,rej)=>{const w=new Worker(src,{eval:true});
            w.on('message',m=>{w.terminate();m.type==='error'?rej(new Error(m.message)):res(m.output)});
            w.on('error',rej); w.postMessage({type:'screen',id:'t',input})});
          return {a:sync.receptors[0].levels.emergency_day.dBA, b:out.receptors[0].levels.emergency_day.dBA, label:out.label};
        """, promise=True)
        self.assertEqual(r['label'], 'EDIFICE SCREENING MODEL — NOT A SOUND STUDY')
        self.assertAlmostEqual(r['a'], r['b'], places=1)

    def test_plane_contour_is_a_straight_line(self):
        # value = column index. The 2.5 contour sits halfway between columns 2 and 3.
        r = js("""const nx=6,ny=4,v=[];for(let j=0;j<ny;j++)for(let i=0;i<nx;i++)v.push(i);
          const g=isoLines(v,nx,ny,0,0,10,10,[2.5]);
          const xs=g[0].lines.flat().map(p=>p[0]);
          return {n:g[0].lines.length, min:Math.min(...xs), max:Math.max(...xs)}""")
        self.assertEqual(r['n'], 1)
        self.assertAlmostEqual(r['min'], 25, places=6)
        self.assertAlmostEqual(r['max'], 25, places=6)

    def test_from_plan_marks_every_default(self):
        files = ('civil.js', 'testfit.js') + FILES + ('photometric.js',)
        r = js("""const sq=a=>{const h=Math.sqrt(a*43560)/2;return [[-h,-h],[h,-h],[h,h],[-h,h],[-h,-h]]};
          const layout=tfDC(sq(80), Object.assign({}, TF_DEF.land, {halls:2, sw:'off', park:0}), {gridMW:40});
          layout.pond=[0,0,80,60];
          const nz=nzFromPlan(layout);
          const ph=phFromPlan(layout,{limitFc:2,limitTag:'[Z]'});
          const gens=nz.sources.filter(s=>s.kind==='genset_enclosed');
          return {assumed:nz.sources.every(s=>s.tag==='ASSUMED'&&s.assumed),
            kinds:[...new Set(nz.sources.map(s=>s.kind))].sort(),
            barriers:nz.barriers.map(b=>b.kind),
            maint:gens.map(s=>s.duty.maintenance.day),
            areas:ph.areas.map(a=>a.name),
            poles:ph.fixtures.length, poleAssumed:ph.fixtures.every(f=>f.assumed),
            sensitive:nz.sources.filter(s=>s.kind==='genset_enclosed').every(s=>s.sensitive)}""", files)
        self.assertTrue(r['assumed'])
        self.assertEqual(r['kinds'], ['dry_cooler', 'facade', 'genset_enclosed', 'transformer'])
        self.assertIn('building', r['barriers'])
        self.assertEqual(sum(r['maint']), 1)  # one unit on test, the rest off
        self.assertTrue(any(a.startswith('Generator yard') for a in r['areas']))
        self.assertIn('Substation', r['areas'])
        self.assertIn('Lagoon', r['areas'])
        self.assertGreater(r['poles'], 0)
        self.assertTrue(r['poleAssumed'])
        self.assertTrue(r['sensitive'])

    def test_render_inlines_the_engines_after_the_sheet(self):
        sys.path.insert(0, str(ROOT / 'pipeline'))
        import render
        html = render._testfit('/*__TESTFIT__*/')
        self.assertEqual(html.count('function tfSheet('), 1)
        self.assertIn('function nzScreen', html)
        self.assertIn('function phParseIES', html)
        self.assertIn('EDIFICE SCREENING MODEL — NOT A SOUND STUDY', html)
        self.assertLess(html.index('function tfSheet'), html.index('function nzScreen'))
        self.assertEqual(render.SCREENING_JS, ('isolines.js', 'noise.js', 'photometric.js', 'screening_preview.js'))


if __name__ == '__main__':
    unittest.main()
