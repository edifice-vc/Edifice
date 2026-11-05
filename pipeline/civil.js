// ---- Civil layer for Site Plan (setbacks/easements/buildable area, stormwater detention, FAA Part 77 height, grading,
// DC phasing, preliminary civil report). Pure functions; tested in pipeline/tests/test_testfit.py. PLANNING ESTIMATES ONLY.
// Public reference data CV_REF (NOAA Atlas 14 grid + FAA airports) is inlined by render.py from pipeline/civil_ref.json.
const CV_DUR=[5,10,15,30,60,120,180,360,720,1440];
const CV_CN={pre:{A:49,B:69,C:79,D:84},perv:{A:39,B:61,C:74,D:80},imp:98};// TR-55 Table 2-2: pasture/grassland fair (pre); open space good (post pervious)
const CV_C={A:.12,B:.18,C:.24,D:.30,imp:.95};// Rational C, grass 2-7% slope by HSG; impervious .95
const CV_CF={2:1,10:1,25:1.1,100:1.25};// Rational frequency factor
const CV_APWA={2:.2,10:.6,100:3.0};// cfs/ac, APWA KC 5600 (2025 rev.) Table 5602-7 new site development; verify with the jurisdiction
const CV_SWTXT={pre:'Post-development peak ≤ pre-development peak for the 10- and 100-yr storms (typical Kansas county / no-adverse-impact rule)',
 pre10:'Post-development 100-yr peak ≤ pre-development 10-yr peak (stricter, used by some Kansas cities)',apwa:'KC-metro APWA 5600 release rates: 2-yr 0.2, 10-yr 0.6, 100-yr 3.0 cfs/ac'};
// NOAA Atlas 14 depths at a point: bilinear on the shipped 0.5° Kansas grid (exact PFDS values override via pf)
function cvAtlas(lat,lon,pf){if(pf)return pf;const G=typeof CV_REF!=='undefined'&&CV_REF&&CV_REF.noaa;if(!G)return null;
 const fi=Math.max(0,Math.min(G.nlat-1.0001,(lat-G.lat0)/G.d)),fj=Math.max(0,Math.min(G.nlon-1.0001,(lon-G.lon0)/G.d)),i=Math.floor(fi),j=Math.floor(fj),u=fi-i,v=fj-j,o={};
 for(const a of G.ari){const M=G.depth_in[a];o[a]=M[i][j].map((_,k)=>+((1-u)*(1-v)*M[i][j][k]+(1-u)*v*M[i][j+1][k]+u*(1-v)*M[i+1][j][k]+u*v*M[i+1][j+1][k]).toFixed(3))}return o}
// depth (in) at duration t min by log-log interpolation; intensity in/hr
function cvDepth(row,t){t=Math.max(5,Math.min(1440,t));for(let k=1;k<CV_DUR.length;k++)if(t<=CV_DUR[k]){const a=Math.log(CV_DUR[k-1]),b=Math.log(CV_DUR[k]),f=(Math.log(t)-a)/(b-a);return Math.exp(Math.log(row[k-1])+f*(Math.log(row[k])-Math.log(row[k-1])))}return row[row.length-1]}
const cvI=(row,t)=>cvDepth(row,t)/(Math.max(5,t)/60);
const cvQ=(P,CN)=>{const S=1000/CN-10;return P>.2*S?(P-.2*S)**2/(P+.8*S):0};// TR-55 runoff depth (in)
function cvRatio(r){if(r>=1)return 0;r=Math.max(.1,r);return Math.max(0,.682-1.43*r+1.64*r*r-.804*r*r*r)}// TR-55 Fig 6-1, Type II
function cvHSG(h){const o={A:0,B:0,C:0,D:0};let n=0;for(const [g,w] of Object.entries(h||{})){const k=String(g)[0];if(k in o){o[k]+=+w;n+=+w}}if(!n)return {w:{A:0,B:0,C:1,D:0},assumed:1};for(const k in o)o[k]/=n;return {w:o}}
const cvMix=(w,T)=>Object.keys(w).reduce((a,k)=>a+w[k]*T[k],0);
// stormwater: A ac, imp fraction (post), hsg weights, pf (Atlas 14), relief ft, L flow length ft, rule
function cvStorm(o){const A=Math.max(.01,o.A),imp=Math.max(0,Math.min(1,o.imp)),H=cvHSG(o.hsg),pf=o.pf,rule=o.rule||'pre';if(!pf)return null;
 const L=Math.max(100,o.L||Math.sqrt(A*43560)*1.2),S=Math.max(.005,(o.relief!=null?o.relief:L*.01)/L),k=.0078*Math.pow(L,.77)*Math.pow(S,-.385);
 const tcPre=Math.max(10,2*k),tcPost=Math.max(5,k),CNpre=cvMix(H.w,CV_CN.pre),CNpv=cvMix(H.w,CV_CN.perv),CNpost=imp*CV_CN.imp+(1-imp)*CNpv;
 const Cpre=cvMix(H.w,CV_C),Cpost=imp*CV_C.imp+(1-imp)*Cpre,rows=[];let V=0,gov=null;
 for(const a of ['2','10','100']){const R=pf[a];if(!R)continue;const ip=cvI(R,tcPre),iq=cvI(R,tcPost),cf=CV_CF[a]||1,Qpre=Math.min(1,Cpre*cf)*ip*A,Qpost=Math.min(1,Cpost*cf)*iq*A;
  const P24=R[9],Qd=cvQ(P24,CNpost),Vr=Qd/12*A*43560;let Qa=rule==='apwa'?CV_APWA[a]*A:rule==='pre10'?(a==='100'?null:Qpre):Qpre;
  if(rule==='pre'&&a==='2')Qa=null;if(rule==='pre10'&&a==='100'){const R10=pf['10'];Qa=Math.min(1,Cpre)*cvI(R10,tcPre)*A}
  const rt=Qa==null?null:Qa/Qpost,Vs=rt==null?0:Vr*cvRatio(rt);rows.push({ari:+a,P24,ip,iq,Qpre,Qpost,Qa,Qdin:Qd,Vr,rt,Vs});if(Vs>V){V=Vs;gov=+a}}
 const Iw=imp*100,WQv=1.37*(.05+.009*Iw)/12*A*43560;// MARC/APWA water-quality volume, 1.37 in event, Rv=0.05+0.009 I
 return {A,imp,hsg:H.w,hsgAssumed:!!H.assumed,CNpre,CNpost,Cpre,Cpost,tcPre,tcPost,L,S,rows,V,Vac:V/43560,gov,WQv,Vdes:Math.max(V,WQv),rule,ruleT:CV_SWTXT[rule]||rule}}
// pond: rectangular dry detention basin, aspect 1.5:1, live depth D, side slope z:1, freeboard fb, 15 ft maintenance bench
function cvPond(V,D,z,fb){D=+D||5;z=+z||4;fb=fb==null?1:+fb;if(!(V>0))return null;const vol=(w)=>{const l=1.5*w,tw=w+2*z*D,tl=l+2*z*D;return D/6*(w*l+tw*tl+(w+tw)*(l+tl))};
 let lo=1,hi=5000;for(let i=0;i<60;i++){const m=(lo+hi)/2;if(vol(m)<V)lo=m;else hi=m}const w=hi,l=1.5*w,ow=w+2*z*(D+fb)+30,ol=l+2*z*(D+fb)+30;
 return {D,z,fb,bw:w,bl:l,ow,ol,V,area:ow*ol,ac:ow*ol/43560,exc:vol(w)+(w+2*z*D)*(l+2*z*D)*fb}}
// impervious estimate from a solved layout (rotated-frame rects): roofs, pads, parking, gravel @50%, drives = lane × (w+h) per building
function cvImp(r){const lane=+(r.E.lane||r.E.aisle||28),a=R=>R?R[2]*R[3]:0,dr=R=>R?lane*(R[2]+R[3]):0;let s=0;
 if(r.co==='land'){r.halls.forEach(h=>{s+=a(h.hall)+a(h.gen)+dr(h.hall)});s+=a(r.park)+.5*a(r.sub)+(r.sub?lane*r.sub[2]:0)}
 else{const B=[r.mu,r.office].concat(r.du,r.rv).filter(Boolean);B.forEach(R=>{s+=a(R)+dr(R)*.5})}
 return Math.min(.95,s/Math.max(1,r.site))}
// DEM helpers. dem: {x0,y0,dx,dy,nx,ny,z:[row-major ft]} in LOCAL ft (unrotated)
function cvZ(d,x,y){if(!d)return null;const fx=Math.max(0,Math.min(d.nx-1.0001,(x-d.x0)/d.dx)),fy=Math.max(0,Math.min(d.ny-1.0001,(y-d.y0)/d.dy)),i=Math.floor(fx),j=Math.floor(fy),u=fx-i,v=fy-j,Z=(a,b)=>d.z[b*d.nx+a];
 return (1-u)*(1-v)*Z(i,j)+u*(1-v)*Z(i+1,j)+(1-u)*v*Z(i,j+1)+u*v*Z(i+1,j+1)}
function cvDemStats(d,inside){if(!d)return null;let mn=1e9,mx=-1e9,lo=null,hi=null,s=0,n=0;for(let j=0;j<d.ny;j++)for(let i=0;i<d.nx;i++){const x=d.x0+i*d.dx,y=d.y0+j*d.dy;if(inside&&!inside(x,y))continue;const z=d.z[j*d.nx+i];s+=z;n++;if(z<mn){mn=z;lo=[x,y]}if(z>mx){mx=z;hi=[x,y]}}
 return n?{min:mn,max:mx,mean:s/n,relief:mx-mn,lo,hi,L:Math.hypot(hi[0]-lo[0],hi[1]-lo[1])}:null}
// balanced-pad cut/fill for rotated-frame rects (C.un maps to local); returns cf
function cvPad(d,C,R){const [x,y,w,h]=R,n=Math.max(2,Math.ceil(Math.max(w,h)/50)),m=Math.max(2,Math.ceil(Math.min(w,h)/50)),Z=[];
 for(let j=0;j<m;j++)for(let i=0;i<n;i++){const p=C.un([x+w*(i+.5)/n,y+h*(j+.5)/m]),z=cvZ(d,p[0],p[1]);if(z!=null)Z.push(z)}if(!Z.length)return {cut:0,fill:0};
 const pe=Z.reduce((a,b)=>a+b,0)/Z.length,ca=w*h/Z.length;let cut=0,fill=0;Z.forEach(z=>{if(z>pe)cut+=(z-pe)*ca;else fill+=(pe-z)*ca});return {cut,fill,pe}}
function cvGrade(r,d){if(!d)return null;const B=r.co==='land'?r.halls.flatMap(h=>[h.hall,h.gen]).concat([r.sub,r.park]):[r.mu,r.office].concat(r.du,r.rv);let cut=0,fill=0,da=0;
 B.filter(Boolean).forEach(R=>{const q=cvPad(d,r.C,R);cut+=q.cut;fill+=q.fill;da+=R[2]*R[3]});const pc=r.pond?r.pond.exc:0,dist=Math.min(r.site,da*1.6+(r.pond?r.pond.area:0)),top=dist*.5;
 return {cutCY:cut/27,fillCY:fill/27,pondCY:pc/27,topCY:top/27,netCY:(cut+pc-fill)/27,distAc:dist/43560}}
// ---- FAA 14 CFR Part 77 screening. pts: [[lat,lon],...] sample points of the parcel; ground ft MSL
function cvFt(lat){return [364000*Math.cos(lat*Math.PI/180),364000]}
function cvFAA(pts,ground,apts){apts=apts||(typeof CV_REF!=='undefined'&&CV_REF&&CV_REF.faa?CV_REF.faa.airports:[]);if(!pts||!pts.length||ground==null)return null;
 const la0=pts[0][0],lo0=pts[0][1],[kx,ky]=cvFt(la0),L=(la,lo)=>[(lo-lo0)*kx,(la-la0)*ky],out=[];let notice=200,cap=null,capWhy='',nWhy='77.9(a) 200 ft AGL';
 for(const a of apts){if(a.type&&a.type!=='AD')continue;const c=L(a.lat,a.lon);if(Math.hypot(c[0],c[1])>70000)continue;const rw=(a.rwy||[]).map(q=>[L(q[1],q[0]),L(q[3],q[2]),q[4]]);if(!rw.length)continue;
  const Lmax=Math.max(...rw.map(q=>q[2])),Rh=Lmax>=5000?10000:5000,el=+a.elev||0;let dmin=1e18,cp=1e18,np=1e18,sur='';
  for(const p of pts){const q=L(p[0],p[1]);let d=1e18;for(const [s,e] of rw)d=Math.min(d,tfSD(q[0],q[1],s,e));dmin=Math.min(dmin,d);
   if(Lmax>3200?d<=20000:d<=10000){const t=el+d/(Lmax>3200?100:50)-ground;if(t<np)np=t}
   let h=null,why='';const dp=Math.max(0,d-200);if(dp<=Rh){h=el+150;why='77.19 horizontal (150 ft above field)'}else if(dp<=Rh+4000){h=el+150+(dp-Rh)/20;why='77.19 conical 20:1'}
   for(const [s,e,len] of rw)for(const [A0,B0] of [[s,e],[e,s]]){const ux=(B0[0]-A0[0])/len,uy=(B0[1]-A0[1])/len,vx=q[0]-A0[0],vy=q[1]-A0[1],x=-(vx*ux+vy*uy)-200,lat=Math.abs(-vx*uy+vy*ux),ins=len>=5000;
    const La=ins?10000:5000,wi=500,wo=ins?3500:1500,sl=ins?34:20;if(x>=0&&x<=La&&lat<=wi/2+(wo-wi)/2*x/La){const ha=el+x/sl;if(h==null||ha<h){h=ha;why=`77.19 approach ${sl}:1 (Rwy end)`}}}
   if(h!=null&&h-ground<cp){cp=h-ground;sur=why}}
  const rec={id:a.id,name:a.name,dist:dmin,Lmax,notice:np<1e17?np:null,cap:cp<1e17?cp:null,sur};out.push(rec);
  if(rec.notice!=null&&rec.notice<notice){notice=rec.notice;nWhy=`77.9(b) ${Lmax>3200?'100:1':'50:1'} from ${a.id} (${Math.round(dmin).toLocaleString()} ft)`}
  if(rec.cap!=null&&(cap==null||rec.cap<cap)){cap=rec.cap;capWhy=`${sur} · ${a.id}`}}
 out.sort((a,b)=>a.dist-b.dist);return {ground,notice:Math.max(0,notice),nWhy,cap:cap==null?null:Math.max(0,cap),capWhy,near:out.slice(0,4)}}
function cvHeight(zMax,faa,design){const z=zMax===''||zMax==null?null:+zMax,f=faa&&faa.cap!=null?faa.cap:null,lim=z==null?f:f==null?z:Math.min(z,f);
 const bind=lim==null?'None known':f!=null&&(z==null||f<z)?'FAA Part 77 ('+faa.capWhy+')':'Zoning';const fl=[];
 if(design!=null&&z!=null&&design>z)fl.push(`Variance / height exception needed: ${design} ft > ${z} ft zoning limit`);
 if(design!=null&&faa&&design>faa.notice)fl.push(`FAA 7460-1 notice required: ${design} ft > ${Math.round(faa.notice)} ft (${faa.nWhy})`);
 if(faa&&design!=null&&f!=null&&design>f)fl.push(`Penetrates ${faa.capWhy} (${Math.round(f)} ft AGL): FAA hazard study likely`);
 if(faa&&faa.notice<250)fl.push(`Construction cranes over ${Math.round(faa.notice)} ft AGL also need 7460-1 notice`);
 return {zoning:z,faa:f,limit:lim,bind,flags:fl}}
// ---- setbacks: per-edge distances. returns {kind,s (structures/pavement), h (pond/hard: ROW + U/E + buffers)}
const CV_DIR={N:[0,1],S:[0,-1],E:[1,0],W:[-1,0]};
function cvEdgeSet(E,d,dn){const f=d>.7,f2=E.front2&&dn(CV_DIR[E.front2])>.7,res=E.resSide&&dn(CV_DIR[E.resSide])>.7,rb=+E.resBuf||0,rw=+E.rowDed||0,ue=+E.ueF||0,bf=+E.buf||0;
 if(f||f2){const k=f?'front':'front2';return {kind:k,s:rw+Math.max(+E.setF||0,ue,bf,res?rb:0),h:rw+Math.max(ue,bf,res?rb:0),row:rw,ue,buf:bf}}
 const base=d<-.7?+E.setR||0:+E.setS||0;return {kind:d<-.7?'rear':'side',s:Math.max(base,res?rb:0),h:Math.max(10,res?rb:0),row:0,ue:0,buf:res?rb:0}}
// inward offset ring of a closed ring Q with per-edge distances D (rotated frame)
function cvOffset(Q,D){const n=Q.length-1;if(n<3)return null;let sa=0;for(let i=0;i<n;i++)sa+=Q[i][0]*Q[i+1][1]-Q[i+1][0]*Q[i][1];const sg=sa>0?1:-1,Ls=[];
 for(let i=0;i<n;i++){const a=Q[i],b=Q[i+1],dx=b[0]-a[0],dy=b[1]-a[1],l=Math.hypot(dx,dy)||1,nx=-dy/l*sg,ny=dx/l*sg,d=D[i]||0;Ls.push([[a[0]+nx*d,a[1]+ny*d],[dx,dy],[nx,ny,d,l,dx/l,dy/l]])}
 // Prefer mitred ring when every corner stays inside Q. At concave reflex corners the mitre shoots
 // outside (cul-de-sac notches) — fall back to per-edge segments with no corner join so the dashed
 // setback never leaves the parcel. Endpoints are pulled a foot off each vertex so they don't sit on
 // the adjacent edge (where point-in-polygon is flaky). Callers that draw should prefer R.segs.
 const mit=[];let ok=true;for(let i=0;i<n;i++){const [p,u]=Ls[(i+n-1)%n],[q,v]=Ls[i],cr=u[0]*v[1]-u[1]*v[0];let pt;if(Math.abs(cr)<1e-6)pt=q;else{const t=((q[0]-p[0])*v[1]-(q[1]-p[1])*v[0])/cr;pt=[p[0]+u[0]*t,p[1]+u[1]*t]}
  if(!tfIn(pt[0],pt[1],Q)){ok=false;break}mit.push(pt)}
 const segs=[];for(let i=0;i<n;i++){const [, ,nml]=Ls[i],d=nml[2],l=nml[3],ux=nml[4],uy=nml[5];if(d<=0||l<1e-6)continue;
  const inset=Math.min(l*.5,Math.max(1,d*0.05)),a=Q[i],b=Q[i+1];
  const p=[a[0]+ux*inset+nml[0]*d,a[1]+uy*inset+nml[1]*d],q=[b[0]-ux*inset+nml[0]*d,b[1]-uy*inset+nml[1]*d];
  const mx=(p[0]+q[0])/2,my=(p[1]+q[1])/2;if(tfIn(p[0],p[1],Q)&&tfIn(q[0],q[1],Q)&&tfIn(mx,my,Q))segs.push([p,q])}
 if(ok&&mit.length>=3){mit.push(mit[0]);mit.segs=segs.length?segs:null;return mit}
 if(!segs.length)return null;const P=[];for(const s of segs){P.push(s[0],s[1])}P.push(P[0]);P.segs=segs;return P}
// buildable-area accounting on a lattice (rotated frame). C from tfCtx; extra: rects to deduct (pond). returns acres by category
function cvBuildable(C,nbKind,pond){const [x0,y0,x1,y1]=C.bb,st=Math.max(8,Math.sqrt(C.A)/140),o={gross:0,row:0,road:0,setback:0,easement:0,stream:0,power:0,flood:0,bld:0,excl:0,pond:0,net:0};
 for(let y=y0+st/2;y<y1;y+=st)for(let x=x0+st/2;x<x1;x+=st){if(!tfIn(x,y,C.Q))continue;o.gross++;const e=C.edgeAt(x,y);
  if(e&&e.inRow){o.row++;continue}const k=nbKind?nbKind(...C.un([x,y])):0;if(k===2){o.flood++;continue}if(k===1){o.easement++;continue}if(k===3){o.excl++;continue}if(k===4){o.road++;continue}if(k===5){o.stream++;continue}if(k===6){o.power++;continue}if(k===7){o.bld++;continue}
  if(e&&e.inSet){o.setback++;continue}if(pond&&x>=pond[0]&&x<=pond[0]+pond[2]&&y>=pond[1]&&y<=pond[1]+pond[3]){o.pond++;continue}o.net++}
 const f=C.A/43560/Math.max(1,o.gross);for(const k in o)o[k]=o[k]*f;return o}
// ---- phasing. targets from tgtMW + phases, or phMW "50,100" (cumulative increments). basis 'fac' (utility MW) or 'it'
function cvPhaseTargets(E){const pue=+E.pue||1.3,toIT=v=>E.mwBasis==='it'?v:v/pue;let T=String(E.phMW||'').split(/[\s,\/+]+/).map(Number).filter(v=>v>0);
 if(!T.length&&+E.tgtMW>0){const k=Math.max(1,Math.round(+E.phases||1));T=Array.from({length:k},()=>+E.tgtMW/k)}return T.length?T.map(toIT):null}
// ---- preliminary civil report checklist (licensed-civil deliverable -> how this tool covers it)
const CV_CHECK=[['cover','Cover sheet & site data table','computed','Parcel area, zoning district, setbacks, coverage, FAR, height, parking, impervious % from the plan and the zoning record'],
 ['exist','Existing conditions (topo, soils, flood, easements)','estimated','USGS 3DEP DEM samples, NRCS SSURGO hydrologic soil groups, FEMA NFHL flood zones, recorded easements in site_constraints. Needs ALTA/NSPS + topographic survey'],
 ['layout','Site layout with setbacks & dimensions','computed','Per-edge setback lines (front / corner-side street / side / rear), landscape and residential buffers, building dimensions'],
 ['row','Easements & right-of-way','estimated','Easement corridors by type and width, frontage utility easement, ROW dedication. Needs title commitment + plat review'],
 ['grade','Grading & drainage','estimated','Balanced-pad cut/fill from DEM, pond excavation, topsoil strip; low point drives pond location. Needs grading plan by PE'],
 ['storm','Stormwater report (pre/post)','estimated','Rational peaks + TR-55 runoff + TR-55 Ch.6 storage with NOAA Atlas 14; release rule shown. A real study routes hydrographs in HEC-HMS with stage-storage-discharge'],
 ['util','Utility plan (water, sewer, power, gas)','requires PE','Only substation, MV/utility corridor lengths and transmission ROW are modeled; water, sewer, fire flow and gas need utility will-serve letters + PE design'],
 ['fire','Fire access','computed','IFC lane width ≥ 26 ft aerial access, 150 ft hose reach; fire flow/hydrant spacing need the fire marshal'],
 ['land','Landscape & buffers','computed','Buffer widths applied to the layout; planting schedule needs a landscape architect'],
 ['faa','Height & FAA Part 77','computed','Zoning limit vs Part 77 notice (77.9) and obstruction surfaces (77.19) from FAA NASR runways; filing is via FAA OE/AAA Form 7460-1'],
 ['esc','Erosion control / NPDES (KDHE)','estimated','Disturbed acres, KDHE construction general permit NOI (≥1 ac, KEIMS) + SWP3, sediment basin 3,600 cf/ac drained. Needs SWP3 by qualified preparer'],
 ['phase','Phasing plan (data centers)','computed','Per-phase halls, IT/facility MW, acres, detention, roads and utility corridors vs grid cap']];
