"""Line of sight: ray-cast percent visible, section, key map, 3DEP fetch, headless raster, three.js scene."""
import json, math, pathlib, shutil, struct, subprocess, unittest
ROOT = pathlib.Path(__file__).resolve().parents[2]
JS = '\n'.join((ROOT / 'pipeline' / f).read_text() for f in ('screening.js', 'los.js', 'dem3dep.js'))


def wall_blocks(eye, target, a, b, z0, z1):
    dx, dy, dz = target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]
    wx, wy = b[0] - a[0], b[1] - a[1]
    den = dx * wy - dy * wx
    if abs(den) < 1e-9:
        return False
    t = ((a[0] - eye[0]) * wy - (a[1] - eye[1]) * wx) / den
    u = ((a[0] - eye[0]) * dy - (a[1] - eye[1]) * dx) / den
    if t <= 1e-4 or t >= 1 - 1e-4 or u < -1e-8 or u > 1 + 1e-8:
        return False
    z = eye[2] + t * dz
    return z0 - 1e-6 <= z <= z1 + 1e-6


def tiff_f32(values, w, h, tie, scale):
    """Uncompressed little-endian float32 TIFF with ModelPixelScale and ModelTiepoint."""
    data = struct.pack('<' + 'f' * len(values), *values)
    # IFD entries, tags in ascending order. Payloads for the two DOUBLE tags follow the IFD.
    # Layout: header (8) | IFD | double payloads | strip
    tags = [
        (256, 4, 1, w, None),
        (257, 4, 1, h, None),
        (258, 3, 1, 32, None),
        (259, 3, 1, 1, None),
        (262, 3, 1, 1, None),
        (273, 4, 1, None, None),  # strip offset, filled once the layout is known
        (277, 3, 1, 1, None),
        (278, 4, 1, h, None),
        (279, 4, 1, len(data), None),
        (339, 3, 1, 3, None),
        (33550, 12, 3, None, struct.pack('<3d', *scale)),
        (33922, 12, 6, None, struct.pack('<6d', *tie)),
    ]
    n = len(tags)
    ifd = 8
    payload_at = ifd + 2 + n * 12 + 4
    extra = b''
    entries = []
    cursor = payload_at
    strip_at = None
    for tag, typ, count, inline, payload in tags:
        if tag == 273:
            entries.append((tag, typ, count, 'STRIP'))
        elif payload is None:
            entries.append((tag, typ, count, inline))
        else:
            entries.append((tag, typ, count, cursor))
            extra += payload
            cursor += len(payload)
    strip_at = cursor
    out = bytearray(b'II' + struct.pack('<HI', 42, ifd))
    out += struct.pack('<H', n)
    for tag, typ, count, val in entries:
        v = strip_at if val == 'STRIP' else val
        # SHORT values occupy the low bytes of the 4-byte slot
        if typ == 3:
            raw = struct.pack('<H', v) + b'\x00\x00'
        else:
            raw = struct.pack('<I', v)
        out += struct.pack('<HHI', tag, typ, count) + raw
    out += struct.pack('<I', 0)
    out += extra
    assert len(out) == strip_at
    out += data
    return bytes(out)


@unittest.skipUnless(shutil.which('node'), 'node missing')
class LineOfSight(unittest.TestCase):
    def js(self, body):
        src = JS + '\nconsole.log(JSON.stringify((()=>{' + body + '})()))'
        p = subprocess.run(['node'], input=src, capture_output=True, text=True)
        if p.returncode != 0:
            self.fail(p.stderr[-2000:])
        return json.loads(p.stdout)

    def test_roofline_raycast_against_an_independent_wall(self):
        eye = (0, 0, 105)
        ys = [-100, -80, -40, 0, 40, 80, 100]
        targets = [(300, y, 140) for y in ys]
        wall = ((150, -30), (150, 30), 100, 130)
        blocked = [wall_blocks(eye, t, wall[0], wall[1], wall[2], wall[3]) for t in targets]
        expect = 100 * (len(blocked) - sum(blocked)) / len(blocked)
        self.assertEqual(sum(blocked), 3)  # |y| = 40 and 0 only; the rest miss the wall
        r = self.js("""const targets=%s.map(y=>({x:300,y:y,z:140}));
const v=losVisibility({eye:{x:0,y:0,z:105},targets:targets,obstacles:[{kind:'wall',a:[150,-30],b:[150,30],z0:100,z1:130}]});
return {pct:v.visiblePct,blocked:v.blocked.v,audit:sgAudit(v),detail:v.detail}""" % json.dumps(ys))
        self.assertEqual(r['blocked'], sum(blocked))
        self.assertAlmostEqual(r['pct']['v'], expect, places=6)
        self.assertEqual(r['pct']['src'], 'computed')
        self.assertEqual(r['audit'], [])

    def test_tree_growth_changes_the_visible_fraction(self):
        # A mature cone on the axis blocks the centre ray. The year-1 cone is below the ray.
        r = self.js("""const targets=[-100,-50,0,50,100].map(y=>({x:300,y:y,z:140}));
const eye={x:0,y:0,z:105};
const spec={eye:eye,targets:targets,ground:100,units:'ft',includeTrees:true,
 trees:[{species:'evergreen',x:150,y:0}],
 year1:0, yearMature:18};
// year 0 is the install size; force the crown by passing cones directly as well as via growth
const y0=losYearVisibility(Object.assign({},spec,{year1:0}),0);
const yM=losYearVisibility(spec,18);
const g0=losGrow('evergreen',0,'ft'), g9=losGrow('evergreen',9,'ft'), g18=losGrow('evergreen',18,'ft');
return {y0:y0.visiblePct.v,yM:yM.visiblePct.v,h0:g0.height,h9:g9.height.v,h18:g18.height.v,src:g18.height.src}""")
        self.assertAlmostEqual(r['h0']['v'], 6, places=5)
        self.assertAlmostEqual(r['h9'], 18, places=5)
        self.assertAlmostEqual(r['h18'], 30, places=5)
        self.assertEqual(r['src'], 'assumed')
        self.assertEqual(r['y0'], 100)
        self.assertLess(r['yM'], r['y0'])

    def test_section_clearance_and_key_map(self):
        r = self.js("""const eye={x:0,y:0,z:105}, roof={x:300,y:0,z:140};
const berm=line=>([{line:[[150,-100],[150,100]],crest:line,slope:3}]);
const hi=losSection({eye:eye,roof:roof,ground:100,units:'ft',berms:berm(30),eyeSrc:'AASHTO driver eye height, 3.5 ft'});
const lo=losSection({eye:eye,roof:roof,ground:100,units:'ft',berms:berm(10)});
const km=losKeyMap({boundary:[[0,0],[100,0],[100,100],[0,100],[0,0]],viewpoints:[{id:'V1',name:'South',x:50,y:0,bearing:0}]});
const eyeH=losEyeHeight('driver','ft'), ped=losEyeHeight('pedestrian','ft');
const cam=losCamera({eye:eye,target:roof,focal_mm:50,aspect:16/9,units:'ft'});
const cam24=losCamera({eye:eye,target:roof,focal_mm:24,aspect:16/9,units:'ft'});
const run=losRun({eye:eye,roof:roof,ground:100,units:'ft',eyeKind:'driver',boundary:[[0,0],[400,0],[400,80],[0,80]],
 building:{ring:[[280,-20],[320,-20],[320,20],[280,20]],roofZ:140,h:40},trees:[{species:'evergreen',x:150,y:0}]});
return {hi:hi.status,clear:hi.clearance.v,lo:lo.status,loc:lo.clearance.v,ve:hi.exaggeration,
 nx:km.viewpoints[0].nx.v,ny:km.viewpoints[0].ny.v,ax:km.viewpoints[0].arrow.x.v,ay:km.viewpoints[0].arrow.y.v,
 inset:km.inset,eye:eyeH,ped:ped.src,hfov:cam.hfov.v,hfov24:cam24.hfov.v,
 audit:sgAudit(run),label:run.label,y1:run.visibility.year1.visiblePct.v,yM:run.visibility.mature.visiblePct.v}""")
        self.assertEqual(r['hi'], 'BLOCKED')
        self.assertAlmostEqual(r['clear'], 122.5 - 130, places=4)
        self.assertEqual(r['lo'], 'VISIBLE')
        self.assertAlmostEqual(r['loc'], 122.5 - 110, places=4)
        self.assertEqual(r['ve']['v'], 5)
        self.assertEqual(r['ve']['src'], 'assumed')
        self.assertAlmostEqual(r['nx'], 0.5, places=6)
        self.assertAlmostEqual(r['ny'], 0, places=6)
        self.assertAlmostEqual(r['ax'], 0, places=6)
        self.assertAlmostEqual(r['ay'], 1, places=6)
        self.assertEqual(r['inset']['widthFrac']['v'], 0.21)
        self.assertEqual(r['inset']['heightFrac']['v'], 0.27)
        self.assertEqual(r['eye']['v'], 3.5)
        self.assertIn('AASHTO', r['eye']['src'])
        self.assertEqual(r['ped'], 'assumed')
        self.assertAlmostEqual(r['hfov'], 2 * math.degrees(math.atan(18 / 50)), places=4)
        self.assertAlmostEqual(r['hfov24'], 2 * math.degrees(math.atan(18 / 24)), places=4)
        self.assertGreater(r['hfov24'], 70)
        self.assertEqual(r['audit'], [])
        self.assertIn('NOT A SURVEY', r['label'])
        self.assertIn('assumed', r['label'])
        self.assertLess(r['yM'], r['y1'])

    def test_raster_and_three_scene(self):
        r = self.js(r"""const dem={x0:0,y0:0,dx:20,dy:20,nx:8,ny:8,z:Array(64).fill(0),src:'synthetic'};
const base={units:'ft',dem:dem,ground:0,boundary:[[0,0],[140,0],[140,140],[0,140],[0,0]],
 buildings:[{id:'HALL',x:60,y:70,w:30,d:20,h:40,hSrc:'caller'}],
 trees:[{species:'evergreen',x:50,y:30}],
 eye:{x:50,y:-5,z:8},target:{x:75,y:80,z:16},eyeSrc:'caller',
 viewpoints:[{id:'V1',x:50,y:0,bearing:0}]};
const ex=losProbe(Object.assign({mode:'existing',year:1},base),160,90);
const y1=losProbe(Object.assign({mode:'proposed',year:1},base),160,90);
const yM=losProbe(Object.assign({mode:'proposed',year:18},base),160,90);
const y1b=losProbe(Object.assign({mode:'proposed',year:1},base),160,90);
function Stub(){}
Stub.prototype.set=function(x,y,z){this.x=x;this.y=y;this.z=z;return this};
class Matrix4{constructor(){this.elements=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}makeScale(x,y,z){this.elements[0]=x;this.elements[5]=y;this.elements[10]=z;return this}}
class BufferGeometry{constructor(){this.attrs={}}setAttribute(n,a){this.attrs[n]=a}setIndex(i){this.index=i}}
class Mesh{constructor(g,m){this.geometry=g;this.material=m}}
class InstancedMesh extends Mesh{constructor(g,m,n){super(g,m);this.count=n;this.mats=[]}setMatrixAt(i,m){this.mats[i]=m.elements.slice()}}
class Scene{constructor(){this.children=[]}add(o){this.children.push(o)}}
class Cam{constructor(fov,aspect,near,far){this.fov=fov;this.aspect=aspect;this.near=near;this.far=far;this.position=new Stub();this.up=new Stub()}lookAt(){}}
const THREE={Scene,Mesh,InstancedMesh,BufferGeometry,PerspectiveCamera:Cam,Matrix4,
 Float32BufferAttribute:function(a){this.a=a},MeshLambertMaterial:function(p){this.color=p.color}};
const f1=losFrame(Object.assign({mode:'proposed',year:1},base));
const fE=losFrame(Object.assign({mode:'existing',year:1},base));
const fM=losFrame(Object.assign({mode:'proposed',year:18},base));
const t1=losToThree(f1,THREE), tE=losToThree(fE,THREE);
const names=o=>o.scene.children.map(c=>c.name);
const tree=t1.scene.children.find(c=>c.name==='trees');
const treeM=losToThree(fM,THREE).scene.children.find(c=>c.name==='trees');
const mass=losMassingFrame(Object.assign({},base,{figures:false}));
const dx=mass.camera.target.x.v-mass.camera.eye.x.v, dy=mass.camera.target.y.v-mass.camera.eye.y.v, dz=mass.camera.target.z.v-mass.camera.eye.z.v;
const ang=Math.atan2(-dz, Math.hypot(dx,dy))*180/Math.PI;
return {ex:ex.sum,y1:y1.sum,yM:yM.sum,y1b:y1b.sum,arrow:y1.arrow,inset:y1.inset,bar:y1.bar,
 names:names(t1),namesE:names(tE),up:t1.camera.up.z,fov:t1.camera.fov,vfov:f1.camera.vfov.v,
 sz1:tree.mats[0][10],szM:treeM.mats[0][10],ang:ang}""")
        self.assertEqual(r['y1'], r['y1b'])
        self.assertNotEqual(r['ex'], r['y1'])
        self.assertNotEqual(r['y1'], r['yM'])
        self.assertGreater(r['arrow'][0], 180)
        self.assertLess(r['arrow'][1], 80)
        self.assertGreater(min(r['inset']), 230)
        self.assertLess(max(r['bar']), 40)
        self.assertIn('HALL', r['names'])
        self.assertIn('trees', r['names'])
        self.assertIn('terrain', r['names'])
        self.assertNotIn('HALL', r['namesE'])
        self.assertNotIn('trees', r['namesE'])
        self.assertEqual(r['up'], 1)
        self.assertAlmostEqual(r['fov'], r['vfov'], places=4)
        self.assertGreater(r['szM'], r['sz1'])
        self.assertAlmostEqual(r['ang'], 45, delta=0.2)

    def test_three_dep_url_tiff_and_fetch(self):
        raw = list(range(12))  # 4 x 3, northwest value 0, southeast 11
        # row-major north-up: row 0 = [0,1,2,3]
        blob = tiff_f32([float(v) for v in raw], 4, 3, (0, 0, 0, 100.0, 200.0, 0.0), (1.0, 2.0, 0.0))
        r = self.js("""const bytes=%s;
const grid=dem3depFromTiff(bytes,{src:'USGS 3DEP Elevation ImageServer'});
const url=dem3depExportUrl({west:10,south:20,east:10.001,north:20.001},{resolution_m:1});
const samples=dem3depParseSamples({samples:[{value:'12.5',location:{x:10,y:20,spatialId:4326}}]});
return {nw:grid.values[(grid.ny-1)*grid.nx],se:grid.values[grid.nx-1],x0:grid.x0,y0:grid.y0,dx:grid.dx,dy:grid.dy,
 url:url.url,w:url.width.v,h:url.height.v,sample:samples.samples[0].value,audit:sgAudit(url)}""" % json.dumps(list(blob)))
        # Pixel (0,0) centre is half a pixel in from the tiepoint corner.
        self.assertEqual(r['nw'], 0)
        self.assertEqual(r['se'], 11)
        self.assertAlmostEqual(r['x0']['v'], 100.5, places=5)
        self.assertAlmostEqual(r['y0']['v'], 200 - 2.5 * 2, places=5)  # southern row centre: 200 - (2.5)*scaleY, scaleY=2, row index 2 → 200-5
        self.assertAlmostEqual(r['dx']['v'], 1, places=6)
        self.assertAlmostEqual(r['dy']['v'], 2, places=6)
        self.assertIn('elevation.nationalmap.gov', r['url'])
        self.assertIn('exportImage', r['url'])
        self.assertIn('10,20,10.001,20.001', r['url'])
        self.assertGreater(r['w'], 90)
        self.assertLess(r['w'], 130)
        self.assertEqual(r['sample']['v'], 12.5)
        self.assertEqual(r['sample']['src'], 'USGS 3DEP Elevation ImageServer')
        self.assertEqual(r['audit'], [])

        fetch = r'''
const fs=require('fs');const vm=require('vm');
const ctx={Math,console,Uint8Array,DataView,ArrayBuffer,JSON,parseFloat,isFinite,Error,Object,Array,String,Number};
ctx.globalThis=ctx;vm.createContext(ctx);
for (const f of ['screening.js','dem3dep.js']) vm.runInContext(fs.readFileSync(%r+'/pipeline/'+f,'utf8'),ctx);
const bytes=Uint8Array.from(%s);
ctx.dem3depFetch({west:0,south:0,east:0.01,north:0.01},{resolution_m:1,fetch:async()=>bytes}).then(g=>{
  console.log(JSON.stringify({n:g.values.length,src:g.src,url:g.request.url}));
}).catch(e=>{console.error(e);process.exit(1)});
''' % (str(ROOT), json.dumps(list(blob)))
        p = subprocess.run(['node', '-e', fetch], capture_output=True, text=True, timeout=20)
        self.assertEqual(p.returncode, 0, p.stderr[-1500:])
        got = json.loads(p.stdout)
        self.assertEqual(got['n'], 12)
        self.assertIn('3DEP', got['src'])
        self.assertIn('elevation.nationalmap.gov', got['url'])


if __name__ == '__main__':
    unittest.main()
