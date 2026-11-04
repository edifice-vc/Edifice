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

if __name__ == '__main__':
    unittest.main()
