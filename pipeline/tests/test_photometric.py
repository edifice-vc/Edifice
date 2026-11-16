"""IES LM-63 parser and direct-component illuminance. Synthetic photometry only.

The Compass exhibit's LP1 file (15,357 lm, 120.7 W, 245 poles) is not in this repo.
These tests lock the arithmetic for a public-domain cosine-squared distribution.
"""
import json, math, pathlib, shutil, subprocess, unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
FILES = ('isolines.js', 'photometric.js')
FC = ROOT / 'pipeline' / 'fixtures' / 'ies' / 'synthetic-full-cutoff.ies'
FWD = ROOT / 'pipeline' / 'fixtures' / 'ies' / 'synthetic-forward.ies'

def js(body, files=FILES, promise=False):
    src = '\n'.join((ROOT / 'pipeline' / n).read_text() for n in files)
    if promise:
        src += '\n(async()=>{try{const v=await (async()=>{' + body + '\n})();console.log(JSON.stringify(v))}catch(e){console.error(e&&e.stack||e);process.exit(1)}})()'
    else:
        src += '\nconsole.log(JSON.stringify((()=>{' + body + '\n})()))'
    r = subprocess.run(['node'], input=src, capture_output=True, text=True)
    if r.returncode:
        raise AssertionError(r.stderr[-2000:])
    return json.loads(r.stdout)


@unittest.skipUnless(shutil.which('node'), 'node missing')
class Photometric(unittest.TestCase):
    def test_synthetic_files_match_the_generator(self):
        r = js('return {fc:phSyntheticFullCutoffIES(), fwd:phSyntheticForwardIES()}')
        self.assertEqual(FC.read_text(), r['fc'])
        self.assertEqual(FWD.read_text(), r['fwd'])
        self.assertIn('SYNTHETIC', r['fc'])
        self.assertNotIn('Compass', r['fc'].split('Not a')[0])

    def test_parser_and_symmetry(self):
        r = js("""const ies=phParseIES(phSyntheticFullCutoffIES());
          const fwd=phParseIES(phSyntheticForwardIES());
          return {type:ies.photometricType, lamps:ies.lamps, lm:ies.lumensRated, W:ies.inputWatts,
            nV:ies.nV, nH:ies.nH, i0:phCandela(ies,0,30), i45:phCandela(ies,45,200), i90:phCandela(ies,90,10),
            f0:phCandela(fwd,45,0), f90:phCandela(fwd,45,90), f180:phCandela(fwd,45,180), f270:phCandela(fwd,45,270),
            integ:phIntegratedLumens(ies)}""")
        self.assertEqual(r['type'], 'C')
        self.assertEqual([r['lamps'], r['lm'], r['W'], r['nV'], r['nH']], [1, 20944, 150, 19, 1])
        self.assertAlmostEqual(r['i0'], 10000, places=4)
        self.assertAlmostEqual(r['i45'], 5000, places=4)
        self.assertAlmostEqual(r['i90'], 0, places=6)
        self.assertEqual([r['f0'], r['f90'], r['f180'], r['f270']], [6000, 1000, 6000, 1000])
        # Closed form of I = 10000 cos²θ over the lower hemisphere is 2π·10000/3.
        self.assertAlmostEqual(r['integ'], 2 * math.pi * 10000 / 3, delta=250)

    def test_nadir_and_45_degrees_match_the_hand_formula(self):
        # E = I · h / d³ · LLF. At nadir d = h = 30 ft, I = 10000, LLF = 0.85.
        # At r = h, θ = 45°, the file's candela is exactly 5000.
        h, llf = 30, 0.85
        d = math.hypot(h, h)
        expect_nadir = 10000 * h / (h ** 3) * llf
        expect_45 = 5000 * h / (d ** 3) * llf
        r = js("""const f=phDefaultFixture({x:0,y:0,z:30,llf:0.85});
          const straight=phIlluminance(f,0,0,0), angled=phIlluminance(f,30,0,0);
          const full=phIlluminance(phDefaultFixture({x:0,y:0,z:30,llf:1}),0,0,0);
          return {straight, angled, full}""")
        self.assertAlmostEqual(r['straight'], expect_nadir, places=4)
        self.assertAlmostEqual(r['angled'], expect_45, places=4)
        self.assertAlmostEqual(r['full'] * 0.85, r['straight'], places=6)

    def test_tilt_aims_the_nadir(self):
        # A 45° tilt toward north. The point on the optical axis must see I(0), θ = 0.
        r = js("""const f=phDefaultFixture({x:0,y:0,z:30,tilt:45,orientation:0,llf:1});
          const s=Math.sin(Math.PI/4), D=30, y=D*s, z=30-D*s;
          const dir=phDirection(f,0,y,z);
          return {theta:dir.theta, E:phIlluminance(f,0,y,z)}""")
        h = 30 * math.sin(math.pi / 4)
        self.assertAlmostEqual(r['theta'], 0, places=6)
        self.assertAlmostEqual(r['E'], 10000 * h / (30 ** 3), places=4)

    def test_feet_and_metres_are_the_same_light(self):
        r = js("""const ft=phIlluminance(phDefaultFixture({x:0,y:0,z:30,llf:0.85}),0,0,0);
          const m=phIlluminance(phDefaultFixture({x:0,y:0,z:30*0.3048,llf:0.85}),0,0,0);
          return {ft, m}""")
        self.assertAlmostEqual(r['m'] * 0.09290304, r['ft'], places=3)

    def test_summary_ratios_and_property_line(self):
        # The square's near side is 30 ft from the pole, so θ = 45° and the hand value is the 45° case.
        h, llf = 30.0, 0.85
        d = math.hypot(h, h)
        expect = 5000 * h / (d ** 3) * llf
        r = js("""const f=phDefaultFixture({id:'a',x:0,y:0,z:30,llf:0.85});
          const calc=phCalc({units:'ft', fixtures:[f],
            grid:{xmin:-20,ymin:-20,xmax:20,ymax:20,spacing:10},
            areas:[{id:'yard',name:'Generator yard',polygon:[[-15,-15],[15,-15],[15,15],[-15,15]]}],
            propertyLine:{ring:[[-30,-30],[30,-30],[30,30],[-30,30]], limitFc:2, limitTag:'[Z]', spacing:10},
            isolines:[1,5]});
          const open=phCalc({units:'ft', fixtures:[f], grid:{xmin:-10,ymin:-10,xmax:10,ymax:10,spacing:10},
            propertyLine:{ring:[[-30,-30],[30,-30],[30,30],[-30,30]], spacing:10}});
          const fail=phCalc({units:'ft', fixtures:[f], grid:{xmin:-10,ymin:-10,xmax:10,ymax:10,spacing:10},
            propertyLine:{ring:[[-30,-30],[30,-30],[30,30],[-30,30]], limitFc:1, limitTag:'[Z]', spacing:10}});
          const g=calc.summary[0], y=calc.summary[1];
          return {max:g.max, min:g.min, avg:g.avg, maxMin:g.maxMin, avgMin:g.avgMin,
            yard:y.area, yardN:y.n, maxFc:calc.propertyLine.maxFc, pass:calc.propertyLine.pass, tag:calc.propertyLine.limitTag,
            open:open.propertyLine.pass, openNote:open.propertyLine.limitNote, fail:fail.propertyLine.pass,
            sched:calc.schedule[0], lines:calc.isolines.features.length, label:calc.label,
            lineLabel:calc.isolines.features[0].properties.label}""")
        self.assertAlmostEqual(r['max'], 10000 * 0.85 / (30 * 30), places=3)
        self.assertLess(r['min'], r['avg'])
        self.assertLess(r['avg'], r['max'])
        self.assertAlmostEqual(r['maxMin'], r['max'] / r['min'], places=2)
        self.assertAlmostEqual(r['avgMin'], r['avg'] / r['min'], places=2)
        self.assertEqual(r['yard'], 'Generator yard')
        self.assertGreater(r['yardN'], 0)
        self.assertAlmostEqual(r['maxFc'], expect, places=3)
        self.assertTrue(r['pass'])
        self.assertEqual(r['tag'], '[Z]')
        self.assertIsNone(r['open'])
        self.assertIn('TBD', r['openNote'])
        self.assertFalse(r['fail'])
        self.assertEqual(r['sched']['tag'], 'ASSUMED')
        self.assertEqual(r['sched']['llf'], 0.85)
        self.assertEqual(r['sched']['qty'], 1)
        self.assertGreater(r['lines'], 0)
        self.assertEqual(r['label'], 'EDIFICE SCREENING MODEL — NOT A LIGHTING STUDY')
        self.assertEqual(r['lineLabel'], r['label'])

    def test_truncated_file_and_type_b_are_rejected(self):
        r = js("""let trunc='', typeb='';
          try{phParseIES('IESNA:LM-63-2002\\nTILT=NONE\\n1 1 1\\n')}catch(e){trunc=e.message}
          const text=phSyntheticFullCutoffIES().replace('1 20944 1.0 19 1 1 1','1 20944 1.0 19 1 2 1');
          try{phIlluminance(phDefaultFixture({ies:text,assumed:false}),0,0,0)}catch(e){typeb=e.message}
          return {trunc, typeb}""")
        self.assertIn('truncated', r['trunc'])
        self.assertIn('Type C', r['typeb'])

    def test_tilt_include_factor(self):
        r = js(r"""const text=['IESNA:LM-63-2002','[TEST] SYNTHETIC tilt','TILT=INCLUDE','1','2','0 90','1.0 0.5',
          '1 1000 1 2 1 1 1 0 0 0','1 1 10','0 90','0','100 0'].join('\n');
          const ies=phParseIES(text);
          return [phTiltFactor(ies,0), phTiltFactor(ies,45), phTiltFactor(ies,90)]""")
        self.assertEqual(r, [1, 0.75, 0.5])

    def test_auto_poles_use_four_times_mounting_height(self):
        r = js("""const poles=phAutoPoles([[[0,0],[400,0]]],{mountingHeight:30});
          const xs=poles.map(p=>Math.round(p.x));
          return {n:poles.length, xs, h:poles[0].mountingHeight, llf:poles[0].llf, tag:poles[0].tag, spacing:poles[0].spacingAssumed, facing:poles[0].orientation}""")
        self.assertEqual(r['xs'], [60, 180, 300])
        self.assertEqual(r['h'], 30)
        self.assertEqual(r['llf'], 0.85)
        self.assertEqual(r['tag'], 'ASSUMED')
        self.assertTrue(r['spacing'])
        self.assertAlmostEqual(r['facing'], 90, places=5)

    def test_worker_matches_sync(self):
        r = js(r"""
          const input={units:'ft', fixtures:[phDefaultFixture({x:0,y:0,z:30,llf:0.85})],
            grid:{xmin:-10,ymin:-10,xmax:10,ymax:10,spacing:10}, isolines:[5]};
          const sync=phCalc(input);
          const {Worker}=require('worker_threads');
          const src='const {parentPort}=require("worker_threads");function postMessage(m){parentPort.postMessage(m);}parentPort.on("message",(data)=>{onmessage({data});});\n'+phWorkerSource();
          const out=await new Promise((res,rej)=>{const w=new Worker(src,{eval:true});
            w.on('message',m=>{w.terminate();m.type==='error'?rej(new Error(m.message)):res(m.output)});
            w.on('error',rej); w.postMessage({type:'calc',id:'t',input})});
          return {a:sync.summary[0].max, b:out.summary[0].max, label:out.label};
        """, promise=True)
        self.assertEqual(r['label'], 'EDIFICE SCREENING MODEL — NOT A LIGHTING STUDY')
        self.assertAlmostEqual(r['a'], r['b'], places=3)

    def test_preview_hook_does_not_throw(self):
        body = r"""
          global.document={getElementById:()=>null};
          global.isAdm=()=>false;
          let n=0; global.tfDraw=function(){n++};
        """
        src = (ROOT / 'pipeline' / 'screening_preview.js').read_text()
        src = body + src + '\nglobal.tfDraw({C:{}});console.log(JSON.stringify({n,wrapped:!!global.tfDraw.__edificeScreen}))'
        r = subprocess.run(['node', '-e', src], capture_output=True, text=True)
        if r.returncode:
            self.fail(r.stderr[-2000:])
        out = json.loads(r.stdout)
        self.assertEqual(out['n'], 1)
        self.assertTrue(out['wrapped'])


if __name__ == '__main__':
    unittest.main()
