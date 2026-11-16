"""Campus layout: aligned halls, land-first no-build, and two or three schemes.

Synthetic parcels only. No real parcel geometry and no Zoneomics payloads.
"""
import json
import pathlib
import shutil
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = (
    "const CV_REF="
    + (ROOT / "pipeline" / "civil_ref.json").read_text().strip()
    + ";\n"
    + "\n".join(
        (ROOT / "pipeline" / f).read_text()
        for f in ("planEditSchema.js", "testfit.js", "civil.js")
    )
)


def js(body):
    src = SRC + "\nconsole.log(JSON.stringify((()=>{" + body + "})()))"
    r = subprocess.run(["node"], input=src, capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(r.stderr[-2000:] or r.stdout[-2000:])
    return json.loads(r.stdout)


def grid_ok(values, tol=2.0):
    """Values sit on one pitch. A missing row (easement, flood) leaves a double gap."""
    vals = sorted(set(round(float(v), 1) for v in values))
    if len(vals) < 2:
        return True
    gaps = [vals[i + 1] - vals[i] for i in range(len(vals) - 1)]
    base = min(gaps)
    if base < 1:
        return False
    return all(abs(g - round(g / base) * base) <= tol for g in gaps)


@unittest.skipUnless(shutil.which("node"), "node missing")
class Campus(unittest.TestCase):
    def test_rectangle_is_aligned_campus(self):
        r = js(
            """
const R=[[0,0],[3200,0],[3200,2000],[0,2000],[0,0]];
const I=Object.assign({},TF_DEF.land,{halls:24,hallW:250,hallL:800,setF:50,setS:40,setR:40,genAc:0.6,subAc:2,park:12,sw:'off',phases:2});
const tx=[{L:[[-200,2200],[3400,2180]],kv:345}];
const a=tfDC(R,I,{tx,lowPt:[2900,180]});
const b=tfDC(R,I,{tx,lowPt:[2900,180]});
const halls=a.halls.filter(h=>!h.v);
const touch=(g,h)=>{if(!g||!h)return false;const x=Math.min(g[0]+g[2],h[0]+h[2])-Math.max(g[0],h[0]),y=Math.min(g[1]+g[3],h[1]+h[3])-Math.max(g[1],h[1]);return x>20&&Math.abs(g[1]+g[3]-h[1])<1.5||y>20&&Math.abs(g[0]+g[2]-h[0])<1.5};
let bad=0; a.halls.forEach(h=>{[h.hall,h.gen,h.chill].filter(Boolean).forEach(R2=>{const [x,y,w,hh]=R2;for(const p of [[x,y],[x+w,y],[x+w,y+hh],[x,y+hh]]){const q=a.C.un(p);if(!tfIn(q[0],q[1],R))bad++;for(let i=1;i<R.length;i++)if(tfSD(q[0],q[1],R[i-1],R[i])<39)bad++}})});
const subC=a.sub?[a.sub[0]+a.sub[2]/2,a.sub[1]+a.sub[3]/2]:null;
const schemes=tfSchemes(R,Object.assign({},TF_DEF.land,{sw:'off'}),{});
return {n:a.n,same:JSON.stringify(a.halls.map(h=>h.hall.map(v=>Math.round(v))))===JSON.stringify(b.halls.map(h=>h.hall.map(v=>Math.round(v)))),
 xs:halls.map(h=>h.hall[0]),ys:halls.map(h=>h.hall[1]),loops:a.loops.length,turn:a.turnR,fence:!!(a.fence&&(a.fence.pts||a.fence.segs)),gate:!!(a.fence&&a.fence.gate),
 chill:a.halls.every(h=>h.chill&&touch(h.gen,h.chill)&&touch(h.chill,h.hall)),phases:[...new Set(a.phase)],park:!!a.park,bad,ori:[...new Set(a.halls.map(h=>h.v?1:0))],
 subNorth:subC?subC[1]>1000:false,schemes:schemes.map(s=>s.scheme),nSch:schemes.length};
"""
        )
        self.assertGreaterEqual(r["n"], 8, r)
        self.assertTrue(r["same"], "layout is not deterministic")
        self.assertTrue(grid_ok(r["xs"]), r["xs"])
        self.assertTrue(grid_ok(r["ys"]), r["ys"])
        self.assertGreaterEqual(r["loops"], 1)
        self.assertGreaterEqual(r["turn"], 28)
        self.assertTrue(r["fence"])
        self.assertTrue(r["gate"])
        self.assertTrue(r["chill"])
        self.assertEqual(len(set(r.get("ori") or [0])), 1)
        self.assertEqual(r["phases"], [1, 2])
        self.assertTrue(r["park"])
        self.assertEqual(r["bad"], 0)
        self.assertTrue(r["subNorth"])
        self.assertGreaterEqual(r["nSch"], 2)
        self.assertLessEqual(r["nSch"], 3)
        self.assertIn("A", r["schemes"])

    def test_l_shape_uses_both_legs_on_a_grid(self):
        r = js(
            """
const L=[[0,0],[2600,0],[2600,780],[820,780],[820,2600],[0,2600],[0,0]];
const I=Object.assign({},TF_DEF.land,{halls:20,subAc:0,park:0,setF:40,setS:40,setR:40,sw:'off'});
const r=tfDC(L,I,{});
let bad=0; const legs=new Set();
r.halls.forEach(h=>{const [x,y,w,hh]=h.hall;const c=r.C.un([x+w/2,y+hh/2]);legs.add(c[1]<780?'E':'N');
 for(let i=0;i<=4;i++)for(let j=0;j<=4;j++){const p=r.C.un([x+w*i/4,y+hh*j/4]);if(!tfIn(p[0],p[1],L))bad++}});
const ori=new Set(r.halls.map(h=>h.v?1:0));
const schemes=tfSchemes(L,I,{});
const both=new Set();schemes.forEach(s=>{const q=tfSolve('land',L,s.p,{});(q.halls||[]).forEach(h=>{const p=q.C.un([h.hall[0]+h.hall[2]/2,h.hall[1]+h.hall[3]/2]);both.add(p[1]<780?'E':'N')})});
const xs=r.halls.map(h=>h.v?h.hall[0]:h.hall[1]);
return {n:r.n,bad,legs:[...legs],one:ori.size<=1,both:[...both],xs};
"""
        )
        self.assertGreaterEqual(r["n"], 2, r)
        self.assertEqual(r["bad"], 0)
        self.assertTrue(r["one"], r)
        self.assertEqual(set(r["both"]), {"E", "N"})
        self.assertTrue(grid_ok(r["xs"]))

    def test_diagonal_easement_is_a_hole_in_an_aligned_grid(self):
        r = js(
            """
const R=[[0,0],[2200,0],[2200,2600],[0,2600],[0,0]];
const A=[120,80], B=[2080,2500];
function ld(x,y){const dx=B[0]-A[0],dy=B[1]-A[1];return Math.abs((x-A[0])*dy-(y-A[1])*dx)/Math.hypot(dx,dy)}
const nb=(x,y)=>ld(x,y)<100;
const I=Object.assign({},TF_DEF.land,{halls:20,hallW:250,hallL:800,setF:40,setS:40,setR:40,subAc:0,park:0,sw:'off'});
const cut=tfDC(R,I,{nb,nbKind:(x,y)=>nb(x,y)?1:0});
const open=tfDC(R,I,{});
let hit=0; cut.halls.forEach(h=>[h.hall,h.gen,h.chill].filter(Boolean).forEach(R2=>{const [x,y,w,hh]=R2;
 for(let i=0;i<=4;i++)for(let j=0;j<=4;j++){const p=cut.C.un([x+w*i/4,y+hh*j/4]);if(ld(p[0],p[1])<99)hit++}}));
const ori=new Set(cut.halls.map(h=>h.v?1:0));
const xs=cut.halls.map(h=>h.v?h.hall[0]:h.hall[1]), ys=cut.halls.map(h=>h.v?h.hall[1]:h.hall[0]);
return {cut:cut.n,open:open.n,hit,xs,ys,one:ori.size<=1,ease:cut.build.easement,loops:(cut.loops||[]).length,w:(cut.loops[0]||{}).w};
"""
        )
        self.assertGreater(r["open"], r["cut"], r)
        self.assertGreaterEqual(r["cut"], 6, r)
        self.assertEqual(r["hit"], 0)
        self.assertGreater(r["ease"], 0)
        self.assertTrue(r["one"], r)
        self.assertTrue(grid_ok(r["xs"]) and grid_ok(r["ys"]), r)
        self.assertGreaterEqual(r["loops"], 1)
        self.assertGreaterEqual(r["w"] or 0, 26)

    def test_floodplain_and_low_point_pond(self):
        r = js(
            """
const R=[[0,0],[2800,0],[2800,1800],[0,1800],[0,0]];
const flood=[[1700,1000],[2800,1000],[2800,1800],[1700,1800],[1700,1000]];
const nb=(x,y)=>tfIn(x,y,flood);
const bld=[[900,700],[1100,700],[1100,900],[900,900],[900,700]];
const nb2=(x,y)=>nb(x,y)||tfIn(x,y,bld);
const I=Object.assign({},TF_DEF.land,{halls:16,hallW:250,hallL:800,setF:40,setS:40,setR:40,subAc:0,park:0,sw:'off'});
const pd={ol:220,ow:140,ac:0.7,V:1};
const low=[240,180];
const ctx={nb:nb2,nbKind:(x,y)=>nb(x,y)?2:tfIn(x,y,bld)?7:0,lowPt:low};
const r=tfDC0(R,Object.assign({},I,{_campus:1,rot:0}),ctx,pd);
const build=cvBuildable(r.C,ctx.nbKind,r.pond);
let floodHit=0,bldHit=0;
r.halls.forEach(h=>[h.hall,h.gen,h.chill].filter(Boolean).forEach(R2=>{const [x,y,w,hh]=R2;
 for(let i=0;i<=4;i++)for(let j=0;j<=4;j++){const p=r.C.un([x+w*i/4,y+hh*j/4]);if(tfIn(p[0],p[1],flood))floodHit++;if(tfIn(p[0],p[1],bld))bldHit++}}));
const pc=r.pond?[r.pond[0]+r.pond[2]/2,r.pond[1]+r.pond[3]/2]:null;
const dLow=pc?Math.hypot(pc[0]-low[0],pc[1]-low[1]):1e9, dFar=pc?Math.hypot(pc[0]-2600,pc[1]-1600):0;
return {n:r.n,floodHit,bldHit,floodAc:build.flood,bldAc:build.bld,dLow,dFar,pond:!!r.pond};
"""
        )
        self.assertGreater(r["n"], 0, r)
        self.assertEqual(r["floodHit"], 0)
        self.assertEqual(r["bldHit"], 0)
        self.assertGreater(r["floodAc"], 0)
        self.assertGreater(r["bldAc"], 0)
        self.assertTrue(r["pond"])
        self.assertLess(r["dLow"], r["dFar"])


if __name__ == "__main__":
    unittest.main()
