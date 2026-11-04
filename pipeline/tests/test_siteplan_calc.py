"""Land-first rules on the interactive Site Plan calculator (template.html spCalc/spGrid/spSolve):
no parcel polygon -> BOUNDARY NEEDED (no halls, no MW); with a polygon, public road ROW etc. are deducted before capacity."""
import json, re, subprocess, textwrap
from pathlib import Path

L = (Path(__file__).resolve().parents[1] / 'template.html').read_text().split('\n')
NAMES = 'SP_DEF SP_ET SP_GEN spProj spNB spNBhit spGrid spSolve spNoB spCalc spArea spCx spGasEst spGenInp spGridEst spInside spN spPack spPlantFree spSegD spSub spGridEst0 spGasEst0 spParcel'.split()


def fn(name):
    for i, l in enumerate(L):
        if re.match(r'(async )?function ' + re.escape(name) + r'\(', l) or re.match(r'(const|let) ' + re.escape(name) + r'\b', l):
            out = [l]; j = i + 1
            while j < len(L) and L[j].startswith(' '):
                out.append(L[j]); j += 1
            return '\n'.join(out)
    raise AssertionError('missing ' + name)


SRC = '\n'.join(fn(n) for n in NAMES)
HARN = textwrap.dedent(r'''
const SP={cx:{t1:{caps:{grid_mw:1000,gas_mw:1000}}},ly:{},sd:null},SHX={};const fmt=(v,d)=>(+v).toFixed(d);const esc=x=>String(x);
const s={id:'t1',lat:38.77,lon:-97.63,acres:100,grid_mw:300};
const P=spProj(s.lat,s.lon),h=1043;  // ~100 ac square, ft
const poly=[[-h,-h],[h,-h],[h,h],[-h,h],[-h,-h]].map(P.b);
const inp=Object.assign({},SP_DEF);
const noB=spCalc(s,poly,'square',inp);
const a=spCalc(s,poly,'parcel',inp);
SHX[s.id]={roads:[{L:[[-3000,0],[3000,0]],row:100,name:'W Water Well Rd'}],streams:[],tx:[],flood:[]};
const G=spGrid(poly,inp,s),b=spCalc(s,poly,'parcel',inp,G);
let inRow=false;(b.H||[]).forEach(([i,j,w,hh])=>{for(let y=j;y<j+hh;y++)for(let x=i;x<i+w;x++)if(G.nb[y*G.nx+x]===4)inRow=true});
SP.pd={t1:{deal:{g:{type:'Polygon',coordinates:[poly]}}}};const pr=spParcel(s);
console.log(JSON.stringify({pd:pr&&pr.length,noB:{noB:noB.noB,it:noB.best.it,halls:noB.H.length,top:noB.top.length},
 a:{build:a.G.buildAc,it:a.best.it,halls:a.H.length},nH:b.H.length,b:{build:G.buildAc,nbR:G.nbR,it:b.best.it,inRow}}));
''')


def run():
    out = subprocess.run(['node', '-e', SRC + '\n' + HARN], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().split('\n')[-1])


def test_no_polygon_is_boundary_needed():
    r = run()['noB']
    assert r['noB'] is True and r['it'] is None and r['halls'] == 0 and r['top'] == 0


def test_road_row_deducted_before_capacity():
    r = run()
    assert r['b']['nbR'] > 5  # 100' ROW + setback across ~2,086' frontage
    assert r['b']['build'] < r['a']['build'] - 5
    assert r['b']['it'] <= r['a']['it']
    assert r['a']['it'] > 0 and r['nH'] > 0
    assert not r['b']['inRow']


def test_parcels_doc_polygon_used():
    assert run()['pd'] == 5
