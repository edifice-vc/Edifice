"""Civil layer: setbacks per edge, stormwater (Atlas 14 + TR-55), pond placement, FAA Part 77, phasing, parser keys."""
import json, shutil, subprocess, unittest
from test_testfit import SRC, HELP

PF = "const PF={'2':[.43,.63,.77,1.06,1.37,1.66,1.83,2.2,2.71,3.19],'10':[.66,.97,1.18,1.67,2.21,2.72,3.04,3.68,4.2,4.65],'100':[.95,1.39,1.7,2.43,3.38,4.33,5.01,6.05,6.78,7.34]};"

@unittest.skipUnless(shutil.which('node'), 'node missing')
class Civil(unittest.TestCase):
    def js(self, body):
        src = SRC + HELP + PF + 'console.log(JSON.stringify((()=>{' + body + '})()))'
        return json.loads(subprocess.run(['node'], input=src, capture_output=True, text=True, check=True).stdout)

    def test_ref_grid_and_atlas(self):
        r = self.js("const p=cvAtlas(38.37,-97.66);return {n:CV_REF.faa.airports.length,p100:p['100'][9],p2:p['2'][9],mpr:CV_REF.faa.airports.some(a=>a.id==='MPR')}")
        self.assertGreater(r['n'], 150); self.assertTrue(r['mpr'])
        self.assertAlmostEqual(r['p100'], 7.34, delta=0.35); self.assertAlmostEqual(r['p2'], 3.19, delta=0.2)

    def test_storm_monotone_and_rules(self):
        r = self.js("const s=i=>cvStorm({A:100,imp:i,hsg:{C:1},pf:PF});const a=s(.2),b=s(.6),c=cvStorm({A:100,imp:.6,hsg:{C:1},pf:PF,rule:'apwa'}),d=cvStorm({A:100,imp:.6,hsg:null,pf:PF});return {a:a.V,b:b.V,cq:c.rows.map(x=>x.Qa),gov:b.gov,asm:d.hsgAssumed,wq:b.WQv,cn:[b.CNpre,b.CNpost]}")
        self.assertGreater(r['b'], r['a']); self.assertGreater(r['a'], 0)
        self.assertEqual([round(x, 1) for x in r['cq']], [20.0, 60.0, 300.0])
        self.assertTrue(r['asm']); self.assertGreater(r['cn'][1], r['cn'][0])
        # De Soto Pond B benchmark (116.5 ac @61%: 17.4 ac-ft routed). Our screening is conservative but within 2x
        b = self.js("return cvStorm({A:116.5,imp:.61,hsg:{C:1},pf:PF}).Vac")
        self.assertTrue(17.4 <= b <= 35, b)

    def test_pond_geometry(self):
        r = self.js("const p=cvPond(10*43560,5,4,1);const w=p.bw,l=p.bl,tw=w+40,tl=l+40;return {v:5/6*(w*l+tw*tl+(w+tw)*(l+tl)),ac:p.ac,ow:p.ow,bw:p.bw}")
        self.assertAlmostEqual(r['v'] / 43560, 10, places=2); self.assertAlmostEqual(r['ow'], r['bw'] + 48 + 30, places=3)

    def test_edge_setbacks_corner_residential_row(self):
        r = self.js("""const R=sq(100),E=Object.assign({},TF_DEF.land,{setF:50,setS:25,setR:30,front:'S',front2:'E',rowDed:10,ueF:15,buf:10,resSide:'N',resBuf:150});
 const C=tfCtx(R,E,null);return C.edges.map(e=>[e[4].kind,Math.round(e[2]),Math.round(e[3])])""")
        k = {a[0]: a for a in r}
        self.assertEqual(k['front'][1:], [60, 25]); self.assertEqual(k['front2'][1:], [60, 25])
        self.assertEqual(k['rear'][1:], [150, 150]); self.assertEqual(k['side'][1], 25)

    def test_pond_placed_and_buildable(self):
        r = self.js("""const R=sq(100),dem={x0:-1100,y0:-1100,dx:220,dy:220,nx:11,ny:11,z:Array.from({length:121},(_,i)=>1500+(i%11)*2+Math.floor(i/11))};
 const r=tfDC(R,Object.assign({},TF_DEF.land,{halls:4}),{gridMW:null,cv:{pf:PF,hsg:{C:1},dem,demStats:cvDemStats(dem)},lowPt:[-1000,-1000]});
 return {pond:r.pond,need:r.sw.Vdes,cap:r.pd.V,v:valid(r,R,100),b:r.build,g:r.grade,lo:r.pond?[r.pond[0],r.pond[1]]:null}""")
        self.assertIsNotNone(r['pond']); self.assertGreaterEqual(r['cap'] * 1.001, r['need'])
        self.assertEqual(r['v'], 'ok')
        b = r['b']; self.assertAlmostEqual(b['gross'], 100, delta=1.5)
        self.assertAlmostEqual(b['net'] + b['setback'] + b['pond'] + b['row'], b['gross'], delta=0.01)
        self.assertGreater(b['pond'], 0); self.assertLess(r['lo'][0], 0); self.assertLess(r['lo'][1], 0)  # sits in the low (SW) quadrant
        self.assertGreater(r['g']['pondCY'], 0)

    def test_faa_and_height(self):
        r = self.js("""const A=[{id:'T1',type:'AD',elev:1000,lat:38,lon:-97,rwy:[[-97,37.99,-97,38.01,7280]]}];
 const near=cvFAA([[38,-96.99],[38.001,-96.99]],1100,A),far=cvFAA([[38.5,-97]],1000,A),h=cvHeight(60,near,80),h2=cvHeight(35,far,42);
 return {cap:near.cap,why:near.capWhy,notice:Math.round(near.notice),far:far.cap,b:h.bind,f:h.flags.length,b2:h2.bind,f2:h2.flags}""")
        self.assertLess(r['cap'], 60); self.assertIn('77.19', r['why']); self.assertLess(r['notice'], 200)
        self.assertIsNone(r['far']); self.assertIn('FAA', r['b']); self.assertGreaterEqual(r['f'], 2)
        self.assertEqual(r['b2'], 'Zoning'); self.assertTrue(any('Variance' in x for x in r['f2']))

    def test_faa_caps_solver(self):
        r = self.js("const r=tfST(sq(5),Object.assign({},TF_DEF.storage,{stories:4}),{faa:{cap:30,capWhy:'x',notice:100,nWhy:'y',near:[]}});return [r.stories,r.hlim.why]")
        self.assertEqual(r, [2, 'FAA Part 77'])

    def test_phasing_targets_grid_and_order(self):
        r = self.js("""const R=sq(300),r=tfDC(R,Object.assign({},TF_DEF.land,{tgtMW:100,phases:2,mwBasis:'fac'}),{gridMW:50,cv:{pf:PF,hsg:{C:1}}});
 const d=o=>Math.hypot(o.hall[0]+o.hall[2]/2-(r.sub[0]+r.sub[2]/2),o.hall[1]+o.hall[3]/2-(r.sub[1]+r.sub[3]/2));
 return {T:r.T,rows:r.rows.map(w=>[w.halls,w.grid,+w.cumFac.toFixed(1),w.det>=0]),it:r.k.it,land:r.k.itLand,ord:r.halls.map(d),warn:r.warn.map(w=>w.k),v:valid(r,R,100)}""")
        self.assertAlmostEqual(sum(r['T']), 100 / 1.3, places=3)
        self.assertEqual(r['rows'][0][1], True); self.assertEqual(r['rows'][1][1], False); self.assertIn('grid', r['warn'])
        self.assertAlmostEqual(r['it'], 50 / 1.3, places=1); self.assertGreaterEqual(r['land'], 100 / 1.3 - 1e-6)
        self.assertEqual(r['ord'], sorted(r['ord'])); self.assertEqual(r['v'], 'ok')
        self.assertTrue(all(x[3] for x in r['rows']))
        s = self.js("return cvPhaseTargets({phMW:'50, 100',mwBasis:'it'})")
        self.assertEqual(s, [50, 100])

    def test_phasing_land_shortfall(self):
        r = self.js("const r=tfDC(sq(40),Object.assign({},TF_DEF.land,{tgtMW:300,phases:3}),{});return [r.bind,r.warn.some(w=>w.k==='land'),r.rows.length,r.rows.at(-1).short>0]")
        self.assertIn('Land', r[0]); self.assertTrue(r[1]); self.assertEqual(r[2], 3); self.assertTrue(r[3])

    def test_parser_civil_and_phasing(self):
        r = self.js("""const L=TF_DEF.land,p=q=>tfApplyOps('land',L,tfParse(q,'land',L).ops);
 return {a:p('200 MW in 4 phases'),b:p('50 now, 100 later'),c:p('50 now and another 100 later'),d:p('target 100 mw of IT'),e:p('corner lot on the east, residential to the north'),
  f:p('dedicate 10 ft of row and 20 ft utility easement'),g:p('pond depth 6 ft with 3:1 slopes, apwa release'),h:p('no detention'),i:p('phase 1 40 mw phase 2 60 mw'),n:Object.keys(TF_EDIT_SCHEMA.keys.land).length,m:Object.keys(TF_EDIT_SCHEMA.keys.storage).length}""")
        self.assertEqual((r['a']['tgtMW'], r['a']['phases'], r['a']['phMW']), (200, 4, ''))
        self.assertEqual((r['b']['phMW'], r['b']['tgtMW']), ('50,50', 100))
        self.assertEqual((r['c']['phMW'], r['c']['tgtMW']), ('50,100', 150))
        self.assertEqual((r['d']['tgtMW'], r['d']['mwBasis']), (100, 'it'))
        self.assertEqual((r['e']['front2'], r['e']['resSide']), ('E', 'N'))
        self.assertEqual((r['f']['rowDed'], r['f']['ueF']), (10, 20))
        self.assertEqual((r['g']['pondD'], r['g']['slope'], r['g']['swRule']), (6, 3, 'apwa'))
        self.assertEqual(r['h']['sw'], 'off'); self.assertEqual(r['i']['phMW'], '40,60')
        self.assertLessEqual(r['n'], 40); self.assertLessEqual(r['m'], 40)

    def test_checklist_tags(self):
        r = self.js("return CV_CHECK.map(c=>c[2])")
        self.assertEqual(set(r) - {'computed', 'estimated', 'requires PE'}, set()); self.assertGreaterEqual(len(r), 10)

if __name__ == '__main__':
    unittest.main()
