"""Site plan sheet geometry: bearings/distances, vertex numbering, offsets, road no-build, boundary-needed."""
import json, shutil, subprocess, unittest
from test_testfit import SRC, HELP

@unittest.skipUnless(shutil.which('node'), 'node missing')
class Sheet(unittest.TestCase):
    def js(self, body):
        src = SRC + HELP + 'const TF_PH=["#F14B21","#3fa7ff","#5ad17a","#c77dff","#ffb000","#00c2c2","#ff6fae","#a0a0a0"];console.log(JSON.stringify((()=>{' + body + '})()))'
        return json.loads(subprocess.run(['node'], input=src, capture_output=True, text=True, check=True).stdout)

    def test_bearing_quadrants(self):
        r = self.js("return [[0,100],[100,100],[100,0],[0,-100],[-100,-100],[-1,100]].map(p=>shBearing([0,0],p).txt)")
        self.assertEqual(r[0], 'N 0°00\'00" E'); self.assertEqual(r[1], 'N 45°00\'00" E')
        self.assertIn(r[2], ('N 90°00\'00" E', 'S 90°00\'00" E')); self.assertTrue(r[3].startswith('S 0°00'))
        self.assertEqual(r[4], 'S 45°00\'00" W'); self.assertTrue(r[5].startswith('N 0°34') and r[5].endswith('W'))

    def test_courses_close_and_distance(self):
        r = self.js("const C=shCourses([[0,0],[300,0],[300,400],[0,0]]);return C.map(c=>[c.from,c.to,Math.round(c.dist*100)/100])")
        self.assertEqual(r, [[1, 2, 300], [2, 3, 400], [3, 1, 500]])

    def test_points_dedupe_and_numbering(self):
        r = self.js("const P=shPoints(1);return [P.add([0,0],'a'),P.add([10,0],'b'),P.add([0.4,0.2],'dup'),P.add([5,5],'c'),P.L.length]")
        self.assertEqual(r, [1, 2, 1, 3, 3])

    def test_offset_ring_inside(self):
        r = self.js("const Q=sq(10),O=cvOffset(Q,[50,50,50,50]);const h=Math.sqrt(10*43560)/2;return {a:Math.abs(shArea(O)),e:(2*h-100)**2,in:O.every(p=>tfIn(p[0],p[1],Q))}")
        self.assertAlmostEqual(r['a'], r['e'], delta=r['e'] * 0.01); self.assertTrue(r['in'])

    def test_band_and_crossing(self):
        r = self.js("const B=shBand([0,0],[100,0],30);const X=shCross(sq(10),[[[-1000,0],[1000,0]]]);return {w:Math.abs(B[0][1]-B[3][1]),n:X.length}")
        self.assertEqual(r['w'], 60); self.assertEqual(r['n'], 2)

    def test_road_excluded_from_halls(self):
        # a 60 ft ROW public road through the middle of 80 ac: no hall may sit within ROW/2 + 50 ft setback
        r = self.js("""const R=sq(80),road=[[-2000,0],[2000,0]],hw=30+50,nb=(x,y)=>Math.abs(y)<hw;
 const r=tfDC(R,Object.assign({},TF_DEF.land,{halls:40}),{nb,nbKind:(x,y)=>nb(x,y)?4:0});let bad=0;
 r.halls.forEach(h=>[h.hall,h.gen].filter(Boolean).forEach(Rr=>{const [x,y,w,hh]=Rr;for(let i=0;i<=8;i++)for(let j=0;j<=8;j++){const p=r.C.un([x+w*i/8,y+hh*j/8]);if(Math.abs(p[1])<hw-1)bad++}}));
 return {n:r.n,bad,road:r.build.road}""")
        self.assertGreater(r['n'], 0); self.assertEqual(r['bad'], 0); self.assertGreater(r['road'], 0)

    def test_sheet_boundary_needed_and_vertices(self):
        r = self.js("""const R=[[0,0],[1200,0],[1300,900],[200,1100],[-100,500],[0,0]],r=tfDC(R,TF_DEF.land,{});const svg=tfSheet(r,{polySrc:'parcel'});
 const r2=tfDC(sq(20),Object.assign({},TF_DEF.land,{halls:0}),{});r2.boundaryNeeded=true;r2.halls=[];const s2=tfSheet(r2,{polySrc:'square'});
 return {v:['P1','P2','P3','P4','P5'].every(t=>svg.includes('>'+t+'<')),brg:/[NS] \\d+°\\d\\d'\\d\\d(&quot;|") [EW]/.test(svg),cnc:svg.includes('NOT FOR CONSTRUCTION'),bn:s2.includes('BOUNDARY NEEDED'),hall:s2.includes('HALL 1')}""")
        self.assertTrue(r['v']); self.assertTrue(r['brg']); self.assertTrue(r['cnc']); self.assertTrue(r['bn']); self.assertFalse(r['hall'])

    def test_tx_row_by_voltage(self):
        r = self.js("return [69,115,138,161,230,345,500,765,null].map(shTxRow)")
        self.assertEqual(r, [75, 100, 100, 100, 150, 175, 200, 250, 100])

    def test_flood_zone_no_build(self):
        r = self.js("return ['A','AE','AO','AH','VE','A99','X','X PROTECTED BY LEVEE','D','',null].map(shFloodNB)")
        self.assertEqual(r, [True]*6 + [False]*5)

    def test_contours_on_plane(self):
        # z = x/10 over 0..100 ft: 2 ft interval -> straight N-S contours at x = 20..100 (z=0 edge not crossed)
        r = self.js("""const nx=11,ny=6,G=[];for(let j=0;j<ny;j++)for(let i=0;i<nx;i++)G.push(i);const C=shContours(G,nx,ny,0,0,10,10,2);
 const S=shSlope(G,nx,ny,0,0,10,10);return {zs:C.map(c=>c.z),xs:C.map(c=>c.segs.every(([p,q])=>Math.abs(p[0]-c.z*10)<1e-6&&Math.abs(q[0]-c.z*10)<1e-6)),n:C[1].segs.length,s:S.mean,iv:[shInterval(12),shInterval(80)]}""")
        self.assertEqual(r['zs'], [2, 4, 6, 8, 10]); self.assertTrue(all(r['xs'])); self.assertEqual(r['n'], 5)
        self.assertAlmostEqual(r['s'], 10, places=6); self.assertEqual(r['iv'], [2, 10])

    def test_wrap(self):
        r = self.js("const t='Power [H] 115 kV transmission; ROW 100 ft by voltage [A] (no recorded easement) substations: Foo';return shWrap(t,40)")
        self.assertTrue(all(len(x) <= 40 for x in r)); self.assertGreater(len(r), 2)
        self.assertEqual(' '.join(x.strip() for x in r), 'Power [H] 115 kV transmission; ROW 100 ft by voltage [A] (no recorded easement) substations: Foo')

    def test_power_and_flood_no_build_and_sheet(self):
        # 115 kV line along y=0 (100 ft ROW) + Zone AE polygon in the NE corner; both removed from net, drawn on the sheet, panel stays in width
        r = self.js("""const R=sq(80),tx=[{kv:115,row:shTxRow(115),L:[[-3000,0],[3000,0]],src:'HIFLD',owner:'WESTAR'}],fl=[{zone:'AE',nb:true,R:[[[300,300],[1200,300],[1200,1200],[300,1200],[300,300]]]},{zone:'X',nb:false,R:[[[-900,-900],[-500,-900],[-500,-500],[-900,-900]]]}];
 const N={segs:tx.map(o=>[o.L[0][0],o.L[0][1],o.L[1][0],o.L[1][1],o.row/2,6,o.row,'115 kV']),polys:fl.filter(f=>f.nb).map(f=>[f.R,2])};
 const segD=(x,y,a,b)=>{const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy)));return Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy)};
 const nbK=(x,y)=>{for(const q of N.segs)if(segD(x,y,[q[0],q[1]],[q[2],q[3]])<q[4])return q[5];for(const [RR,k] of N.polys)if(tfIn(x,y,RR[0]))return k;return 0};const r=tfDC(R,Object.assign({},TF_DEF.land,{halls:40}),{nb:(x,y)=>nbK(x,y)>0,nbKind:nbK});
 const G=[];for(let j=0;j<30;j++)for(let i=0;i<30;i++)G.push(1500+i*0.3+j*0.1);const topo={nx:30,ny:30,X0:-1000,Y0:-1000,dx:70,dy:70,G,src:'test DEM'};
 const svg=tfSheet(r,{polySrc:'parcel',N,ext:{tx,flood:fl,subs:[{name:'Test Sub',kv:115,at:[100,-200]}],topo,src:{flood:'FEMA NFHL',tx:'HIFLD'},errs:{}}});
 const T=[...svg.matchAll(/<text x="([0-9.]+)"[^>]*xml:space="preserve">([^<]*)</g)].map(m=>[+m[1],m[2].replace(/&[a-z]+;/g,'x').length]);
 return {power:r.build.power,flood:r.build.flood,kv:svg.includes('115 kV'),fema:svg.includes('FEMA ZONE AE'),sub:svg.includes('SUB Test Sub'),topo:svg.includes('Topo [U]'),slope:/avg\s*[0-9.]+%/.test(svg)&&svg.includes('relief'),maxc:Math.max(...T.filter(t=>t[0]>900).map(t=>t[1])),fs:+(svg.match(/font-size="([0-9.]+)" fill="#333" xml:space/)||[0,0])[1]}""")
        self.assertGreater(r['power'], 0.5); self.assertGreater(r['flood'], 5)
        for k in ('kv', 'fema', 'sub', 'topo', 'slope'): self.assertTrue(r[k], k)
        self.assertLessEqual(r['maxc'] * r['fs'] * 0.61, 1500 - 960 - 20)

if __name__ == '__main__':
    unittest.main()
