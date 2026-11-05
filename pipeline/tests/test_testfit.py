import json, pathlib, shutil, subprocess, unittest
ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = 'const CV_REF=' + (ROOT / 'pipeline' / 'civil_ref.json').read_text().strip() + ';\n' + '\n'.join((ROOT / 'pipeline' / f).read_text() for f in ('planEditSchema.js', 'testfit.js', 'civil.js', 'sheet.js'))
HELP = '''
const sq=a=>{const h=Math.sqrt(a*43560)/2;return [[-h,-h],[h,-h],[h,h],[-h,h],[-h,-h]]};
const rects=r=>r.co==='land'?r.halls.flatMap(h=>[h.hall,h.gen].filter(Boolean)).concat([r.sub,r.park].filter(Boolean)):[r.mu,r.office].filter(Boolean).concat(r.du,r.rv);
const corners=(r,R)=>{const [x,y,w,h]=R;return [[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x+w/2,y+h/2]].map(r.C.un)};
const valid=(r,poly,set,nb)=>{const Rs=rects(r);for(const R of Rs)for(const p of corners(r,R)){if(!tfIn(p[0],p[1],poly))return 'outside';
 for(let i=1;i<poly.length;i++)if(tfSD(p[0],p[1],poly[i-1],poly[i])<set-1)return 'setback';if(nb&&nb(p[0],p[1]))return 'nobuild'}
 for(let i=0;i<Rs.length;i++)for(let j=i+1;j<Rs.length;j++){const a=Rs[i],b=Rs[j];if(a[0]<b[0]+b[2]-.01&&a[0]+a[2]>b[0]+.01&&a[1]<b[1]+b[3]-.01&&a[1]+a[3]>b[1]+.01)return 'overlap'}return 'ok'};
'''

@unittest.skipUnless(shutil.which('node'), 'node missing')
class TestFit(unittest.TestCase):
    def js(self, body):
        src = SRC + HELP + 'console.log(JSON.stringify((()=>{' + body + '})()))'
        return json.loads(subprocess.run(['node'], input=src, capture_output=True, text=True, check=True).stdout)

    def test_dc_mw_cap_and_geometry(self):
        r = self.js("const R=sq(160),r=tfDC(R,TF_DEF.land,{gridMW:50});return {k:r.k,b:r.bind,v:valid(r,R,100),sub:!!r.sub}")
        self.assertAlmostEqual(r['k']['fac'], 50, places=1)
        self.assertLessEqual(r['k']['it'], 50 / 1.3 + 1e-6)
        self.assertEqual(r['b'], 'Grid cap'); self.assertEqual(r['v'], 'ok'); self.assertTrue(r['sub'])

    def test_dc_uncapped_land_bound_and_rotation(self):
        r = self.js("const R=sq(80);return [0,30,90].map(rot=>{const r=tfDC(R,Object.assign({},TF_DEF.land,{halls:40,rot}),{});return [r.n,valid(r,R,100),r.bind]})")
        for n, v, b in r:
            self.assertGreater(n, 0); self.assertEqual(v, 'ok'); self.assertIn('Land', b)

    def test_nobuild_respected(self):
        r = self.js("const R=sq(160),nb=(x,y)=>Math.abs(y)<150;const a=tfDC(R,Object.assign({},TF_DEF.land,{halls:40}),{nb}),b=tfST(sq(6),TF_DEF.storage,{nb:(x,y)=>x>0});return [valid(a,R,100,nb),valid(b,sq(6),25,(x,y)=>x>0.5),a.n>0,b.nrsf>0]")
        self.assertEqual(r, ['ok', 'ok', True, True])

    def test_zoning_interface(self):
        r = self.js("""const z={district:'A-2',setbacks_ft:{front:{v:50},side:{v:25},rear:{v:30}},max_height_ft:{v:35},treatment:{data_center:{status:'not_listed'},self_storage:{status:'prohibited'}}};
 const Z=tfZone(z,'land'),r=tfDC(sq(160),Object.assign({},TF_DEF.land,{setF:10,setS:10,setR:10,stories:2}),{gridMW:50,zone:Z}),s=tfST(sq(5),TF_DEF.storage,{zone:tfZone(z,'storage')}),n=tfZone(null,'land');
 return {E:[r.E.setF,r.E.setS,r.E.setR,r.E.maxH],st:r.stories,w:r.warn.map(w=>w.k),sw:s.warn.map(w=>w.k),ss:s.stories,n:[n.front,n.maxH,n.okU]}""")
        self.assertEqual(r['E'], [50, 25, 30, 35]); self.assertEqual(r['st'], 1)
        self.assertIn('height', r['w']); self.assertIn('use', r['w']); self.assertIn('use', r['sw']); self.assertLessEqual(r['ss'], 2)
        self.assertEqual(r['n'], [None, None, None])

    def test_storage_metrics_and_coverage(self):
        r = self.js("const R=sq(5);return ['du','mu','hy'].map(mode=>{const r=tfST(R,Object.assign({},TF_DEF.storage,{mode,cov:35}),{});return [r.k.nrsf,r.k.units,r.k.cov,valid(r,R,25)]})")
        for nrsf, units, cov, v in r:
            self.assertGreater(nrsf, 0); self.assertGreater(units, 0); self.assertLessEqual(cov, 35.01); self.assertEqual(v, 'ok')

    def test_generator_ranked(self):
        r = self.js("return tfGen('storage',sq(4),TF_DEF.storage,{}).map(o=>o.score)")
        self.assertGreater(len(r), 1); self.assertEqual(r, sorted(r, reverse=True))

    def test_parser(self):
        r = self.js("""const L=TF_DEF.land,S=TF_DEF.storage,p=(q,c)=>{const x=tfParse(q,c,c==='land'?L:S);return [x.ops,x.goal]};
 return {a:p('add a second hall','land'),b:p('move the substation to the NW corner','land'),c:p('increase setbacks to 100 ft','land'),
 d:p('switch to all drive-up','storage'),e:p('max out rentable sq ft','storage'),f:p('make it 2 phases','land'),g:p('rear setback 40','storage'),
 h:p('remove 2 halls','land'),i:p('blah','land'),j:tfApplyOps('land',L,[{k:'halls',d:-99},{k:'pue',v:9},{k:'evil',v:1},{k:'subPos',v:'NW'}])}""")
        self.assertEqual(r['a'][0], [{'k': 'halls', 'd': 1}])
        self.assertEqual(r['b'][0], [{'k': 'subPos', 'v': 'NW'}])
        self.assertEqual(r['c'][0], [{'k': k, 'v': 100} for k in ('setF', 'setS', 'setR')])
        self.assertEqual(r['d'][0], [{'k': 'mode', 'v': 'du'}])
        self.assertEqual(r['e'][1], 'nrsf')
        self.assertEqual(r['f'][0], [{'k': 'phases', 'v': 2}])
        self.assertEqual(r['g'][0], [{'k': 'setR', 'v': 40}])
        self.assertEqual(r['h'][0], [{'k': 'halls', 'd': -2}])
        self.assertEqual(r['i'], [[], None])
        self.assertEqual((r['j']['halls'], r['j']['pue'], 'evil' in r['j'], r['j']['subPos']), (0, 2, False, 'NW'))

    def test_multipolygon_road_gap_no_bridge(self):
        """Two parcels split by a ~60 ft road gap: pack each alone; no hall/yard/pond crosses the gap."""
        r = self.js("""
 const gap=60,W=1300,H=600;
 const A=[[0,0],[W,0],[W,H],[0,H],[0,0]], B=[[W+gap,0],[W+gap+W,0],[W+gap+W,H],[W+gap,H],[W+gap,0]];
 const midX=W+gap/2;
 const crosses=r=>{const Rs=(r.halls||[]).flatMap(h=>[h.hall,h.gen].filter(Boolean)).concat([r.sub,r.park,r.pond].filter(Boolean));
  for(const R of Rs){const [x,y,w,h]=R;
   if(Math.min(x,x+w)<midX-1 && Math.max(x,x+w)>midX+1)return true;
   for(const px of [x,x+w/2,x+w])for(const py of [y,y+h/2,y+h])if(px>W+1&&px<W+gap-1&&py>0&&py<H)return true}
  return false};
 const I=Object.assign({},TF_DEF.land,{halls:8,hallW:250,hallL:1000,setF:50,setS:50,setR:50,sw:'off',subAc:0,genAc:0.5,park:0});
 const r=tfSolve('land',[A,B],I,{});
 const nL=(r.halls||[]).filter(h=>h.part===0).length, nR=(r.halls||[]).filter(h=>h.part===1).length;
 let inGap=false;for(const h of r.halls||[]){const [x,y,w,hh]=h.hall;for(const p of [[x,y],[x+w,y],[x+w,y+hh],[x,y+hh],[x+w/2,y+hh/2]])if(p[0]>W+1&&p[0]<W+gap-1)inGap=true}
 return {n:r.n,nL,nR,parts:r.parts,cross:crosses(r),inGap,pack:r.pack};
""")
        self.assertGreaterEqual(r['n'], 2, r)
        self.assertGreaterEqual(r['nL'], 1, r)
        self.assertGreaterEqual(r['nR'], 1, r)
        self.assertEqual(r['parts'], 2)
        self.assertFalse(r['cross'], r)
        self.assertFalse(r['inGap'], r)


if __name__ == '__main__':
    unittest.main()
