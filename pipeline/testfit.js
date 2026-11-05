// ---- TestFit-style configurator (Site Plan). Pure solvers first (tested in pipeline/tests/test_testfit.py), UI after.
// Units: feet in a local plane (spProj). Rotated frame: rows run along x after rotating the site by -rot.
const TF_DEF={land:{halls:8,hallW:250,hallL:1000,stories:1,storyFt:42,hallMW:12,pue:1.3,subAc:5,genAc:1.5,cool:'air',setF:100,setS:100,setR:100,lane:30,park:40,phases:2,rot:0,subPos:'auto',maxH:'',cov:'',front:'S',front2:'',rowDed:0,ueF:15,buf:10,resSide:'',resBuf:50,sw:'on',swRule:'pre',pondD:5,slope:4,imp:'',tgtMW:'',phMW:'',mwBasis:'fac',swPh:'up'},
 storage:{mode:'hy',stories:3,storyFt:11,mW:120,duW:30,aisle:28,office:1200,rv:20,setF:25,setS:25,setR:25,rot:0,effDU:.92,effM:.78,mix5x5:10,mix5x10:25,mix10x10:30,mix10x15:15,mix10x20:15,mix10x30:5,maxH:'',cov:'',front:'S',front2:'',rowDed:0,ueF:15,buf:10,resSide:'',resBuf:25,sw:'on',swRule:'pre',pondD:4,slope:4,imp:''}};
const TF_UNIT={mix5x5:25,mix5x10:50,mix10x10:100,mix10x15:150,mix10x20:200,mix10x30:300};
const TF_COOL={air:1,liquid:.85,hybrid:.92};// cooling yard factor on generator/mech yard depth
// zoning record (zoning/{siteId}, admin-only) -> solver inputs; null fields mean "use the plan default"
function tfZone(z,co){const v=o=>o&&o.v!=null&&isFinite(+o.v)?+o.v:null,sb=(z&&z.setbacks_ft)||{},tr=(z&&z.treatment)||{};
 const use=co==='storage'?(tr.self_storage||{}).status||(z&&z.storage_use)||null:(tr.data_center||{}).status||(z&&z.dc_use)||(tr.industrial||{}).status||null;
 const okU=use==null?null:/^(permitted|allowed|by.?right|yes)/i.test(use)?1:/^(conditional|special|cup|sup)/i.test(use)?0:-1;
 return {front:v(sb.front),side:v(sb.side),rear:v(sb.rear),street2:v(sb.side_street||sb.street_side||sb.corner_side),buf:v(z&&(z.landscape_buffer_ft||z.buffer_ft)),resBuf:v(z&&z.residential_buffer_ft),maxH:v(z&&z.max_height_ft),cov:v(z&&z.max_lot_coverage_pct),far:v(z&&z.max_far),use,okU,district:z&&(z.district||z.zone_code||z.code)||null,has:!!z}}
// effective inputs: zoning governs where it is stricter (setbacks larger, height/coverage lower); user values otherwise
function tfEff(I,Z){const E=Object.assign({},I),mx=(a,b)=>b==null?+a||0:Math.max(+a||0,b),mn=(a,b)=>a===''||a==null?b:b==null?+a:Math.min(+a,b);
 if(Z){E.setF=mx(I.setF,Z.front);E.setS=mx(I.setS,Z.side);E.setR=mx(I.setR,Z.rear);if(Z.street2!=null)E.set2=mx(I.setF,Z.street2);if(Z.buf!=null)E.buf=mx(I.buf,Z.buf);if(Z.resBuf!=null)E.resBuf=mx(I.resBuf,Z.resBuf);E.maxH=mn(I.maxH,Z.maxH);E.cov=mn(I.cov,Z.cov);E.far=Z.far}return E}
const tfRot=(p,a)=>{const c=Math.cos(a),s=Math.sin(a);return [p[0]*c-p[1]*s,p[0]*s+p[1]*c]};
function tfArea(R){let a=0;for(let i=0,j=R.length-1;i<R.length;j=i++)a+=(R[j][0]+R[i][0])*(R[j][1]-R[i][1]);return Math.abs(a/2)}
function tfIn(x,y,R){let c=false;for(let i=0,j=R.length-1;i<R.length;j=i++){const [a,b]=R[i],[e,f]=R[j];if((b>y)!==(f>y)&&x<(e-a)*(y-b)/(f-b)+a)c=!c}return c}
function tfSD(x,y,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],l=dx*dx+dy*dy;let t=l?((x-a[0])*dx+(y-a[1])*dy)/l:0;t=Math.max(0,Math.min(1,t));return Math.hypot(a[0]+t*dx-x,a[1]+t*dy-y)}
// site context in the rotated frame. R: local-ft ring; nb: (x,y)->bool no-build test in LOCAL coords
function tfCtx(R,E,nb){const rot=(+E.rot||0)*Math.PI/180,Q=R.map(p=>tfRot(p,-rot)),A=tfArea(R),cx=R.reduce((a,p)=>a+p[0],0)/R.length,cy=R.reduce((a,p)=>a+p[1],0)/R.length;
 const dir=CV_DIR[E.front||'S']||[0,-1],edges=[],D=[],H=[],W=[];
 for(let i=1;i<R.length;i++){const a=R[i-1],b=R[i];if(a[0]===b[0]&&a[1]===b[1]){D.push(0);H.push(0);W.push(0);continue}const mx=(a[0]+b[0])/2-cx,my=(a[1]+b[1])/2-cy,l=Math.hypot(mx,my)||1,dn=v=>v?(mx*v[0]+my*v[1])/l:0,d=dn(dir);
  const k=cvEdgeSet(E,d,dn);if(k.kind==='front2'&&E.set2!=null)k.s=k.row+Math.max(+E.set2,k.ue,k.buf);edges.push([tfRot(a,-rot),tfRot(b,-rot),k.s,k.h,k]);D.push(k.s);H.push(k.h);W.push(k.row)}
 let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;Q.forEach(([x,y])=>{x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y)});
 const nbAt=(x,y)=>{if(!nb)return false;const p=tfRot([x,y],rot);return nb(p[0],p[1])};
 const ok=(x,y)=>{if(!tfIn(x,y,Q))return false;for(const [a,b,s] of edges)if(s>0&&tfSD(x,y,a,b)<s)return false;return !nbAt(x,y)};
 const okP=(x,y)=>{if(!tfIn(x,y,Q))return false;for(const [a,b,,h] of edges)if(h>0&&tfSD(x,y,a,b)<h)return false;return !nbAt(x,y)};
 const edgeAt=(x,y)=>{let inRow=false,inSet=false;for(const [a,b,s,,k] of edges){const d=tfSD(x,y,a,b);if(k.row>0&&d<k.row)inRow=true;if(s>0&&d<s)inSet=true}return {inRow,inSet}};
 return {rot,Q,A,ok,okP,edgeAt,edges,bb:[x0,y0,x1,y1],un:p=>tfRot(p,rot),setRing:cvOffset(Q,D),hardRing:H.some(v=>v>0)?cvOffset(Q,H):null,rowRing:W.some(v=>v>0)?cvOffset(Q,W):null}}
// axis-aligned rect [x,y,w,h] in the rotated frame: valid if sampled points are buildable and it clears placed rects (+gap)
function tfRectOK(C,r,placed,gap){const [x,y,w,h]=r;for(const q of placed){const g=q[4]!=null?q[4]:gap;if(x<q[0]+q[2]+g&&x+w+g>q[0]&&y<q[1]+q[3]+g&&y+h+g>q[1])return false}
 const nx=Math.max(1,Math.ceil(w/40)),ny=Math.max(1,Math.ceil(h/40));for(let j=0;j<=ny;j++)for(let i=0;i<=nx;i++)if(!(C.okX||C.ok)(x+w*i/nx,y+h*j/ny))return false;return true}
// place one w x h block at the valid position nearest target (rotated-frame point), scanning a 20-ft lattice
function tfPlaceNear(C,w,h,tgt,placed,gap){const [x0,y0,x1,y1]=C.bb,st=Math.max(20,Math.min(w,h)/4);let best=null,bd=1e18;
 for(let y=y0;y+h<=y1;y+=st)for(let x=x0;x+w<=x1;x+=st){const d=Math.hypot(x+w/2-tgt[0],y+h/2-tgt[1]);if(d>=bd)continue;if(tfRectOK(C,[x,y,w,h],placed,gap)){bd=d;best=[x,y,w,h]}}return best}
// rows of blocks (w along x, h along y) with pitch gaps; tries lattice offsets and keeps the arrangement with the most blocks
function tfRows(C,w,h,gx,gy,max,placed,gap){const [x0,y0,x1,y1]=C.bb;let best=[];
 for(const fy of [0,.25,.5,.75])for(const fx of [0,.33,.66]){const out=[],P=placed.slice();
  for(let y=y0+fy*(h+gy);y+h<=y1&&out.length<max;y+=h+gy){let x=x0+fx*(w+gx);while(x+w<=x1&&out.length<max){const r=[x,y,w,h];if(tfRectOK(C,r,P,gap)){out.push(r);P.push(r);x+=w+gx}else x+=Math.max(20,w/10)}}
  if(out.length>best.length)best=out;if(best.length>=max)break}return best}
// first-fit scan (bottom-up, left-right) on a fine lattice: fills each leg of L-shaped / irregular parcels independently
function tfGreedy(C,w,h,gx,gy,max,placed,gap,rot2){const [x0,y0,x1,y1]=C.bb,st=Math.max(20,Math.min(w,h)/8),out=[],P=placed.slice();
 for(let y=y0;y+h<=y1&&out.length<max;y+=st)for(let x=x0;x+w<=x1&&out.length<max;x+=st){let hit=0;for(const [ww,hh,v] of (rot2?[[w,h,0],[h,w,1]]:[[w,h,0]]))if(y+hh<=y1&&x+ww<=x1){const r=[x,y,ww,hh];if(tfRectOK(C,r,P,Math.max(gap,gx,gy))){if(v)r.v=1;out.push(r);P.push(r);x+=ww;hit=1;break}}}return out}
const tfCorner=(C,pos)=>{const dir={N:[0,1],S:[0,-1],E:[1,0],W:[-1,0],NE:[1,1],NW:[-1,1],SE:[1,-1],SW:[-1,-1]}[pos];if(!dir)return null;
 const [x0,y0,x1,y1]=C.bb,c=C.un([(x0+x1)/2,(y0+y1)/2]),r=Math.hypot(x1-x0,y1-y0);return tfRot([c[0]+dir[0]*r,c[1]+dir[1]*r],-C.rot)};
// ---- data center solve. ctx: {gridMW (site cap, null=unknown), nb, nbKind, zone(tfZone), linePt, lowPt (local ft), faa (cvFAA), cv:{pf,hsg,dem}}
// height limit = min(zoning, FAA Part 77 obstruction surface); returns {lim, why}
function tfHLim(E,faa){const z=E.maxH===''||E.maxH==null?null:+E.maxH,f=faa&&faa.cap!=null?faa.cap:null;if(z==null&&f==null)return {lim:null,why:''};return f!=null&&(z==null||f<z)?{lim:f,why:'FAA Part 77'}:{lim:z,why:'zoning'}}
function tfPond(C,pd,ctx,placed){if(!pd)return null;const C2=Object.assign({},C,{okX:C.okP}),tgt=ctx.lowPt?tfRot(ctx.lowPt,-C.rot):[(C.bb[0]+C.bb[2])/2,C.bb[1]];let best=null,bd=1e18;
 for(const [w,h] of [[pd.ol,pd.ow],[pd.ow,pd.ol]]){const r=tfPlaceNear(C2,w,h,tgt,placed,30);if(r){const d=Math.hypot(r[0]+r[2]/2-tgt[0],r[1]+r[3]/2-tgt[1]);if(d<bd){bd=d;best=r}}}if(best){best.push(30);placed.push(best)}return best}
function tfDC0(R,I,ctx,pd){ctx=ctx||{};const Z=ctx.zone||null,E=tfEff(I,Z),C=tfCtx(R,E,ctx.nb),site=C.A,warn=[],sf=+E.storyFt||42,HL=tfHLim(E,ctx.faa);
 const st=Math.max(1,Math.round(+E.stories||1)),h=st*sf;let stE=st;if(HL.lim!=null&&h>HL.lim){stE=Math.max(1,Math.floor(HL.lim/sf));warn.push({k:'height',t:`Design height ${h} ft exceeds the ${Math.round(HL.lim)} ft ${HL.why} limit${stE*sf>HL.lim?' · '+stE*sf+' ft hall needs a height variance':' · capped at '+stE+' storey'}`})}
 const placed=[],lane=+E.lane||30,sub=+E.subAc>0?Math.sqrt(+E.subAc*43560):0;let subR=null;
 let pond=E._pondLast?null:tfPond(C,pd,ctx,placed);if(pd&&!pond&&!E._pondLast)warn.push({k:'pond',t:`Detention pond (${(pd.ac).toFixed(1)} ac) does not fit outside setbacks/no-build`});
 if(sub){const tgt=E.subPos&&E.subPos!=='auto'?tfCorner(C,E.subPos):ctx.linePt?tfRot(ctx.linePt,-C.rot):[C.bb[2],C.bb[1]];subR=tfPlaceNear(C,sub,sub,tgt,placed,lane);if(subR){subR.push(lane);placed.push(subR)}else warn.push({k:'sub',t:'No room for the substation'})}
 const hw=+E.hallW,hl=+E.hallL,gy=(+E.genAc||0)*43560/hl*(TF_COOL[E.cool]||1),bw=hl,bh=hw+gy,pue=+E.pue||1.3;
 const capIT=ctx.gridMW!=null&&ctx.gridMW!==''&&isFinite(ctx.gridMW)?ctx.gridMW/pue:null,hallMW=(+E.hallMW||0)*stE/st;
 const T=cvPhaseTargets(E),Tsum=T?T.reduce((a,b)=>a+b,0):0;
 let want=T&&hallMW>0?Math.ceil(Tsum/hallMW-1e-9):Math.max(0,Math.round(+E.halls||0));const needCap=capIT!=null&&hallMW>0?Math.ceil(capIT/hallMW-1e-9):want,tgtN=T?want:Math.min(want,needCap);
 let covN=1e9;if(E.cov!==''&&E.cov!=null)covN=Math.floor(site*(+E.cov)/100/(hw*hl));if(E.far!=null&&E.far!=='')covN=Math.min(covN,Math.floor(site*(+E.far)/(hw*hl*Math.max(1,stE))));
 const B=stE?(E._pack==='greedy'||E._pack==='mixed'?tfGreedy:tfRows)(C,bw,bh,lane,lane,Math.min(tgtN,covN),placed,lane,E._pack==='mixed'):[];
 // order halls outward from the substation (else the front entry) so phase 1 is compact and later phases extend away from it
 const ent=(()=>{const f=C.edges.find(e=>e[4].kind==='front');if(!f)return [(C.bb[0]+C.bb[2])/2,C.bb[1]];return [(f[0][0]+f[1][0])/2,(f[0][1]+f[1][1])/2]})(),org=subR?[subR[0]+subR[2]/2,subR[1]+subR[3]/2]:ent;
 const cen=r=>[r[0]+r[2]/2,r[1]+r[3]/2],dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);B.sort((a,b)=>dist(cen(a),org)-dist(cen(b),org));
 const halls=B.map(b=>{const [x,y,w,hh]=b;return b.v?{hall:[x+gy,y,hw,hh],gen:gy>0?[x,y,gy,hh]:null,v:1}:{hall:[x,y+gy,w,hw],gen:gy>0?[x,y,w,gy]:null}});halls.forEach(o=>{placed.push(o.hall);if(o.gen)placed.push(o.gen)});
 if(E._pondLast&&pd){pond=tfPond(C,pd,ctx,placed);if(!pond)warn.push({k:'pond',t:`Detention pond (${(pd.ac).toFixed(1)} ac) does not fit outside setbacks/no-build`})}
 const n=halls.length,itRaw=n*hallMW,it=capIT!=null?Math.min(itRaw,capIT):itRaw,fac=it*pue;
 const stalls=Math.round(n*(+E.park||0)),pA=stalls*330;let parkR=null;
 if(pA>0){const pw=Math.max(60,Math.min(600,Math.sqrt(pA*2))),ph=pA/pw;parkR=tfPlaceNear(C,pw,ph,ent,placed,lane);if(parkR)placed.push(parkR);else warn.push({k:'park',t:'Parking does not fit'})}
 const ph=T?T.length:Math.max(1,Math.round(+E.phases||1));let phase;
 if(T){let cum=0;const nk=T.map((t,k)=>{cum+=t;const q=cum/hallMW;return k===T.length-1?Math.ceil(q-1e-9):Math.max(k+1,Math.round(q))});phase=halls.map((_,i)=>{const k=nk.findIndex(v=>i<v);return (k<0?ph-1:k)+1})}
 else phase=halls.map((_,i)=>Math.floor(i*ph/Math.max(1,n))+1);
 const phMW=Array.from({length:ph},(_,k)=>Math.min(it,phase.filter(p=>p<=k+1).length*hallMW)).map((v,k,a)=>v-(k?a[k-1]:0));
 // per-phase program: halls, built IT, target, facility MW, cumulative, grid status, acres, road / MV corridor LF
 const rows=[];let cIT=0,cT=0,prevC=[ent];const gMW=ctx.gridMW!=null&&ctx.gridMW!==''&&isFinite(ctx.gridMW)?+ctx.gridMW:null;
 for(let k=1;k<=ph;k++){const H=halls.filter((_,i)=>phase[i]===k),itB=H.length*hallMW,tg=T?T[k-1]:null;cIT+=itB;cT+=tg||0;const fc=cIT*pue;
  const ftp=H.reduce((a,o)=>a+o.hall[2]*o.hall[3]+(o.gen?o.gen[2]*o.gen[3]:0)+lane*(o.hall[2]+o.hall[3]+(o.gen?o.gen[3]:0)),0)+(parkR?parkR[2]*parkR[3]*H.length/Math.max(1,n):0)+(k===1&&subR?subR[2]*subR[3]:0)+(k===1&&pond&&E.swPh!=='phase'?pond[2]*pond[3]:0);
  const cc=H.length?[H.reduce((a,o)=>a+o.hall[0]+o.hall[2]/2,0)/H.length,H.reduce((a,o)=>a+o.hall[1]+o.hall[3]/2,0)/H.length]:null;
  const road=H.reduce((a,o)=>a+o.hall[2]+o.hall[3],0)+(cc?Math.min(...prevC.map(p=>dist(p,cc))):0),util=cc&&subR?dist(cen(subR),cc):0;if(cc)prevC.push(cc);
  rows.push({k,halls:H.length,itB,tgt:tg==null?null:tg,fac:itB*pue,cumIT:cIT,cumFac:fc,short:T?Math.max(0,cT-cIT):0,grid:gMW==null?null:fc<=gMW+1e-6,ac:ftp/43560,road,util})}
 const firstOver=rows.find(r=>r.grid===false);if(firstOver)warn.push({k:'grid',t:`Phase ${firstOver.k} brings the site to ${firstOver.cumFac.toFixed(1)} MW facility, above the ${gMW} MW grid cap: needs a utility upgrade before it can energize`});
 const fp=n*hw*hl,cov=site?fp/site:0,far=site?fp*stE/site:0;
 let bind=!stE?'Height':T?(n<want?(n>=covN?'Coverage/FAR':pd&&pond?'Land (setbacks / no-build / detention)':'Land / setbacks / no-build'):firstOver?'Grid cap':'Target MW'):capIT!=null&&itRaw>=capIT-1e-9&&n>=needCap?'Grid cap':n<Math.min(want,needCap)?(n>=covN?'Coverage/FAR':'Land / setbacks / no-build'):'Hall count';
 if(T&&n<want)warn.push({k:'land',t:`Land fits ${n} of ${want} halls: ${(itRaw).toFixed(1)} of ${Tsum.toFixed(1)} MW IT target (${bind})`});
 const circ=[{id:'lane',ok:lane>=26,t:`Fire lane ${lane} ft (IFC aerial access ≥ 26 ft)`},{id:'hose',ok:hw<=300,t:`Hall depth ${hw} ft (≤ 300 ft keeps every wall within 150 ft hose reach of a lane)`}];
 if(Z&&Z.okU===-1)warn.push({k:'use',t:`Zoning ${Z.district||''}: data center ${String(Z.use||'not listed').replace(/_/g,' ')}`});else if(Z&&Z.okU===0)warn.push({k:'use',t:`Zoning ${Z.district||''}: data center ${Z.use} (discretionary)`});
 const score=it-(warn.length*.5)-circ.filter(c=>!c.ok).length;
 return {co:'land',C,E,halls,sub:subR,park:parkR,pond,stalls,n,want,needCap,capIT,it,itRaw,fac,hallMW,fp,cov,far,height:stE*sf,stories:stE,hlim:HL,phase,phMW,rows,T,Tsum,ent,bind,warn,circ,site,score,
  k:{it:+it.toFixed(2),fac:+fac.toFixed(2),halls:n,cov:+(cov*100).toFixed(1),far:+far.toFixed(3),stalls,itLand:+itRaw.toFixed(2)}}}
// civil wrapper: size the pond from the first layout's impervious cover, place it at the DEM low point, re-solve (≤2 passes)
function tfCivil(co,solve0,R,I,ctx){ctx=ctx||{};const cv=ctx.cv||{},on=I.sw!=='off'&&cv.pf;if(!on){const r=solve0(R,I,ctx,null);return tfCivilAttach(r,ctx,null)}
 const sz=r=>{const imp=I.imp!==''&&I.imp!=null&&isFinite(I.imp)?+I.imp/100:cvImp(r),dm=cv.demStats;return cvStorm({A:r.site/43560,imp,hsg:cv.hsg,pf:cv.pf,relief:dm?dm.relief:null,L:dm?Math.max(dm.L*1.1,Math.sqrt(r.site)):null,rule:I.swRule})};
 let pd=ctx.pondFix||null,r,sw;if(pd){r=solve0(R,I,ctx,pd);return tfCivilAttach(r,ctx,sz(r))}
 r=solve0(R,I,ctx,null);sw=sz(r);for(let it=0;it<2&&sw;it++){pd=cvPond(sw.Vdes*1.05,I.pondD,I.slope,1);r=solve0(R,I,ctx,pd);sw=sz(r);if(!pd||sw.Vdes<=pd.V*1.001)break}
 return tfCivilAttach(r,ctx,sw,pd)}
function tfCivilAttach(r,ctx,sw,pd){const cv=ctx.cv||{};r.sw=sw;r.pd=pd||null;r.build=cvBuildable(r.C,ctx.nbKind,r.pond);r.grade=cv.dem?cvGrade(Object.assign(r,{pond:r.pond?Object.assign([],r.pond,{exc:pd?pd.exc:0,area:pd?pd.area:0}):null}),cv.dem):null;
 r.hgt=cvHeight(r.E.maxH,ctx.faa,r.co==='land'?r.height:r.stories*(+r.E.storyFt||11)+4);r.hgt.lim2=r.hlim;
 if(sw&&r.pond)r.k.pondAc=+(r.pond[2]*r.pond[3]/43560).toFixed(2);if(sw)r.k.detAcFt=+sw.Vac.toFixed(2);r.k.netAc=+r.build.net.toFixed(1);
 if(r.co==='land'&&r.rows&&sw){const all=r.halls;r.rows.forEach(row=>{const keep=all.filter((_,i)=>r.phase[i]<=row.k),rr=Object.assign({},r,{halls:keep,park:row.k===r.rows.length?r.park:null});const imp=r.E.imp!==''&&r.E.imp!=null&&isFinite(r.E.imp)?+r.E.imp/100*(keep.length/Math.max(1,all.length)):cvImp(rr);
  const s2=cvStorm({A:sw.A,imp,hsg:cv.hsg,pf:cv.pf,relief:sw.L*sw.S,L:sw.L,rule:r.E.swRule});row.detCum=s2?s2.Vdes:0;row.imp=imp});r.rows.forEach((row,i)=>row.det=row.detCum-(i?r.rows[i-1].detCum:0))}
 return r}
// layout search: hall rotations 0/90 deg from the user's angle plus parcel-edge-aligned angles (longest edges), each packed as
// lattice rows and as first-fit per-leg; same hall size, lanes, setbacks and no-build mask throughout; keeps the most halls
function tfAngles(R,rot0){const E=[];for(let i=1;i<R.length;i++){const a=R[i-1],b=R[i],l=Math.hypot(b[0]-a[0],b[1]-a[1]);if(l>50)E.push([l,Math.atan2(b[1]-a[1],b[0]-a[0])*180/Math.PI])}
 E.sort((p,q)=>q[0]-p[0]);const out=[],n=a=>((a%180)+180)%180,add=a=>{a=n(a);if(!out.some(b=>Math.min(Math.abs(a-b),180-Math.abs(a-b))<2))out.push(a)};
 add(rot0);add(rot0+90);E.slice(0,4).forEach(([,a])=>{add(a);add(a+90)});return out}
function tfDCbest(R,I,ctx,pd){if(I._pack||I.rotLock)return tfDC0(R,I,ctx,pd);let best=null;
 for(const pl of pd?[0,1]:[0])for(const a of tfAngles(R,+I.rot||0))for(const pk of ['rows','greedy','mixed']){const r=tfDC0(R,Object.assign({},I,{rot:a,_pack:pk,_pondLast:pl}),ctx,pd);r.pack={rot:Math.round(a*10)/10,mode:pk,pondLast:!!pl};
  if(pl&&!r.pond)continue; // halls-first is only valid if the detention pond still fits
  if(!best||r.n>best.n||(r.n===best.n&&r.score>best.score+1e-9))best=r;if(best.n>=Math.min(best.want,best.needCap))return best}return best}
function tfDC(R,I,ctx){return tfCivil('land',tfDCbest,R,I,ctx)}
// ---- self-storage solve
function tfST(R,I,ctx){return tfCivil('storage',tfST0,R,I,ctx)}
function tfST0(R,I,ctx,pd){ctx=ctx||{};const Z=ctx.zone||null,E=tfEff(I,Z),C=tfCtx(R,E,ctx.nb),site=C.A,warn=[],placed=[],aisle=+E.aisle||28,HL=tfHLim(E,ctx.faa);
 let pond=E._pondLast?null:tfPond(C,pd,ctx,placed);if(pd&&!pond&&!E._pondLast)warn.push({k:'pond',t:`Detention pond (${pd.ac.toFixed(2)} ac) does not fit outside setbacks/no-build`});
 let st=Math.max(1,Math.round(+E.stories||1));const h=st*(+E.storyFt||11)+4;if(HL.lim!=null&&h>HL.lim){st=Math.max(1,Math.floor((HL.lim-4)/(+E.storyFt||11)));warn.push({k:'height',t:`Design height ${h} ft exceeds the ${Math.round(HL.lim)} ft ${HL.why} limit · ${st} storeys`})}
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
 if(Z&&Z.okU===-1)warn.push({k:'use',t:`Zoning ${Z.district||''}: self-storage ${String(Z.use||'not listed').replace(/_/g,' ')}`});else if(Z&&Z.okU===0)warn.push({k:'use',t:`Zoning ${Z.district||''}: self-storage ${Z.use} (discretionary)`});
 const circ=[{id:'aisle',ok:aisle>=26,t:`Drive aisle ${aisle} ft (fire access ≥ 26 ft; 10x30 trucks need ~28 ft)`}];
 const bind=fpU>=covMax-1?'Coverage':mu&&st<(+E.stories||1)?'Height':'Setbacks / site shape';
 return {co:'storage',C,E,pond,hlim:HL,mu,du,office,rv,rvN,stories:st,nrsf,units,mix,avg,duSf,muSf,gsf:duSf+muSf*st,cov,site,bind,warn,circ,score:nrsf/1000-warn.length*2,
  k:{nrsf:Math.round(nrsf),units,cov:+(cov*100).toFixed(1),rv:rvN,gsf:Math.round(duSf+muSf*st)}}}
// MultiPolygon parts: each ring packs on its own (own rotation search). Halls/yards/ponds never cross the gap
// between parts — each solver is confined to its ring, and inter-part gaps are also kind-4 no-build via spNB.
function tfIsParts(R){return R&&R.length&&Array.isArray(R[0])&&R[0].length&&Array.isArray(R[0][0])}
function tfSolve(co,R,I,ctx){if(tfIsParts(R))return tfSolveParts(co,R,I,ctx);return co==='storage'?tfST(R,I,ctx):tfDC(R,I,ctx)}
function tfSolveParts(co,parts,I,ctx){ctx=ctx||{};
 // allocate hall target across parts by area so one big strip does not starve the other
 const areas=parts.map(tfArea),Atot=areas.reduce((a,b)=>a+b,0)||1;
 const rs=parts.map((R,i)=>{
  const share=Math.max(0,Math.round((+I.halls||0)*areas[i]/Atot));
  const Ii=Object.assign({},I,{halls:co==='land'?Math.max(share,share?1:0):I.halls});
  // per-part solve; land uses full angle search so E-W strips pick E-W halls
  if(co==='storage')return tfST(R,Ii,ctx);
  let r=tfDC(R,Ii,ctx);
  // if the requested hallL does not fit this part (e.g. east exclusion ate the length), try shorter E-W halls
  if((r.n||0)===0&&(+I.hallL||0)>0){const hw=+I.hallW||250;for(const hl of [800,600,500,Math.max(400,hw*2)]){if(hl>=+I.hallL)continue;
   const t=tfDC(R,Object.assign({},Ii,{hallL:hl}),ctx);if((t.n||0)>(r.n||0)){r=t;r.pack=Object.assign({},r.pack,{hallL:hl})}}}
  return r});
 return tfMergeParts(co,rs,parts,I,ctx)}
function tfMergeParts(co,rs,parts,I,ctx){
 // convert every placed rect into absolute local-ft AABB (exact for 0/90°; slight pad otherwise) and merge KPIs
 const abs=(r,rect)=>{if(!rect)return null;const [x,y,w,h]=rect,c=[[x,y],[x+w,y],[x+w,y+h],[x,y+h]].map(r.C.un);
  const xs=c.map(p=>p[0]),ys=c.map(p=>p[1]);return [Math.min(...xs),Math.min(...ys),Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys)]};
 const halls=[],phase=[],warn=[],circ=[];let sub=null,park=null,pond=null,site=0,it=0,itRaw=0,fac=0,fp=0,n=0,stalls=0;
 const idC={rot:0,un:p=>p,Q:null,A:0,ok:()=>true,okP:()=>true,edgeAt:()=>({inRow:false,inSet:false}),edges:[],bb:[0,0,0,0],setRing:null,hardRing:null,rowRing:null};
 rs.forEach((r,i)=>{site+=r.site||0;idC.A=site;(r.warn||[]).forEach(w=>warn.push(Object.assign({},w,{t:`Part ${i+1}: ${w.t}`})));(r.circ||[]).forEach(c=>circ.push(c));
  if(co==='land'){(r.halls||[]).forEach((h,k)=>{halls.push({hall:abs(r,h.hall),gen:h.gen?abs(r,h.gen):null,v:h.v,part:i});phase.push((r.phase&&r.phase[k])||1)});
   if(!sub&&r.sub)sub=abs(r,r.sub);if(!park&&r.park)park=abs(r,r.park);if(!pond&&r.pond)pond=abs(r,r.pond);
   n+=r.n||0;it+=r.it||0;itRaw+=r.itRaw||0;fac+=r.fac||0;fp+=r.fp||0;stalls+=r.stalls||0}
  else{/* storage merge not required for Water Well */}
 });
 idC.bb=(()=>{let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;parts.forEach(R=>R.forEach(([x,y])=>{x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y)}));return [x0,y0,x1,y1]})();
 const E=(rs[0]&&rs[0].E)||I,pue=+E.pue||1.3,want=Math.max(0,Math.round(+I.halls||0));
 const cov=site?fp/site:0,far=site?fp*(rs[0]&&rs[0].stories||1)/site:0;
 const bind=rs.map(r=>r.bind).filter(Boolean).join(' · ')||'Land / setbacks / no-build';
 const r0=rs[0]||{};
 const out={co,C:idC,E,halls,sub,park,pond,stalls,n,want,needCap:r0.needCap,capIT:r0.capIT,it,itRaw,fac,hallMW:r0.hallMW,fp,cov,far,
  height:r0.height,stories:r0.stories,hlim:r0.hlim,phase,phMW:r0.phMW||[],rows:r0.rows||[],T:r0.T,Tsum:r0.Tsum,ent:r0.ent,
  bind,warn,circ,site,score:it-(warn.length*.5),parts:rs.length,
  k:{it:+it.toFixed(2),fac:+fac.toFixed(2),halls:n,cov:+(cov*100).toFixed(1),far:+far.toFixed(3),stalls,itLand:+itRaw.toFixed(2)}};
 // attach civil from first part that has it; recompute buildable as sum
 out.build={gross:site/43560,net:rs.reduce((a,r)=>a+((r.build&&r.build.net)||0),0),row:0,road:0,setback:0,easement:0,stream:0,power:0,flood:0,bld:0,excl:0,pond:pond?pond[2]*pond[3]/43560:0};
 out.sw=r0.sw;out.pd=r0.pd;out.grade=null;out.hgt=r0.hgt;out.pack={parts:rs.map((r,i)=>({i,n:r.n,rot:r.pack&&r.pack.rot,mode:r.pack&&r.pack.mode}))};
 if(out.k){out.k.netAc=+out.build.net.toFixed(1);if(out.sw)out.k.detAcFt=+out.sw.Vac.toFixed(2);if(pond)out.k.pondAc=+(pond[2]*pond[3]/43560).toFixed(2)}
 return out}
// option generator: sweep orientation and prototype sizes; rank by the company KPI
function tfGen(co,R,I,ctx){if(ctx&&ctx.cv&&ctx.cv.pf&&I.sw!=='off'&&!ctx.pondFix){const b=tfSolve(co,R,I,ctx);ctx=Object.assign({},ctx,{pondFix:b.pd})}const O=[],seen=new Set(),rots=[0,15,30,45,60,75,90,105,120,135,150,165];
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
 // phased MW targets: "200 MW in 4 phases", "50 now, 100 later", "phase 1 50 mw phase 2 100 mw", "target 100 mw it"
 if(co!=='storage'){const nl=t.match(/(\d+(?:\.\d+)?)\s*(?:mw)?\s*(?:now|first|initially|up front|day one|to start)\b.*?(\d+(?:\.\d+)?)\s*(?:mw)?\s*(?:later|next|after|eventually|future|phase two|second)/);
  const pl=[...t.matchAll(/phase\s*(\d)\s*(?:of|=|:|at|is|gets)?\s*(\d+(?:\.\d+)?)\s*mw/g)];
  if(nl){const a1=+nl[1],a2=+nl[2],inc=/\b(another|additional|more|plus|extra)\b/.test(t)||a2<=a1,d2=inc?a2:a2-a1;set('phMW',a1+','+d2,`Phase 1 ${a1} MW, phase 2 +${d2} MW (${a1+d2} MW total${inc?'':'; say "another '+a2+' later" to add '+a2})`);set('tgtMW',a1+d2,'')}
  else if(pl.length>1){const v=pl.sort((a,b)=>a[1]-b[1]).map(x=>x[2]);set('phMW',v.join(','),`Phases ${v.join(' / ')} MW`);set('tgtMW',v.reduce((a,b)=>a+ +b,0),'')}
  else if((m=t.match(/(\d+(?:\.\d+)?)\s*mw\b(?!\s*(?:per|\/|each)\s*hall)(?:\s*(?:of\s*)?(?:it|facility|utility|grid))?/))&&!/per hall|mw each/.test(t)&&/\b(target|build|deliver|need|want|plan|get|phases?|total|campus|site for|make it|optimi[sz]e)\b|^\s*\d+(?:\.\d+)?\s*mw\s*$/.test(t)){set('tgtMW',+m[1],`Target ${m[1]} MW`);set('phMW','','')}
  if(/\bmw\s*(?:of\s*)?it\b|\bit\s*mw\b|\bcritical\b/.test(t)&&ops.some(o=>o.k==='tgtMW'))set('mwBasis','it','IT basis');else if(/facility|utility|grid|total power/.test(t)&&ops.some(o=>o.k==='tgtMW'))set('mwBasis','fac','Facility basis');
  if(/\b(grow|phase|stage)\w*\s*(?:the\s*)?(?:pond|detention)|(?:pond|detention)\s*(?:per|by|each)\s*phase/.test(t))set('swPh','phase','Detention grows per phase');}
 // civil: corner lots, ROW, easements, buffers, detention
 const DIRW={north:'N',south:'S',east:'E',west:'W',n:'N',s:'S',e:'E',w:'W'},D='(north|south|east|west|n|s|e|w)';
 if((m=t.match(new RegExp('(?:corner lot|side street|second street|street)\\s*(?:on|to|along)?\\s*(?:the)?\\s*'+D+'\\b')))||(m=t.match(new RegExp(D+'\\s*(?:side)?\\s*(?:is a|is)?\\s*(?:side\\s*)?street\\b'))))set('front2',DIRW[m[1]],`Corner lot: side street ${DIRW[m[1]]}`);
 if(/\bnot a corner|no side street/.test(t))set('front2','','Not a corner lot');
 if((m=t.match(new RegExp('residential\\s*(?:neighbor|neighbour|lots?|homes?|houses?|zoning|district)?\\s*(?:is\\s*)?(?:on|to|along)\\s*(?:the)?\\s*'+D+'\\b')))||(m=t.match(new RegExp(D+'\\s*(?:side|neighbor)?\\s*(?:is|abuts)\\s*residential'))))set('resSide',DIRW[m[1]],`Residential neighbor ${DIRW[m[1]]}`);
 if((m=t.match(/residential\s*buffer\s*(?:to|=|of|at)?\s*(\d+)/)))set('resBuf',+m[1],`Residential buffer ${m[1]} ft`);
 else if((m=t.match(/(?:landscape\s*)?buffers?\s*(?:to|=|of|at)?\s*(\d+)/)))set('buf',+m[1],`Landscape buffer ${m[1]} ft`);
 if((m=t.match(/(?:row|right[\s-]*of[\s-]*way)\s*(?:dedication)?\s*(?:to|=|of|at)?\s*(\d+)|dedicat\w*\s*(\d+)\s*(?:ft|feet|')?\s*(?:of\s*)?(?:row|right)/)))set('rowDed',+(m[1]||m[2]),`ROW dedication ${m[1]||m[2]} ft`);
 if((m=t.match(/utility\s*easements?\s*(?:to|=|of|at)?\s*(\d+)|(\d+)\s*(?:ft|feet|')?\s*(?:frontage\s*)?(?:utility\s*)?easement/)))set('ueF',+(m[1]||m[2]),`Frontage utility easement ${m[1]||m[2]} ft`);
 if((m=t.match(/(?:pond|basin|detention)\s*(?:live\s*)?depth\s*(?:to|=|of|at)?\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:ft|feet|')?\s*deep\s*(?:pond|basin)/)))set('pondD',+(m[1]||m[2]),`Pond depth ${m[1]||m[2]} ft`);
 if((m=t.match(/(\d(?:\.\d)?)\s*:\s*1\s*(?:side\s*)?slopes?|slopes?\s*(?:to|=|of|at)?\s*(\d(?:\.\d)?)\s*:\s*1/)))set('slope',+(m[1]||m[2]),`Pond slopes ${m[1]||m[2]}:1`);
 if(/\bapwa\b|5600|cfs\s*(?:per|\/)\s*ac/.test(t))set('swRule','apwa','Release per APWA 5600 rates');else if(/10[\s-]*(?:yr|year)\s*pre|pre[\s-]*10/.test(t))set('swRule','pre10','Release: 100-yr post to 10-yr pre');else if(/post\s*(?:<=|≤|to|at|=)?\s*pre|pre[\s-]*development (?:rate|peak)/.test(t))set('swRule','pre','Release: post ≤ pre');
 if(/\b(no|skip|remove|turn off)\s*(?:the\s*)?(?:detention|pond|stormwater)/.test(t))set('sw','off','Detention off');else if(/\b(add|turn on|include|size)\s*(?:the\s*)?(?:detention|pond|stormwater)/.test(t))set('sw','on','Detention on');
 if((m=t.match(/(\d+)\s*%\s*impervious|impervious\s*(?:cover)?\s*(?:to|=|of|at)?\s*(\d+)\s*%/)))set('imp',+(m[1]||m[2]),`Impervious ${m[1]||m[2]}%`);
 if((m=t.match(/(?:rotate|orient(?:ation)?|angle)\D*(\d+)/)))set('rot',+m[1]%180,`Rows at ${+m[1]%180}°`);
 if((m=t.match(new RegExp(N+'\\s*phases?\\b')))&&co!=='storage'&&!ops.some(o=>o.k==='phMW'&&o.v))set('phases',TF_NUMW[m[1]]||+m[1],`${TF_NUMW[m[1]]||m[1]} phases`);
 if(/\b(max(?:imi[sz]e)?|maximum|most|optimi[sz]e)\b/.test(t)){goal=co==='storage'?(/unit/.test(t)?'units':'nrsf'):(/mw|power|it|load|capacity/.test(t)||1?'it':'score');say.push(`Optimise for ${goal==='it'?'IT MW':goal==='units'?'unit count':'rentable sq ft'}`)}
 if(/\bundo\b/.test(t))return {ops:[],goal:null,undo:1,reply:'Undone'};
 return {ops,goal,reply:say.length?say.filter(Boolean).join(' · '):"I didn't catch an edit. Try: \"increase setbacks to 100 ft\", \"add a second hall\", \"move the substation to the NW corner\", \"switch to all drive-up\", \"make it 2 phases\"."}}
// apply ops with schema clamping; returns new params
function tfApplyOps(co,I,ops){const S=(typeof TF_EDIT_SCHEMA!=='undefined'?TF_EDIT_SCHEMA.keys[co]:null)||{},P=Object.assign({},I);
 for(const o of ops||[]){const d=S[o.k];if(!d)continue;let v=o.d!=null?(+P[o.k]||0)+(+o.d):o.v;if(d.length>=3){v=+v;if(!isFinite(v))continue;v=Math.max(d[1],Math.min(d[2],v));if(d[3]===1)v=Math.round(v)}else v=String(v);P[o.k]=v}return P}
