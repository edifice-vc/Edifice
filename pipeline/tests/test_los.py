"""Line-of-sight geometry, 3DEP fallback, public redaction, and massing renders.

Fixtures are synthetic. No parcel, owner, or site geometry is stored here.
"""
import json, os, pathlib, shutil, subprocess, unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
JS_LOS = (ROOT / 'pipeline' / 'los.js').read_text()
JS_3D = (ROOT / 'pipeline' / 'los3d.js').read_text()
THREE = ROOT / 'pipeline' / 'vendor' / 'three.module.min.js'
sys_path = str(pathlib.Path(__file__).resolve().parent)

PRE = r'''
function flatDem(x0,y0,x1,y1,z,step){
  const nx=Math.round((x1-x0)/step)+1, ny=Math.round((y1-y0)/step)+1, G=[];
  for(let j=0;j<ny;j++) for(let i=0;i<nx;i++) G.push(z);
  return {nx,ny,x0,y0,dx:step,dy:step,z:G,src:'synthetic DEM'};
}
function hall(){return {id:'hall', label:'Building', heightFt:40, heightTag:'A', phase:1, ring:[[400,-40],[480,-40],[480,40],[400,40]]};}
function base(extra){
  const m={dem:flatDem(-20,-100,520,100,0,10), buildings:[hall()], berms:[], trees:[], fences:[],
    viewpoints:[{id:'road', name:'Road entrance', kind:'road', x:0, y:0, eyeFt:5.5}]};
  return Object.assign(m, extra||{});
}
function losSynthTiff(w,h,vals,scaleX,scaleY,west,north){
  const n=w*h, data=Buffer.alloc(n*4);
  for(let i=0;i<n;i++) data.writeFloatLE(vals[i], i*4);
  const doubles=[
    {tag:33550, type:12, count:3, doubles:[scaleX, scaleY, 0]},
    {tag:33922, type:12, count:6, doubles:[0,0,0, west, north, 0]}
  ];
  const entries=[
    {tag:256,type:3,count:1,value:w},{tag:257,type:3,count:1,value:h},{tag:258,type:3,count:1,value:32},
    {tag:259,type:3,count:1,value:1},{tag:262,type:3,count:1,value:1},{tag:273,type:4,count:1,value:0},
    {tag:277,type:3,count:1,value:1},{tag:278,type:4,count:1,value:h},{tag:279,type:4,count:1,value:data.length},
    {tag:284,type:3,count:1,value:1},{tag:339,type:3,count:1,value:3}
  ].concat(doubles);
  entries.sort((a,b)=>a.tag-b.tag);
  const header=8, ifd=2+entries.length*12+4;
  let extra=0; for(const e of entries) if(e.doubles) extra+=e.doubles.length*8;
  const extraOff=header+ifd, strip=extraOff+extra;
  const buf=Buffer.alloc(strip+data.length);
  buf.writeUInt16LE(0x4949,0); buf.writeUInt16LE(42,2); buf.writeUInt32LE(header,4);
  buf.writeUInt16LE(entries.length, header);
  let cursor=extraOff;
  entries.forEach((e,i)=>{
    const o=header+2+i*12;
    buf.writeUInt16LE(e.tag,o); buf.writeUInt16LE(e.type,o+2); buf.writeUInt32LE(e.count,o+4);
    if(e.tag===273) buf.writeUInt32LE(strip,o+8);
    else if(e.doubles){ buf.writeUInt32LE(cursor,o+8); e.doubles.forEach((d,k)=>buf.writeDoubleLE(d, cursor+k*8)); cursor+=e.doubles.length*8; }
    else if(e.type===3) buf.writeUInt16LE(e.value,o+8);
    else buf.writeUInt32LE(e.value,o+8);
  });
  buf.writeUInt32LE(0, header+2+entries.length*12);
  data.copy(buf, strip);
  return buf;
}
'''


def _node(src, env=None):
    p = subprocess.run(['node'], input=src, capture_output=True, text=True, cwd=ROOT, env=env)
    if p.returncode != 0:
        raise AssertionError((p.stderr or p.stdout or 'node failed')[-4000:])
    line = [ln for ln in p.stdout.splitlines() if ln.startswith('{') or ln.startswith('[')]
    if not line:
        raise AssertionError('no JSON from node:\n' + (p.stdout + p.stderr)[-2000:])
    return json.loads(line[-1])


@unittest.skipUnless(shutil.which('node'), 'node missing')
class LOS(unittest.TestCase):
    def js(self, body):
        src = JS_LOS + PRE + '(async()=>{try{const r=await (async()=>{' + body + '})();console.log(JSON.stringify(r))}catch(e){console.error(e&&e.stack||e);process.exit(1)}})()'
        return _node(src)

    def test_species_defaults_are_assumed_and_grow(self):
        r = self.js("""const a=losTreeSize({species:'evergreen'},1), b=losTreeSize({species:'evergreen'},'maturity');
 const c=losTreeSize({species:'deciduous', installFt:10, matureFt:20, years:10, spreadInstallFt:4, spreadMatureFt:14, source:'nursery spec', assumed:false},1);
 const slope=losBermH([{line:[[0,0],[100,0]], crestFt:30}], 50, 30);
 const crest=losBermH([{line:[[0,0],[100,0]], crestFt:30}], 50, 0);
 return {y1:a.heightFt, mat:b.heightFt, spread:b.spreadFt, src:a.source, tag:a.tag, custom:c.heightFt, cassumed:c.assumed, slope, crest, n:losAssumptions().filter(x=>/ASSUMED/.test(x.note||'')||/ASSUMED/.test(x.source||'')).length}""")
        self.assertAlmostEqual(r['y1'], 6 + 24 / 18, places=6)
        self.assertEqual(r['mat'], 30)
        self.assertEqual(r['spread'], 14)
        self.assertIn('ASSUMED', r['src'])
        self.assertEqual(r['tag'], 'A')
        self.assertAlmostEqual(r['custom'], 11, places=6)
        self.assertFalse(r['cassumed'])
        self.assertAlmostEqual(r['slope'], 20, places=6)  # 30 ft crest, 30 ft off the centreline, 3:1
        self.assertEqual(r['crest'], 30)
        self.assertGreaterEqual(r['n'], 5)

    def test_eye_focal_and_registration(self):
        r = self.js("""const ped=losCamera(base(), base().viewpoints[0], {x:400,y:0,z:40});
 const drv=losCamera(base(), {id:'d', name:'Driver', kind:'road', x:0, y:0, eye:'driver'}, {x:400,y:0,z:40});
 const reg={items:[], add(x){this.items.push(x)}};
 return {eye:ped.eye[2], drv:drv.eyeFt, h50:ped.hfovDeg, h24:ped.wide.hfovDeg, reg:losRegister(reg)&&losRegister(reg), ids:reg.items.map(i=>i.id)}""")
        self.assertAlmostEqual(r['eye'], 5.5, places=6)
        self.assertEqual(r['drv'], 3.5)
        self.assertAlmostEqual(r['h50'], 39.6, delta=0.2)
        self.assertAlmostEqual(r['h24'], 73.7, delta=0.3)
        self.assertEqual(r['ids'], ['V-101', 'V-201'])
        self.assertTrue(r['reg'])

    def test_berms_block_half_then_all(self):
        # Flat ground. West eave is the facing roofline. A 3:1 berm whose blocking
        # contour falls on the centreline hides the south half of that eave.
        r = self.js("""const open=base();
 const half=base({berms:[{line:[[200,-400],[200,-21.75]], crestFt:30, slope:3, tag:'A'}]});
 const full=base({berms:[{line:[[200,-400],[200,400]], crestFt:30, slope:3}]});
 const fence=base({fences:[{line:[[50,-80],[50,80]]}]});
 const b=hall(), vp=open.viewpoints[0];
 const roof=(m)=>losRoofline(m, vp, b, 1);
 const sec=(m)=>losSection(m, vp, b);
 const A=roof(open), H=roof(half), F=roof(full), N=roof(fence);
 const sH=sec(half), sF=sec(full), sO=sec(open);
 return {open:A.pct, half:H.pct, full:F.pct, fence:N.pct, vis:H.visible, tot:H.total,
  samples:H.samples.map(s=>[s.y,s.visible]),
  sightOpen:sO.statusYear1, sightHalf:sH.statusYear1, sightFull:sF.statusYear1,
  block:sF.blockFtYear1, vex:sO.vExag, eye:sO.svg.includes('data-eye-ft="5.5"'),
  label:sO.svg.includes('Illustrative — massing model, not photoreal'),
  dem:sO.dem.resLabel, scale:(()=>{const m=sO.svg.match(/data-scale-bar="100" x1="([^"]+)"[^>]*x2="([^"]+)"/); return Math.abs(+m[2]-+m[1])})()}""")
        self.assertEqual(r['open'], 100, r)
        self.assertEqual(r['half'], 50, r)
        self.assertEqual(r['vis'], r['tot'] // 2)
        self.assertEqual(r['full'], 0, r)
        self.assertEqual(r['fence'], 100, r)
        self.assertEqual(r['sightOpen'], 'VISIBLE')
        # The centre ray clips the berm shoulder. The north half of the eave stays clear, so the
        # single sight line and the roofline percentage are both reported.
        self.assertEqual(r['sightHalf'], 'BLOCKED')
        self.assertEqual(r['sightFull'], 'BLOCKED')
        self.assertGreater(r['block'], 100)
        self.assertLess(r['block'], 250)
        self.assertGreaterEqual(r['vex'], 5)
        self.assertLessEqual(r['vex'], 10)
        self.assertTrue(r['eye'])
        self.assertTrue(r['label'])
        self.assertIn('synthetic', r['dem'])
        self.assertIn('m', r['dem'])
        self.assertAlmostEqual(r['scale'], 1, places=3)

    def test_trees_hide_more_at_maturity(self):
        r = self.js("""const m=base({trees:[{id:'t', species:'evergreen', x:200, y:0}]});
 const b=hall(), vp=m.viewpoints[0];
 const a=losRoofline(m, vp, b, 1), c=losRoofline(m, vp, b, 'maturity'), d=losRoofline(m, vp, b, 'maturity');
 const pkg=losPackage(m);
 return {y1:a.pct, mat:c.pct, again:d.pct, src:pkg.visibility[0].treeSource, tag:pkg.visibility[0].treeTag,
  sheets:pkg.sheets.map(s=>s.id), mode:pkg.mode, label:pkg.disclaimer, dem:pkg.dem.resLabel, km:pkg.keymap.widthFrac+','+pkg.keymap.heightFrac,
  arrow:pkg.keymap.svg.includes('#d00000')||pkg.keymap.svg.includes('stroke="#d00000"'), north:pkg.keymap.svg.includes('>N<')}""")
        self.assertEqual(r['y1'], 100)
        self.assertLess(r['mat'], r['y1'])
        self.assertEqual(r['mat'], r['again'])
        self.assertIn('ASSUMED', r['src'])
        self.assertEqual(r['tag'], 'A')
        self.assertEqual(r['sheets'], ['V-101', 'V-201'])
        self.assertEqual(r['mode'], 'public')
        self.assertEqual(r['label'], 'Illustrative — massing model, not photoreal')
        self.assertIn('synthetic', r['dem'])
        self.assertEqual(r['km'], '0.21,0.27')
        self.assertTrue(r['arrow'])
        self.assertTrue(r['north'])

    def test_public_mode_strips_mw_owner_apn(self):
        r = self.js("""const m=base(); m.owner='ACME LAND CO'; m.apn='APN-TEST-999';
 m.sensitive={mw:48, owner:'ACME LAND CO', apn:'APN-TEST-999'};
 m.buildings[0].label='Hall 48 MW';
 const pub=losPackage(m), adm=losPackage(m,{mode:'admin'});
 const s=JSON.stringify(pub), svg=pub.sections[0].svg, km=pub.keymap.svg;
 return {mw:s.includes('MW'), acme:s.includes('ACME'), apn:s.includes('APN-TEST'),
  svgMw:svg.includes('MW'), kmMw:km.includes('MW'),
  stamp:adm.adminStamp, owner:adm.sensitive.owner, mwN:adm.sensitive.mw,
  target:pub.visibility[0].target, eyeTag:pub.visibility[0].eyeTag, distTag:pub.visibility[0].distTag}""")
        self.assertFalse(r['mw'])
        self.assertFalse(r['acme'])
        self.assertFalse(r['apn'])
        self.assertFalse(r['svgMw'])
        self.assertFalse(r['kmMw'])
        self.assertEqual(r['stamp'], 'ADMIN — NOT FOR DISTRIBUTION')
        self.assertEqual(r['owner'], 'ACME LAND CO')
        self.assertEqual(r['mwN'], 48)
        self.assertEqual(r['target'], 'Hall')  # "Hall 48 MW" loses the capacity token
        self.assertEqual(r['eyeTag'], 'stated')
        self.assertEqual(r['distTag'], 'C')

    def test_3dep_one_meter_and_four_meter_fallback(self):
        r = self.js("""const lat=39, lon=-96, proj=losLocalFeet(lon, lat);
 const kx=proj.kx, ky=proj.ky;
 const scaleX=1/(kx*0.3048), scaleY=1/(ky*0.3048);
 const w=4, h=3;
 const west=lon, north=lat;
 const vals=[]; for(let i=0;i<w*h;i++) vals.push(100+i);
 const tiff=losSynthTiff(w,h,vals,scaleX,scaleY,west,north);
 const dem=await losLoadDem({bbox:[west, north-h*scaleY, west+w*scaleX, north], project:proj.f, zUnit:'m',
   fetch:async()=>({ok:true, status:200, arrayBuffer:async()=>tiff.buffer.slice(tiff.byteOffset, tiff.byteOffset+tiff.byteLength)})});
 const fb={nx:2,ny:2,x0:0,y0:0,dx:13.12,dy:13.12,z:[1,2,3,4], src:'USGS 3DEP via AWS Terrain Tiles (z15 ≈ 4 m)'};
 const down=await losLoadDem({bbox:[west,lat-0.01,lon+0.01,north], fetch:async()=>{throw new Error('3DEP down')}, fallback:fb});
 const url=los3DEPUrl([west,lat-0.01,lon+0.01,north], 8, 6);
 const zNorth=dem.z[(dem.ny-1)*dem.nx];
 return {res:dem.resM, label:dem.resLabel, src:dem.src, zNorth, fallback:down.fallback, fbLabel:down.resLabel, reason:down.fallbackReason,
  host:url.includes('elevation.nationalmap.gov')&&url.includes('3DEPElevation/ImageServer'), size:url.includes('size=8,6')}""")
        self.assertAlmostEqual(r['res'], 1, delta=0.05)
        self.assertEqual(r['label'], 'USGS 3DEP 1 m')
        self.assertIn('3DEP', r['src'])
        self.assertAlmostEqual(r['zNorth'], 100 * 3.280839895, places=2)
        self.assertTrue(r['fallback'])
        self.assertEqual(r['fbLabel'], 'USGS 3DEP via AWS Terrain Tiles (z15 ≈ 4 m)')
        self.assertIn('3DEP down', r['reason'])
        self.assertTrue(r['host'])
        self.assertTrue(r['size'])


@unittest.skipUnless(shutil.which('node') and THREE.exists(), 'three.js vendor missing')
class LOS3D(unittest.TestCase):
    def js(self, body, env=None):
        three = json.dumps(THREE.as_uri())
        src = JS_LOS + JS_3D + PRE + '(async()=>{try{const THREE=await import(' + three + '); globalThis.THREE=THREE; const r=await (async()=>{' + body + '})();console.log(JSON.stringify(r))}catch(e){console.error(e&&e.stack||e);process.exit(1)}})()'
        return _node(src, env)

    def test_scene_and_raycast_agree_on_a_berm(self):
        r = self.js("""const open=base(); const full=base({berms:[{line:[[200,-400],[200,400]], crestFt:30, slope:3}]});
 const fine=d=>{d=Object.assign({}, d); d.dem=flatDem(-20,-80,520,80,0,4); return d;};
 const b=hall(), vp=open.viewpoints[0];
 const a=await los3dRayFraction(fine(open), vp, b, 1);
 const c=await los3dRayFraction(fine(full), vp, b, 1);
 const ex=los3dBuild(THREE, open, {view:'existing'}).counts;
 const scene=base({trees:[{species:'evergreen', x:200, y:0}], fences:[{line:[[-10,-10],[10,-10]]}], substation:{id:'sub', ring:[[500,-20],[560,-20],[560,20],[500,20]], heightFt:55}});
 const pr=los3dBuild(THREE, scene, {view:'proposed', year:'maturity', figures:false}).counts;
 return {open:a, full:c, ex, pr}""")
        self.assertEqual(r['open']['pct'], 100, r['open'])
        self.assertEqual(r['full']['pct'], 0, r['full'])
        self.assertEqual(r['ex']['buildings'], 0)
        self.assertEqual(r['ex']['trees'], 0)
        self.assertGreaterEqual(r['pr']['buildings'], 1)
        self.assertGreaterEqual(r['pr']['trees'], 1)
        self.assertGreaterEqual(r['pr']['fences'], 1)
        self.assertEqual(r['pr']['substation'], 1)

    def test_sample_frames_carry_the_label_and_no_secrets(self):
        out = os.environ.get('LOS_OUT') or '/tmp/los-samples'
        os.makedirs(out, exist_ok=True)
        r = self.js("""const fs=require('fs');
 const x0=-220,y0=-40,x1=460,y1=520,step=20;
 const nx=Math.round((x1-x0)/step)+1, ny=Math.round((y1-y0)/step)+1, z=[];
 for(let j=0;j<ny;j++) for(let i=0;i<nx;i++){const x=x0+i*step, y=y0+j*step; z.push(1000+y*0.01+2*Math.sin(x/90))}
 const dem={nx,ny,x0,y0,dx:step,dy:step,z,src:'synthetic DEM'};
 const ring=(x,y,w,h)=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
 const model={dem, owner:'ACME LAND CO', apn:'APN-TEST-999', sensitive:{mw:48, owner:'ACME LAND CO', apn:'APN-TEST-999'},
  buildings:[{id:'b1', label:'Building', phase:1, heightFt:42, heightTag:'A', ring:ring(-70,340,150,120)},
             {id:'b2', label:'Building', phase:2, heightFt:42, heightTag:'A', ring:ring(110,340,160,120)}],
  yards:[{id:'y1', label:'Yard', heightFt:15, heightTag:'A', ring:ring(-70,310,150,24)}],
  substation:{id:'sub', label:'Substation', heightFt:55, heightTag:'A', ring:ring(300,360,70,50), source:'ASSUMED · typical bus and structure height'},
  berms:[{line:[[-180,200],[340,200]], crestFt:12, slope:3}],
  trees:[], fences:[{line:ring(-100,280,420,220)}],
  roads:[{line:[[-200,0],[200,0]], widthFt:28}],
  viewpoints:[{id:'road', name:'Road entrance', kind:'road', x:0, y:20, eyeFt:5.5}]};
 for(let x=-160;x<=320;x+=40) model.trees.push({species:'evergreen', x, y:215});
 const pkg=losPackage(model);
 const rendered=await los3dRenderPackage(model, {width:960, height:540, mode:'public'});
 const dir=process.env.LOS_OUT;
 fs.writeFileSync(dir+'/los-section.svg', pkg.sections[0].svg);
 fs.writeFileSync(dir+'/los-keymap.svg', pkg.keymap.svg);
 rendered.frames.forEach((f,i)=>fs.writeFileSync(dir+'/'+(f.year===1?'los-existing-proposed-year1.png':'los-existing-proposed-maturity.png'), f.png));
 if(rendered.oblique) fs.writeFileSync(dir+'/los-oblique.png', rendered.oblique.png);
 const count=(rgba,w,h)=>{let n=0; const bar=40, kw=Math.round(w*0.21), kh=Math.round(h*0.27), x1=10+kw, y0=h-bar-kh-8;
  for(let y=0;y<h-bar;y++) for(let x=0;x<w;x++){ if(x<x1&&y>=y0&&y<y0+kh) continue;
   const i=(y*w+x)*4, r=rgba[i],g=rgba[i+1],b=rgba[i+2]; if(r>90&&g<120&&b<80&&r>g+30&&r>b+30) n++; } return n};
 const cam=pkg.cameras[0];
 const proposed=await los3dRender(model, cam, {view:'proposed', year:1, width:480, height:270, title:'Proposed · year 1 · Road entrance'});
 const existing=await los3dRender(model, cam, {view:'existing', year:1, width:480, height:270, title:'Existing · Road entrance', figures:false});
 const texts=rendered.frames.map(f=>f.meta);
 const blob=JSON.stringify(texts)+JSON.stringify(pkg.visibility)+pkg.sections[0].svg;
 return {y1:pkg.visibility[0].year1Pct, mat:pkg.visibility[0].maturityPct, dem:pkg.dem.resLabel,
  texts, orangeP:count(proposed.rgba,480,270), orangeE:count(existing.rgba,480,270),
  secret: /ACME|APN-TEST|\\bMW\\b/.test(blob),
  label: texts.every(t=>t.Disclaimer===LOS_LABEL),
  res: texts.every(t=>/synthetic DEM/.test(t.DemResolution||'')),
  sheets:pkg.sheets.map(s=>s.id), w:rendered.frames[0].width, h:rendered.frames[0].height,
  counts:rendered.frames[0].counts}""", env=dict(os.environ, LOS_OUT=out))
        self.assertEqual(r['sheets'], ['V-101', 'V-201'])
        self.assertGreater(r['y1'], r['mat'])
        self.assertIn('synthetic', r['dem'])
        self.assertIn('m', r['dem'])
        self.assertTrue(r['label'])
        self.assertTrue(r['res'], r['texts'])
        self.assertFalse(r['secret'], r['texts'])
        self.assertGreater(r['orangeP'], 30, r)
        self.assertEqual(r['orangeE'], 0)
        self.assertEqual(r['w'], 1920)
        self.assertEqual(r['h'], 540)
        self.assertGreaterEqual(r['counts']['buildings'], 2)
        self.assertGreaterEqual(r['counts']['trees'], 1)
        self.assertGreaterEqual(r['counts']['fences'], 1)
        self.assertEqual(r['counts']['substation'], 1)
        for name in ('los-existing-proposed-year1.png', 'los-existing-proposed-maturity.png', 'los-oblique.png', 'los-section.svg', 'los-keymap.svg'):
            p = pathlib.Path(out) / name
            self.assertTrue(p.exists() and p.stat().st_size > 500, name)
        png = (pathlib.Path(out) / 'los-existing-proposed-year1.png').read_bytes()
        self.assertTrue(png.startswith(b'\x89PNG'))
        self.assertIn('Illustrative — massing model, not photoreal'.encode(), png)
        art = pathlib.Path('/opt/cursor/artifacts')
        if art.is_dir():
            for name in ('los-existing-proposed-year1.png', 'los-existing-proposed-maturity.png', 'los-oblique.png', 'los-section.svg', 'los-keymap.svg'):
                shutil.copy(pathlib.Path(out) / name, art / name)


@unittest.skipUnless(shutil.which('node'), 'node missing')
class LOSSolve(unittest.TestCase):
    def test_from_solve_public_drops_capacity(self):
        import sys
        sys.path.insert(0, sys_path)
        from test_testfit import SRC, HELP
        body = """const R=sq(40), r=tfDC(R, Object.assign({}, TF_DEF.land, {halls:2, sw:'off', subAc:1, genAc:0.4}), {});
 let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9; R.forEach(p=>{x0=Math.min(x0,p[0]); y0=Math.min(y0,p[1]); x1=Math.max(x1,p[0]); y1=Math.max(y1,p[1])});
 const step=80, nx=Math.round((x1-x0)/step)+1, ny=Math.round((y1-y0)/step)+1, z=[];
 for(let j=0;j<ny;j++) for(let i=0;i<nx;i++) z.push(900);
 const dem={nx,ny,x0,y0,dx:step,dy:step,z,src:'synthetic DEM'};
 const model=losFromSolve(r,{dem, owner:'ACME LAND CO', apn:'APN-TEST-999', viewpoints:[{id:'road', name:'Road entrance', kind:'road', x:0, y:y0-50, eyeFt:5.5}]});
 const pub=losPackage(model), s=JSON.stringify(pub);
 return {n:model.buildings.length, yards:model.yards.length, sub:!!model.substation, mw:s.includes('MW'), acme:s.includes('ACME'), apn:s.includes('APN-TEST'),
  label:pub.visibility[0].target, dem:pub.dem.resLabel, eye:pub.visibility[0].eyeFt, sheets:pub.sheets.map(x=>x.id)}"""
        src = SRC + HELP + JS_LOS + '(async()=>{try{const r=await (async()=>{' + body + '})();console.log(JSON.stringify(r))}catch(e){console.error(e&&e.stack||e);process.exit(1)}})()'
        r = _node(src)
        self.assertGreater(r['n'], 0)
        self.assertTrue(r['sub'])
        self.assertFalse(r['mw'])
        self.assertFalse(r['acme'])
        self.assertFalse(r['apn'])
        self.assertNotIn('MW', r['label'] or '')
        self.assertIn('synthetic', r['dem'])
        self.assertEqual(r['eye'], 5.5)
        self.assertEqual(r['sheets'], ['V-101', 'V-201'])


if __name__ == '__main__':
    unittest.main()
