"""Point-by-point photometry. The reference is the inverse-square law, recomputed here."""
import json, math, pathlib, shutil, subprocess, unittest
ROOT = pathlib.Path(__file__).resolve().parents[2]
JS = '\n'.join((ROOT / 'pipeline' / f).read_text() for f in ('screening.js', 'photometric.js'))
LUX_PER_FC = 10.7639104167
ISO = """IESNA:LM-63-2002
[TEST] ISOTROPIC REFERENCE
[MANUFAC] EDIFICE SYNTHETIC
TILT=NONE
1 1000 1 2 1 1 2 0 0 0
1 1 100
0 90
0
10000 10000
"""


def lux(I, h, x, llf=1):
    d = math.hypot(x, h)
    return I * (h / d) / d ** 2 * llf


@unittest.skipUnless(shutil.which('node'), 'node missing')
class Photometric(unittest.TestCase):
    def js(self, body):
        src = JS + '\nconst ISO=' + json.dumps(ISO) + ';\nconsole.log(JSON.stringify((()=>{' + body + '})()))'
        p = subprocess.run(['node'], input=src, capture_output=True, text=True)
        if p.returncode != 0:
            self.fail(p.stderr[-2000:])
        return json.loads(p.stdout)

    def test_inverse_square_reference(self):
        # 10 000 cd, 10 m below the fixture, LLF = 1 → 100 lx. At 45° the cos³ form gives 35.355 lx.
        r = self.js("""const f={x:0,y:0,h:10,ies:ISO,llf:1,llfSrc:'caller',assumed:false,source:'reference IES'};
const a=phPoint(f,0,0,0,{units:'m'});
const b=phPoint(f,10,0,0,{units:'m'});
const c=phPoint(Object.assign({},f,{llf:0.85,llfSrc:'caller'}),0,0,0,{units:'m'});
const feet=phPoint(Object.assign({},f,{h:10/0.3048}),0,0,0,{units:'ft'});
return {nadir:a.lux.v,fc:a.fc.v,side:b.lux.v,llf:c.lux.v,feet:feet.lux.v,theta:b.theta.v,audit:sgAudit(a)}""")
        self.assertAlmostEqual(r['nadir'], 100, places=6)
        self.assertAlmostEqual(r['nadir'], lux(10000, 10, 0), places=6)
        self.assertAlmostEqual(r['side'], lux(10000, 10, 10), places=4)
        self.assertAlmostEqual(r['side'], 10000 * (math.sqrt(2) / 2) ** 3 / 100, places=4)
        self.assertAlmostEqual(r['llf'], 85, places=4)
        self.assertAlmostEqual(r['feet'], 100, places=3)
        self.assertAlmostEqual(r['fc'], 100 / LUX_PER_FC, places=5)
        self.assertAlmostEqual(r['theta'], 45, places=3)
        self.assertEqual(r['audit'], [])

    def test_parser_multiplier_lamps_tilt_and_symmetry(self):
        r = self.js("""const base=phParseIes(ISO);
const two=ISO.replace('1 1000 1','2 1000 1');
const mult=ISO.replace('1 1000 1','1 1000 2');
const f=(t,ies)=>({x:0,y:0,h:10,ies:ies||ISO,llf:1,llfSrc:'caller',assumed:false});
const nadir=ies=>phPoint(f(0,ies),0,0,0,{units:'m'}).lux.v;
const quad=['IESNA:LM-63-2002','TILT=NONE','1 1000 1 2 2 1 2 0 0 0','1 1 10','0 90','0 90','1000 0','0 0'].join('\\n');
const q=phParseIes(quad);
const inc=['IESNA:LM-63-2002','TILT=INCLUDE','1','1','0','0.5',
 '1 1000 1 2 1 1 2 0 0 0','1 1 10','0 90','0','10000 10000'].join('\\n');
let threw=false;try{phParseIes(ISO.replace('2 1 1 2','2 1 2 2'))}catch(e){threw=/type 2/i.test(e.message)}
return {lamps:nadir(two)/nadir(ISO),mult:nadir(mult)/nadir(ISO),
 front:phCandela(q,0,0),side:phCandela(q,0,90),back:phCandela(q,0,180),
 tilt:phPoint({x:0,y:0,h:10,ies:inc,llf:1,llfSrc:'caller',tilt:0},0,0,0,{units:'m'}).lux.v,
 typeB:threw,bf:base.ballastFactor}""")
        self.assertAlmostEqual(r['lamps'], 2, places=6)
        self.assertAlmostEqual(r['mult'], 2, places=6)
        self.assertAlmostEqual(r['front'], 1000, places=6)
        self.assertAlmostEqual(r['side'], 0, places=6)
        self.assertAlmostEqual(r['back'], 1000, places=6)  # quadrant symmetry
        self.assertAlmostEqual(r['tilt'], 50, places=3)    # TILT factor 0.5 at 0°
        self.assertTrue(r['typeB'])
        self.assertEqual(r['bf'], 1)

    def test_grid_summary_property_line_and_label(self):
        # Property-line maximum for one isotropic fixture at the centre of a 100 m square is the mid-side point.
        h, half = 10, 50
        expect = lux(10000, h, half) / LUX_PER_FC
        r = self.js("""const f={id:'LP1',label:'LP1',symbol:'LP1',x:0,y:0,h:10,ies:ISO,llf:1,llfSrc:'caller',assumed:true,arrangement:'single'};
const bounds={x0:-20,y0:-20,x1:20,y1:20};
const ring=[[-50,-50],[50,-50],[50,50],[-50,50],[-50,-50]];
const areas=[{id:'yard',ring:[[-20,-20],[20,-20],[20,20],[-20,20],[-20,-20]]},{id:'gatehouse',ring:[[-5,-5],[5,-5],[5,5],[-5,5]]},
 {id:'substation',ring:[[8,-8],[18,-8],[18,8],[8,8]]},{id:'lagoon',ring:[[-18,-8],[-8,-8],[-8,8],[-18,8]]}];
const out=phRun({units:'m',fixtures:[f],bounds:bounds,step:10,stepSrc:'caller',areas:areas,boundary:ring,
 limit:{v:2,src:'test limit',u:'fc'}});
const iso=phIsolines(out.grid,[1]);
let rad=null;if(iso.levels.length){const s=iso.levels[0].segs[0][0];rad=Math.hypot(s[0],s[1])}
return {label:out.label,ill:out.illustrative,max:out.propertyLine.max,pass:out.propertyLine.pass,
 ids:out.summary.map(a=>a.id),avg:out.summary[0].stats.avg.v,n:out.summary[0].stats.n.v,
 sched:out.schedule[0],audit:sgAudit(out),rad:rad,supplied:phRun({units:'m',fixtures:[Object.assign({},f,{assumed:false})],bounds:bounds}).label}""")
        self.assertEqual(r['label'], 'ILLUSTRATIVE — fixture selection assumed until a lighting designer picks fixtures')
        self.assertTrue(r['ill'])
        self.assertAlmostEqual(r['max']['v'], expect, places=3)
        self.assertEqual(r['max']['src'], 'computed')
        self.assertTrue(r['pass'])  # ~0.07 fc against a 2 fc test limit
        self.assertEqual(r['ids'], ['yard', 'gatehouse', 'substation', 'lagoon'])
        self.assertGreater(r['n'], 0)
        self.assertGreater(r['avg'], 0)
        self.assertEqual(r['sched']['qty']['v'], 1)
        self.assertEqual(r['sched']['llf']['src'], 'caller')
        self.assertEqual(r['sched']['lumens']['src'], 'assumed')
        self.assertEqual(r['audit'], [])
        self.assertIn('fixtures as supplied', r['supplied'])
        # 1 fc isoline of this fixture sits near 18.5 m (cos³θ / h²).
        self.assertIsNotNone(r['rad'])
        self.assertAlmostEqual(r['rad'], 18.5, delta=6)

    def test_generic_ies_flux_and_auto_poles(self):
        r = self.js("""const ies=phParseIes(phGenericIes());
const poles=phAutoPoles({lines:[[[0,0],[200,0]]],mount:25,units:'ft',ies:phGenericIes()});
return {flux:phFlux(ies),watts:ies.watts,tilt:ies.tilt,n:poles.count,spacing:poles.spacing,xy:poles.poles.map(p=>[p.x,p.y]),mount:poles.mount}""")
        self.assertAlmostEqual(r['flux'], 15000, delta=450)
        self.assertEqual(r['watts'], 120)
        self.assertEqual(r['tilt'], 'NONE')
        self.assertEqual(r['spacing']['v'], 100)
        self.assertEqual(r['spacing']['src'], 'assumed')
        self.assertEqual(r['mount']['src'], 'assumed')
        self.assertEqual(r['xy'], [[50, 0], [150, 0]])

    def test_worker(self):
        worker = r'''
const {Worker}=require('worker_threads');
const path=require('path');
const w=new Worker(path.join(%r,'pipeline','photometric_worker.js'));
const ies=%s;
w.on('message',m=>{console.log(JSON.stringify({type:m.type,lux:m.result&&m.result.grid.values[0],label:m.result&&m.result.label}));w.terminate()});
w.on('error',e=>{console.error(e);process.exit(1)});
w.postMessage({type:'run',job:{units:'m',fixtures:[{x:0,y:0,h:10,ies:ies,llf:1,llfSrc:'caller',assumed:true}],bounds:{x0:0,y0:0,x1:0,y1:0},step:1}});
''' % (str(ROOT), json.dumps(ISO))
        p = subprocess.run(['node', '-e', worker], capture_output=True, text=True, timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr[-1500:])
        msg = json.loads(p.stdout)
        self.assertEqual(msg['type'], 'result')
        self.assertAlmostEqual(msg['lux'], 100 / LUX_PER_FC, places=3)
        self.assertIn('ILLUSTRATIVE', msg['label'])


if __name__ == '__main__':
    unittest.main()
