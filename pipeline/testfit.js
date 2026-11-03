// ---- TestFit-style configurator (Site Plan). Pure solvers first (tested in pipeline/tests/test_testfit.py), UI after.
// Units: feet in a local plane (spProj). Rotated frame: rows run along x after rotating the site by -rot.
const TF_DEF={land:{halls:8,hallW:250,hallL:1000,stories:1,storyFt:32,hallMW:12,pue:1.3,subAc:5,genAc:1.5,cool:'air',setF:100,setS:100,setR:100,lane:30,park:40,phases:2,rot:0,subPos:'auto',maxH:'',cov:'',front:'S'},
 storage:{mode:'hy',stories:3,storyFt:11,mW:120,duW:30,aisle:28,office:1200,rv:20,setF:25,setS:25,setR:25,rot:0,effDU:.92,effM:.78,mix5x5:10,mix5x10:25,mix10x10:30,mix10x15:15,mix10x20:15,mix10x30:5,maxH:'',cov:'',front:'S'}};
const TF_UNIT={mix5x5:25,mix5x10:50,mix10x10:100,mix10x15:150,mix10x20:200,mix10x30:300};
const TF_COOL={air:1,liquid:.85,hybrid:.92};// cooling yard factor on generator/mech yard depth
// zoning record (zoning/{siteId}, admin-only) -> solver inputs; null fields mean "use the plan default"
function tfZone(z,co){const v=o=>o&&o.v!=null&&isFinite(+o.v)?+o.v:null,sb=(z&&z.setbacks_ft)||{},tr=(z&&z.treatment)||{};
 const use=co==='storage'?(tr.self_storage||{}).status||(z&&z.storage_use)||null:(tr.data_center||{}).status||(z&&z.dc_use)||(tr.industrial||{}).status||null;
 const okU=use==null?null:/^(permitted|allowed|by.?right|yes)/i.test(use)?1:/^(conditional|special|cup|sup)/i.test(use)?0:-1;
 return {front:v(sb.front),side:v(sb.side),rear:v(sb.rear),maxH:v(z&&z.max_height_ft),cov:v(z&&z.max_lot_coverage_pct),far:v(z&&z.max_far),use,okU,district:z&&(z.district||z.zone_code||z.code)||null,has:!!z}}
// effective inputs: zoning governs where it is stricter (setbacks larger, height/coverage lower); user values otherwise
function tfEff(I,Z){const E=Object.assign({},I),mx=(a,b)=>b==null?+a||0:Math.max(+a||0,b),mn=(a,b)=>a===''||a==null?b:b==null?+a:Math.min(+a,b);
 if(Z){E.setF=mx(I.setF,Z.front);E.setS=mx(I.setS,Z.side);E.setR=mx(I.setR,Z.rear);E.maxH=mn(I.maxH,Z.maxH);E.cov=mn(I.cov,Z.cov);E.far=Z.far}return E}
const tfRot=(p,a)=>{const c=Math.cos(a),s=Math.sin(a);return [p[0]*c-p[1]*s,p[0]*s+p[1]*c]};
function tfArea(R){let a=0;for(let i=0,j=R.length-1;i<R.length;j=i++)a+=(R[j][0]+R[i][0])*(R[j][1]-R[i][1]);return Math.abs(a/2)}
function tfIn(x,y,R){let c=false;for(let i=0,j=R.length-1;i<R.length;j=i++){const [a,b]=R[i],[e,f]=R[j];if((b>y)!==(f>y)&&x<(e-a)*(y-b)/(f-b)+a)c=!c}return c}
function tfSD(x,y,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],l=dx*dx+dy*dy;let t=l?((x-a[0])*dx+(y-a[1])*dy)/l:0;t=Math.max(0,Math.min(1,t));return Math.hypot(a[0]+t*dx-x,a[1]+t*dy-y)}
// site context in the rotated frame. R: local-ft ring; nb: (x,y)->bool no-build test in LOCAL coords
function tfCtx(R,E,nb){const rot=(+E.rot||0)*Math.PI/180,Q=R.map(p=>tfRot(p,-rot)),A=tfArea(R),cx=R.reduce((a,p)=>a+p[0],0)/R.length,cy=R.reduce((a,p)=>a+p[1],0)/R.length;
 const dir={N:[0,1],S:[0,-1],E:[1,0],W:[-1,0]}[E.front||'S']||[0,-1],edges=[];
 for(let i=1;i<R.length;i++){const a=R[i-1],b=R[i];if(a[0]===b[0]&&a[1]===b[1])continue;const mx=(a[0]+b[0])/2-cx,my=(a[1]+b[1])/2-cy,l=Math.hypot(mx,my)||1,d=(mx*dir[0]+my*dir[1])/l;
  edges.push([tfRot(a,-rot),tfRot(b,-rot),d>.7?+E.setF||0:d<-.7?+E.setR||0:+E.setS||0])}
 let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;Q.forEach(([x,y])=>{x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y)});
 const ok=(x,y)=>{if(!tfIn(x,y,Q))return false;for(const [a,b,s] of edges)if(s>0&&tfSD(x,y,a,b)<s)return false;if(nb){const p=tfRot([x,y],rot);if(nb(p[0],p[1]))return false}return true};
 return {rot,Q,A,ok,bb:[x0,y0,x1,y1],un:p=>tfRot(p,rot)}}
// axis-aligned rect [x,y,w,h] in the rotated frame: valid if sampled points are buildable and it clears placed rects (+gap)
function tfRectOK(C,r,placed,gap){const [x,y,w,h]=r;for(const q of placed){const g=q[4]!=null?q[4]:gap;if(x<q[0]+q[2]+g&&x+w+g>q[0]&&y<q[1]+q[3]+g&&y+h+g>q[1])return false}
 const nx=Math.max(1,Math.ceil(w/40)),ny=Math.max(1,Math.ceil(h/40));for(let j=0;j<=ny;j++)for(let i=0;i<=nx;i++)if(!C.ok(x+w*i/nx,y+h*j/ny))return false;return true}
// place one w x h block at the valid position nearest target (rotated-frame point), scanning a 20-ft lattice
function tfPlaceNear(C,w,h,tgt,placed,gap){const [x0,y0,x1,y1]=C.bb,st=Math.max(20,Math.min(w,h)/4);let best=null,bd=1e18;
 for(let y=y0;y+h<=y1;y+=st)for(let x=x0;x+w<=x1;x+=st){const d=Math.hypot(x+w/2-tgt[0],y+h/2-tgt[1]);if(d>=bd)continue;if(tfRectOK(C,[x,y,w,h],placed,gap)){bd=d;best=[x,y,w,h]}}return best}
// rows of blocks (w along x, h along y) with pitch gaps; tries lattice offsets and keeps the arrangement with the most blocks
function tfRows(C,w,h,gx,gy,max,placed,gap){const [x0,y0,x1,y1]=C.bb;let best=[];
 for(const fy of [0,.25,.5,.75])for(const fx of [0,.33,.66]){const out=[],P=placed.slice();
  for(let y=y0+fy*(h+gy);y+h<=y1&&out.length<max;y+=h+gy){let x=x0+fx*(w+gx);while(x+w<=x1&&out.length<max){const r=[x,y,w,h];if(tfRectOK(C,r,P,gap)){out.push(r);P.push(r);x+=w+gx}else x+=Math.max(20,w/10)}}
  if(out.length>best.length)best=out;if(best.length>=max)break}return best}
const tfCorner=(C,pos)=>{const dir={N:[0,1],S:[0,-1],E:[1,0],W:[-1,0],NE:[1,1],NW:[-1,1],SE:[1,-1],SW:[-1,-1]}[pos];if(!dir)return null;
 const [x0,y0,x1,y1]=C.bb,c=C.un([(x0+x1)/2,(y0+y1)/2]),r=Math.hypot(x1-x0,y1-y0);return tfRot([c[0]+dir[0]*r,c[1]+dir[1]*r],-C.rot)};
// ---- data center solve. ctx: {gridMW (site cap, null=unknown), nb, zone(tfZone), linePt (local ft) }
function tfDC(R,I,ctx){ctx=ctx||{};const Z=ctx.zone||null,E=tfEff(I,Z),C=tfCtx(R,E,ctx.nb),site=C.A,warn=[];
 const st=Math.max(1,Math.round(+E.stories||1)),h=st*(+E.storyFt||32);let stE=st;if(E.maxH!==''&&E.maxH!=null&&h>+E.maxH){stE=Math.max(0,Math.floor(+E.maxH/(+E.storyFt||32)));warn.push({k:'height',t:`Design height ${h} ft exceeds the ${E.maxH} ft limit${stE?' · capped at '+stE+' storey':''}`})}
 const placed=[],lane=+E.lane||30,sub=+E.subAc>0?Math.sqrt(+E.subAc*43560):0;let subR=null;
 if(sub){const tgt=E.subPos&&E.subPos!=='auto'?tfCorner(C,E.subPos):ctx.linePt?tfRot(ctx.linePt,-C.rot):[C.bb[2],C.bb[1]];subR=tfPlaceNear(C,sub,sub,tgt,placed,lane);if(subR){subR.push(lane);placed.push(subR)}else warn.push({k:'sub',t:'No room for the substation'})}
 const hw=+E.hallW,hl=+E.hallL,gy=(+E.genAc||0)*43560/hl*(TF_COOL[E.cool]||1),bw=hl,bh=hw+gy;
 const capIT=ctx.gridMW!=null&&ctx.gridMW!==''&&isFinite(ctx.gridMW)?ctx.gridMW/(+E.pue||1.3):null,hallMW=(+E.hallMW||0)*stE/st;
 let want=Math.max(0,Math.round(+E.halls||0));const needCap=capIT!=null&&hallMW>0?Math.ceil(capIT/hallMW-1e-9):want,tgtN=Math.min(want,needCap);
 let covN=1e9;if(E.cov!==''&&E.cov!=null)covN=Math.floor(site*(+E.cov)/100/(hw*hl));if(E.far!=null&&E.far!=='')covN=Math.min(covN,Math.floor(site*(+E.far)/(hw*hl*Math.max(1,stE))));
 const B=stE?tfRows(C,bw,bh,lane,lane,Math.min(tgtN,covN),placed,lane):[];
 const halls=B.map(([x,y,w,hh])=>({hall:[x,y+gy,w,hw],gen:gy>0?[x,y,w,gy]:null}));halls.forEach(o=>{placed.push(o.hall);if(o.gen)placed.push(o.gen)});
 const n=halls.length,itRaw=n*hallMW,it=capIT!=null?Math.min(itRaw,capIT):itRaw,fac=it*(+E.pue||1.3);
 const stalls=Math.round(n*(+E.park||0)),pA=stalls*330;let parkR=null;
 if(pA>0){const pw=Math.max(60,Math.min(600,Math.sqrt(pA*2))),ph=pA/pw;parkR=tfPlaceNear(C,pw,ph,[(C.bb[0]+C.bb[2])/2,C.bb[1]],placed,lane);if(parkR)placed.push(parkR);else warn.push({k:'park',t:'Parking does not fit'})}
 const ph=Math.max(1,Math.round(+E.phases||1)),phase=halls.map((_,i)=>Math.floor(i*ph/Math.max(1,n))+1),phMW=Array.from({length:ph},(_,k)=>Math.min(it,phase.filter(p=>p<=k+1).length*hallMW)).map((v,k,a)=>v-(k?a[k-1]:0));
 const fp=n*hw*hl,cov=site?fp/site:0,far=site?fp*stE/site:0,bind=!stE?'Height':capIT!=null&&itRaw>=capIT-1e-9&&n>=needCap?'Grid cap':n<Math.min(want,needCap)?(n>=covN?'Coverage/FAR':'Land / setbacks / no-build'):'Hall count';
 const circ=[{id:'lane',ok:lane>=26,t:`Fire lane ${lane} ft (IFC aerial access ≥ 26 ft)`},{id:'hose',ok:hw<=300,t:`Hall depth ${hw} ft (≤ 300 ft keeps every wall within 150 ft hose reach of a lane)`}];
 if(Z&&Z.okU===-1)warn.push({k:'use',t:`Zoning ${Z.district||''}: data center ${Z.use||'not listed'}`});else if(Z&&Z.okU===0)warn.push({k:'use',t:`Zoning ${Z.district||''}: data center ${Z.use} (discretionary)`});
 const score=it-(warn.length*.5)-circ.filter(c=>!c.ok).length;
 return {co:'land',C,E,halls,sub:subR,park:parkR,stalls,n,want,needCap,capIT,it,itRaw,fac,hallMW,fp,cov,far,height:stE*(+E.storyFt||32),stories:stE,phase,phMW,bind,warn,circ,site,score,
  k:{it:+it.toFixed(2),fac:+fac.toFixed(2),halls:n,cov:+(cov*100).toFixed(1),far:+far.toFixed(3),stalls}}}
// ---- self-storage solve
function tfST(R,I,ctx){ctx=ctx||{};const Z=ctx.zone||null,E=tfEff(I,Z),C=tfCtx(R,E,ctx.nb),site=C.A,warn=[],placed=[],aisle=+E.aisle||28;
 let st=Math.max(1,Math.round(+E.stories||1));const h=st*(+E.storyFt||11)+4;if(E.maxH!==''&&E.maxH!=null&&h>+E.maxH){st=Math.max(1,Math.floor((+E.maxH-4)/(+E.storyFt||11)));warn.push({k:'height',t:`Design height ${h} ft exceeds the ${E.maxH} ft limit · ${st} storeys`})}
 const covMax=E.cov!==''&&E.cov!=null?site*(+E.cov)/100:1e18;let fpU=0,mu=null,office=null;const du=[],rv=[];
 if(E.mode==='mu'||E.mode==='hy'){const d=+E.mW||120;for(const L of [480,400,320,260,200,160]){if(L*d>covMax)continue;mu=tfPlaceNear(C,L,d,[(C.bb[0]+C.bb[2])/2,C.bb[1]],placed,aisle);if(mu)break}if(mu){placed.push(mu);fpU+=mu[2]*mu[3]}}
 if(+E.office>0&&!mu){const ow=40,ol=Math.max(30,+E.office/ow);office=tfPlaceNear(C,ol,ow,[C.bb[0],C.bb[1]],placed,aisle);if(office){placed.push(office);fpU+=ol*ow}}
 if(E.mode==='du'||E.mode==='hy'){const d=+E.duW||30,[x0,y0,x1,y1]=C.bb;let best=[];
  for(const fy of [0,.3,.6]){const out=[],P=placed.slice();for(let y=y0+fy*(d+aisle);y+d<=y1;y+=d+aisle){let x=x0;while(x<x1){let L=0;while(x+L+10<=x1&&tfRectOK(C,[x,y,L+10,d],P,aisle))L+=10;if(L>=60){const r=[x,y,L,d];out.push(r);P.push(r);x+=L+aisle}else x+=20}}
   if(out.reduce((a,r)=>a+r[2]*r[3],0)>best.reduce((a,r)=>a+r[2]*r[3],0))best=out}
  for(const r of best){const a=r[2]*r[3];if(fpU+a>covMax){const L=Math.floor((covMax-fpU)/r[3]/10)*10;if(L>=60){r[2]=L;du.push(r);fpU+=L*r[3]}break}du.push(r);placed.push(r);fpU+=a}}
 for(let k=0;k<(+E.rv||0);){const r=tfPlaceNear(C,12*Math.min(10,(+E.rv)-k),40,[C.bb[2],C.bb[3]],placed,aisle);if(!r)break;rv.push(r);placed.push(r);k+=Math.round(r[2]/12)}
 const rvN=rv.reduce((a,r)=>a+Math.round(r[2]/12),0);if(rvN<(+E.rv||0))warn.push({k:'rv',t:`RV/boat: ${rvN} of ${E.rv} stalls fit`});
 const duSf=du.reduce((a,r)=>a+r[2]*r[3],0),muSf=mu?mu[2]*mu[3]:0,offSf=+E.office||0,nrsf=Math.max(0,duSf*(+E.effDU||.92)+muSf*st*(+E.effM||.78)-(mu?offSf:0));
 const mk=Object.keys(TF_UNIT),tot=mk.reduce((a,k)=>a+(+E[k]||0),0)||1,avg=mk.reduce((a,k)=>a+TF_UNIT[k]*(+E[k]||0)/tot,0),units=Math.round(nrsf/avg);
 const mix=mk.map(k=>[k.slice(3),Math.round(units*(+E[k]||0)/tot)]),cov=site?fpU/site:0;
 if(Z&&Z.okU===-1)warn.push({k:'use',t:`Zoning ${Z.district||''}: self-storage ${Z.use||'not listed'}`});else if(Z&&Z.okU===0)warn.push({k:'use',t:`Zoning ${Z.district||''}: self-storage ${Z.use} (discretionary)`});
 const circ=[{id:'aisle',ok:aisle>=26,t:`Drive aisle ${aisle} ft (fire access ≥ 26 ft; 10x30 trucks need ~28 ft)`}];
 const bind=fpU>=covMax-1?'Coverage':mu&&st<(+E.stories||1)?'Height':'Setbacks / site shape';
 return {co:'storage',C,E,mu,du,office,rv,rvN,stories:st,nrsf,units,mix,avg,duSf,muSf,gsf:duSf+muSf*st,cov,site,bind,warn,circ,score:nrsf/1000-warn.length*2,
  k:{nrsf:Math.round(nrsf),units,cov:+(cov*100).toFixed(1),rv:rvN,gsf:Math.round(duSf+muSf*st)}}}
function tfSolve(co,R,I,ctx){return co==='storage'?tfST(R,I,ctx):tfDC(R,I,ctx)}
// option generator: sweep orientation and prototype sizes; rank by the company KPI
function tfGen(co,R,I,ctx){const O=[],seen=new Set(),rots=[0,15,30,45,60,75,90,105,120,135,150,165];
 const vs=co==='storage'?[{mode:'hy'},{mode:'du'},{mode:'mu'},{mode:'hy',stories:Math.max(1,(+I.stories||3)-1)}]:[{},{hallW:200,hallL:800},{hallW:300,hallL:1200},{hallW:250,hallL:600}];
 for(const v of vs)for(const rot of rots){const p=Object.assign({},I,v,{rot});if(co==='land')p.halls=Math.max(+I.halls||0,40);const r=tfSolve(co,R,p,ctx);
  const key=JSON.stringify(r.k);if(seen.has(key))continue;seen.add(key);if(co==='land')p.halls=r.n;O.push({p,k:r.k,score:co==='storage'?r.k.nrsf-r.warn.length*500:r.it*100-r.n*.1,warn:r.warn.length,bind:r.bind})}
 return O.sort((a,b)=>b.score-a.score).slice(0,8)}
// ---- chat-to-modify: rule parser (always available) -> {ops:[{k,v}|{k,d}], goal, reply}; same shape as the LLM endpoint (TF_EDIT_SCHEMA)
const TF_NUMW={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,single:1,second:2,third:3,fourth:4,a:1,an:1,another:1};
function tfParse(text,co,I){const t=' '+String(text||'').toLowerCase().replace(/[,;]/g,' ').replace(/\s+/g,' ')+' ',ops=[],say=[];let goal=null;
 const num=re=>{const m=t.match(re);if(!m)return null;const v=m[1];return v in TF_NUMW?TF_NUMW[v]:parseFloat(v)},N='(\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|single|second|third|fourth|a|an|another)';
 const set=(k,v,w)=>{ops.push({k,v});say.push(w)},dl=(k,d,w)=>{ops.push({k,d});say.push(w)},cnt=(k)=>+I[k]||0;
 const inc=/\b(increase|raise|bump|widen|grow|more|bigger|larger)\b/.test(t),dec=/\b(decrease|reduce|lower|shrink|less|smaller|fewer|narrow)\b/.test(t);
 // setbacks
 let m=t.match(new RegExp('(front|side|rear|back)?\\s*setbacks?\\s*(?:to|=|of|at)?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:ft|feet|\')?'))||t.match(/(front|side|rear|back)?\s*setbacks?.*?(?:to|=|of|at|by)\s*(\d+(?:\.\d+)?)/);
 if(m){const v=+m[2],w=m[1]==='back'?'rear':m[1],by=/\bby\b/.test(t),K=w?['set'+w[0].toUpperCase()]:['setF','setS','setR'];K.forEach(k=>by?dl(k,inc||!dec?v:-v,''):set(k,v,''));say.splice(-K.length,K.length,`${w||'All'} setbacks ${by?(dec?'-':'+'):'→ '}${v} ft`)}
 // substation position
 m=t.match(/\b(?:substation|sub)\b.*?\b(north|south|east|west)?[\s-]*(north|south|east|west|ne|nw|se|sw|n|s|e|w)\b(?:\s*corner)?/);
 if(co!=='storage'&&m&&/\b(move|put|place|locate|shift)\b/.test(t)){const c=(m[1]&&m[1]!==m[2]?m[1][0]+m[2][0]:m[2].length>2?m[2][0]:m[2]).toUpperCase();set('subPos',c,`Substation → ${c}`)}
 if(co!=='storage'&&(m=t.match(/(\d+(?:\.\d+)?)\s*(?:ac|acre)s?\s*substation|substation.*?(\d+(?:\.\d+)?)\s*(?:ac|acre)/)))set('subAc',+(m[1]||m[2]),`Substation ${m[1]||m[2]} ac`);
 if(co!=='storage'){
  if((m=t.match(new RegExp('\\b(?:add|plus)\\s+(?:a\\s+|an\\s+)?'+N+'?\\s*(?:more\\s+)?(?:data\\s+)?halls?\\b'))))dl('halls',!m[1]||/second|third|fourth|another/.test(m[1])?1:(TF_NUMW[m[1]]||+m[1]),'');
  else if((m=t.match(new RegExp('\\b(?:remove|drop|delete)\\s+'+N+'?\\s*(?:data\\s+)?halls?'))))dl('halls',-(m[1]?(TF_NUMW[m[1]]||+m[1]):1),'');
  else if((m=t.match(/(\d+)\s*(?:data\s+)?halls?\b/))&&!/\bmw\b.*hall|per hall/.test(t))set('halls',+m[1],`${m[1]} halls`);
  if(ops.length&&ops[ops.length-1].k==='halls'&&ops[ops.length-1].d!=null)say[say.length-1]=`Halls ${ops[ops.length-1].d>0?'+':''}${ops[ops.length-1].d}`;
  if((m=t.match(/(\d+(?:\.\d+)?)\s*mw\s*(?:per|\/|each)\s*hall|hall.*?(\d+(?:\.\d+)?)\s*mw\s*(?:each|per)/)))set('hallMW',+(m[1]||m[2]),`${m[1]||m[2]} MW per hall`);
  if((m=t.match(/pue\s*(?:to|=|of|at)?\s*(\d(?:\.\d+)?)/)))set('pue',+m[1],`PUE ${m[1]}`);
  if((m=t.match(/(\d+)\s*(?:ft|feet|')?\s*(?:x|by|×)\s*(\d+)\s*(?:ft|feet|')?\s*halls?|halls?\s*(\d+)\s*(?:x|by|×)\s*(\d+)/))){const a=+(m[1]||m[3]),b=+(m[2]||m[4]);set('hallW',Math.min(a,b),'');set('hallL',Math.max(a,b),'');say.splice(-2,2,`Halls ${Math.min(a,b)}×${Math.max(a,b)} ft`)}
  if(/\b(liquid|hybrid|air)[\s-]*cool/.test(t)||/cooling.*\b(liquid|hybrid|air)\b/.test(t)){const c=(t.match(/\b(liquid|hybrid|air)\b/)||[])[1];set('cool',c,`Cooling ${c}`)}
  if((m=t.match(/(?:fire\s*lanes?|drive\s*lanes?|lanes?)\s*(?:to|=|of|at)?\s*(\d+)/)))set('lane',+m[1],`Fire lanes ${m[1]} ft`);
  if((m=t.match(/(\d+)\s*(?:parking\s*)?(?:stalls|spaces)\s*(?:per|\/)\s*hall/)))set('park',+m[1],`Parking ${m[1]}/hall`);
  if((m=t.match(new RegExp(N+'\\s*(?:storey|story|stories|storeys|floors?)\\b'))))set('stories',TF_NUMW[m[1]]||+m[1],`${m[1]} storeys`);
  if((m=t.match(/generator\s*(?:yard)?s?\s*(?:to|=|of|at)?\s*(\d+(?:\.\d+)?)\s*(?:ac|acre)/)))set('genAc',+m[1],`Generator yard ${m[1]} ac/hall`);
 }else{
  if(/all[\s-]*drive[\s-]*up|drive[\s-]*up only|only drive[\s-]*up|switch to drive[\s-]*up/.test(t))set('mode','du','All drive-up');
  else if(/all[\s-]*(?:climate|multi)|multi[\s-]*stor(?:e)?y only|climate[\s-]*controlled only|switch to (?:climate|multi)/.test(t))set('mode','mu','All multi-storey climate-controlled');
  else if(/hybrid|mix of drive|both/.test(t))set('mode','hy','Hybrid');
  if((m=t.match(new RegExp(N+'\\s*(?:storey|story|stories|storeys|floors?)\\b'))))set('stories',TF_NUMW[m[1]]||+m[1],`${m[1]} storeys`);
  if((m=t.match(/aisles?\s*(?:to|=|of|at)?\s*(\d+)/)))set('aisle',+m[1],`Aisles ${m[1]} ft`);
  if((m=t.match(/office\s*(?:to|=|of|at)?\s*(\d+)/)))set('office',+m[1],`Office ${m[1]} sf`);
  if((m=t.match(/(\d+)\s*(?:rv|boat|rv\/boat)[\s\/a-z]*(?:stalls|spaces|parking)?/))||(m=t.match(/(?:rv|boat)[\s\/a-z]*?(?:to|=)\s*(\d+)/)))set('rv',+m[1],`RV/boat ${m[1]} stalls`);
  else if(/\b(no|remove|drop)\s*(?:the\s*)?(rv|boat)/.test(t))set('rv',0,'No RV/boat');
  t.replace(/(\d+)\s*%\s*(?:of\s*)?(5x5|5x10|10x10|10x15|10x20|10x30)|(5x5|5x10|10x10|10x15|10x20|10x30)\s*(?:to|=|at)?\s*(\d+)\s*%/g,(_,a,b,c,d)=>{set('mix'+(b||c),+(a||d),`${b||c} ${a||d}%`);return _});
 }
 if((m=t.match(/(?:rotate|orient(?:ation)?|angle)\D*(\d+)/)))set('rot',+m[1]%180,`Rows at ${+m[1]%180}°`);
 if((m=t.match(new RegExp(N+'\\s*phases?\\b')))&&co!=='storage')set('phases',TF_NUMW[m[1]]||+m[1],`${TF_NUMW[m[1]]||m[1]} phases`);
 if(/\b(max(?:imi[sz]e)?|maximum|most|optimi[sz]e)\b/.test(t)){goal=co==='storage'?(/unit/.test(t)?'units':'nrsf'):(/mw|power|it|load|capacity/.test(t)||1?'it':'score');say.push(`Optimise for ${goal==='it'?'IT MW':goal==='units'?'unit count':'rentable sq ft'}`)}
 if(/\bundo\b/.test(t))return {ops:[],goal:null,undo:1,reply:'Undone'};
 return {ops,goal,reply:say.length?say.filter(Boolean).join(' · '):"I didn't catch an edit. Try: \"increase setbacks to 100 ft\", \"add a second hall\", \"move the substation to the NW corner\", \"switch to all drive-up\", \"make it 2 phases\"."}}
// apply ops with schema clamping; returns new params
function tfApplyOps(co,I,ops){const S=(typeof TF_EDIT_SCHEMA!=='undefined'?TF_EDIT_SCHEMA.keys[co]:null)||{},P=Object.assign({},I);
 for(const o of ops||[]){const d=S[o.k];if(!d)continue;let v=o.d!=null?(+P[o.k]||0)+(+o.d):o.v;if(d.length>=3){v=+v;if(!isFinite(v))continue;v=Math.max(d[1],Math.min(d[2],v));if(d[3]===1)v=Math.round(v)}else v=String(v);P[o.k]=v}return P}
