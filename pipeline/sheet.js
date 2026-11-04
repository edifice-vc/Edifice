// ---- Site plan sheet (civil-style, light ground). Land first: boundary -> setbacks -> water/flood -> infrastructure -> developable acres; buildings only inside net developable.
// Local plane units are feet (x east, y north). Pure helpers first (unit-tested), renderer after.
function shBearing(a,b){const dx=b[0]-a[0],dy=b[1]-a[1];let az=Math.atan2(dx,dy)*180/Math.PI;if(az<0)az+=360;
 const ns=az<=90||az>=270?'N':'S',ew=az<180?'E':'W';let q=ns==='N'?(ew==='E'?az:360-az):(ew==='E'?180-az:az-180);
 let d=Math.floor(q),m=Math.floor((q-d)*60),s=Math.round(((q-d)*60-m)*60);if(s===60){s=0;m++}if(m===60){m=0;d++}
 return {az,txt:ns+' '+d+'°'+String(m).padStart(2,'0')+"'"+String(s).padStart(2,'0')+'" '+ew}}
function shDist(a,b){return Math.hypot(b[0]-a[0],b[1]-a[1])}
// courses of a ring (closed or open): [{n,from,to,a,b,brg,dist}]
function shCourses(R){const P=shOpen(R),n=P.length,C=[];for(let i=0;i<n;i++){const a=P[i],b=P[(i+1)%n];C.push({n:i+1,from:i+1,to:(i+1)%n+1,a,b,brg:shBearing(a,b).txt,dist:shDist(a,b)})}return C}
function shOpen(R){const P=(R||[]).slice();if(P.length>1){const a=P[0],b=P[P.length-1];if(Math.abs(a[0]-b[0])<1e-9&&Math.abs(a[1]-b[1])<1e-9)P.pop()}
 // drop consecutive duplicates
 return P.filter((p,i)=>!i||Math.abs(p[0]-P[i-1][0])>1e-6||Math.abs(p[1]-P[i-1][1])>1e-6)}
// point register: unique numbered points with a description; dedupes within tol ft
function shPoints(tol){const L=[];return {L,add(xy,desc){for(const p of L)if(shDist(p.xy,xy)<(tol||.5))return p.n;const n=L.length+1;L.push({n,xy,desc});return n}}}
// signed area (ft2), positive = CCW
function shArea(R){const P=shOpen(R);let s=0;for(let i=0;i<P.length;i++){const a=P[i],b=P[(i+1)%P.length];s+=a[0]*b[1]-b[0]*a[1]}return s/2}
// band polygon around segment a-b of half width w
function shBand(a,b,w){const L=shDist(a,b)||1,nx=-(b[1]-a[1])/L*w,ny=(b[0]-a[0])/L*w;return [[a[0]+nx,a[1]+ny],[b[0]+nx,b[1]+ny],[b[0]-nx,b[1]-ny],[a[0]-nx,a[1]-ny]]}
// segment intersection point or null
function shX(a,b,c,d){const r=[b[0]-a[0],b[1]-a[1]],s=[d[0]-c[0],d[1]-c[1]],den=r[0]*s[1]-r[1]*s[0];if(Math.abs(den)<1e-12)return null;
 const t=((c[0]-a[0])*s[1]-(c[1]-a[1])*s[0])/den,u=((c[0]-a[0])*r[1]-(c[1]-a[1])*r[0])/den;return t>=0&&t<=1&&u>=0&&u<=1?[a[0]+t*r[0],a[1]+t*r[1]]:null}
// where polylines cross the ring: access / crossing points
function shCross(R,lines){const P=shOpen(R),o=[];for(const Ln of lines)for(let i=1;i<Ln.length;i++)for(let j=0;j<P.length;j++){const x=shX(Ln[i-1],Ln[i],P[j],P[(j+1)%P.length]);if(x)o.push(x)}return o}
// nice graphic-scale length (ft) for ~target ft
function shNice(t){const p=Math.pow(10,Math.floor(Math.log10(t))),m=t/p;return (m<1.5?1:m<3.5?2:m<7.5?5:10)*p}
function shFt(v){return Math.round(v).toLocaleString('en-US')+"'"}
// OSM highway class -> assumed ROW width ft (KDOT/county typical) [A]
const SH_ROW={motorway:300,trunk:150,primary:100,secondary:80,tertiary:70,unclassified:60,residential:60,road:60};
function shRow(hw){return SH_ROW[hw]||null}
// transmission voltage (kV) -> assumed ROW / clearance width ft [A] (typical utility easement widths; replace with the recorded easement)
const SH_TX=[[99,75],[161,100],[230,150],[345,175],[500,200]];
function shTxRow(kv){kv=+kv;if(!(kv>0))return 100;for(const [v,w] of SH_TX)if(kv<=v)return w;return 250}
// FEMA flood zone counts as no-build: SFHA (A, AE, AH, AO, AR, A1-30, A99, V, VE); X / D do not
function shFloodNB(z){return /^(A|AE|AH|AO|AR|A99|A\d{1,2}|V|VE|V\d{1,2})$/i.test(String(z||'').trim().replace(/^ZONE\s+/i,''))}
// contour interval by relief within the parcel: flat ground 2 ft, otherwise 10 ft
function shInterval(relief){return relief<=40?2:10}
// marching squares on a row-major grid G[j*nx+i] at (X0+i*dx, Y0+j*dy); returns [{z,segs:[[p,q],..]}]
function shContours(G,nx,ny,X0,Y0,dx,dy,iv){let lo=Infinity,hi=-Infinity;G.forEach(v=>{if(v!=null&&isFinite(v)){lo=Math.min(lo,v);hi=Math.max(hi,v)}});const out=[];if(!isFinite(lo)||!(iv>0))return out;
 for(let z=Math.ceil(lo/iv)*iv;z<=hi;z+=iv){const segs=[];for(let j=0;j<ny-1;j++)for(let i=0;i<nx-1;i++){const c=[[i,j],[i+1,j],[i+1,j+1],[i,j+1]].map(([a,b])=>[X0+a*dx,Y0+b*dy,G[b*nx+a]]);if(c.some(p=>p[2]==null||!isFinite(p[2])))continue;
  const q=[];for(let k=0;k<4;k++){const A=c[k],B=c[(k+1)%4];if((A[2]<z)!==(B[2]<z)){const t=(z-A[2])/(B[2]-A[2]);q.push([A[0]+t*(B[0]-A[0]),A[1]+t*(B[1]-A[1])])}}
  if(q.length===2)segs.push(q);else if(q.length===4)segs.push([q[0],q[1]],[q[2],q[3]])}if(segs.length)out.push({z:Math.round(z*100)/100,segs})}return out}
// slope % stats (central differences) over grid cells passing keep(x,y)
function shSlope(G,nx,ny,X0,Y0,dx,dy,keep){let s=0,n=0,mx=0,lo=Infinity,hi=-Infinity;for(let j=1;j<ny-1;j++)for(let i=1;i<nx-1;i++){const x=X0+i*dx,y=Y0+j*dy;if(keep&&!keep(x,y))continue;const v=G[j*nx+i];if(v==null)continue;lo=Math.min(lo,v);hi=Math.max(hi,v);
  const gx=(G[j*nx+i+1]-G[j*nx+i-1])/(2*dx),gy=(G[(j+1)*nx+i]-G[(j-1)*nx+i])/(2*dy);if(!isFinite(gx+gy))continue;const p=Math.hypot(gx,gy)*100;s+=p;n++;mx=Math.max(mx,p)}return n?{mean:s/n,max:mx,lo,hi,relief:hi-lo}:null}
// wrap monospace text to n chars (continuation lines indented 2)
function shWrap(t,n){t=String(t);if(t.length<=n)return [t];const o=[];let cur=t;while(cur.length>n){let k=cur.lastIndexOf(' ',n);if(k<n*.5)k=n;o.push(cur.slice(0,k).replace(/\s+$/,''));cur='  '+cur.slice(k).replace(/^\s+/,'')}if(cur.trim())o.push(cur);return o}

// ---- renderer. meta: {s, P (spProj), ext:{roads,streams}, N (spNB), polySrc, zone, src}
function tfSheet(r,meta,W,H){meta=meta||{};W=W||1500;H=H||960;const C=r.C,un=C.un,R=shOpen(C.Q.map(un)),E=r.E||{},Z=meta.zone||{},esc2=v=>String(v==null?'':v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
 const MW=Math.round(W*.64),TB=54,MH=H-TB;let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;R.forEach(([x,y])=>{x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y)});
 const pad=Math.max(x1-x0,y1-y0)*.12+80;x0-=pad;y0-=pad;x1+=pad;y1+=pad;const sc=Math.min((MW-40)/(x1-x0),(MH-40)/(y1-y0)),ox=20+((MW-40)-(x1-x0)*sc)/2,oy=20+((MH-40)-(y1-y0)*sc)/2;
 const X=x=>ox+(x-x0)*sc,Y=y=>oy+(y1-y)*sc,pts=a=>a.map(p=>X(p[0]).toFixed(1)+','+Y(p[1]).toFixed(1)).join(' '),poly=(a,st)=>`<polygon points="${pts(a)}" ${st}/>`,pl=(a,st)=>`<polyline points="${pts(a)}" fill="none" ${st}/>`;
 const rc=Rr=>{const [x,y,w,h]=Rr;return [[x,y],[x+w,y],[x+w,y+h],[x,y+h]].map(un)},txt=(x,y,t,o)=>`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" ${o||''}>${esc2(t)}</text>`;
 const PT=shPoints(1),ink='#1d1d1b',F='font-family="JetBrains Mono,monospace"',g=[],lab=[];
 const defs=`<defs><pattern id="hP" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><line x1="0" y1="0" x2="0" y2="9" stroke="#7b2cbf" stroke-width="1"/></pattern><pattern id="hE" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" stroke="#d62728" stroke-width="1.4"/></pattern><pattern id="hW" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#1f6fd1" stroke-width="1.1"/></pattern><pattern id="hX" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 0L8 8M8 0L0 8" stroke="#8a5a00" stroke-width=".8"/></pattern><clipPath id="shClip"><rect x="0" y="0" width="${MW}" height="${MH}"/></clipPath></defs>`;
 const vis=p=>p[0]>x0&&p[0]<x1&&p[1]>y0&&p[1]<y1,spIn2=(x,y,P)=>{let c=false;for(let i=0,j=P.length-1;i<P.length;j=i++){const a=P[i],b=P[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])c=!c}return c};
 // 1 boundary (points first so parcel corners are P1..Pn)
 const BC=R.map((p,i)=>PT.add(p,r.boundaryNeeded?'Assumed corner (no parcel)':'Parcel boundary corner'));
 // 1b topo contours (DEM) under everything; index contours every 5th interval labeled
 const ext0=meta.ext||{},T=ext0.topo;let topoS=null,topoIv=null;if(T&&T.G&&T.G.length===T.nx*T.ny){topoS=shSlope(T.G,T.nx,T.ny,T.X0,T.Y0,T.dx,T.dy,(x,y)=>spIn2(x,y,R));if(topoS){topoIv=shInterval(topoS.relief);
  shContours(T.G,T.nx,T.ny,T.X0,T.Y0,T.dx,T.dy,topoIv).forEach(({z,segs})=>{const idx=Math.abs(Math.round(z/topoIv))%5===0;g.push(`<path d="${segs.map(([p,q])=>'M'+X(p[0]).toFixed(1)+','+Y(p[1]).toFixed(1)+'L'+X(q[0]).toFixed(1)+','+Y(q[1]).toFixed(1)).join('')}" fill="none" stroke="#a0805a" stroke-width="${idx?1:.45}" stroke-opacity="${idx?.85:.6}"/>`);
   if(idx){const m=segs[Math.floor(segs.length/2)][0];if(vis(m))lab.push(txt(X(m[0]),Y(m[1])-2,Math.round(z)+"'",`${F} font-size="8" fill="#7a5c36" stroke="#fbfaf6" stroke-width="2.5" paint-order="stroke"`))}})}}
 // 2 water / flood / exclusions from the no-build set (local unrotated ft)
 const N=meta.N||{segs:[],polys:[]};
 (N.polys||[]).forEach(([RR,k])=>{const c=k===2?'#1f6fd1':k===3?'#8a5a00':'#d62728';g.push(poly(RR[0],`fill="url(#${k===2?'hW':k===3?'hX':'hE'})" stroke="${c}" stroke-width="1"`))});
 const ext=ext0,cl=[];
 (ext.streams||[]).forEach(L=>{L.forEach((p,i)=>{if(i)g.push(poly(shBand(L[i-1],p,ext.streamBuf||50),'fill="url(#hW)" stroke="none"'))});g.push(pl(L,'stroke="#1f6fd1" stroke-width="2.2"'));const e=[L[0],L[L.length-1]];e.forEach(p=>{if(vis(p))PT.add(p,'Stream (NHD) end / buffer limit')})});
 (ext.flood||[]).forEach(f=>{if(!f.nb)return;const r0=f.R[0]||[];if(!r0.length)return;let cx=0,cy=0;r0.forEach(p=>{cx+=p[0];cy+=p[1]});cx/=r0.length;cy/=r0.length;const inP=r0.filter(p=>vis(p)&&spIn2(p[0],p[1],R));const at=vis([cx,cy])?[cx,cy]:inP[0];if(at)lab.push(txt(X(at[0]),Y(at[1]),'FEMA ZONE '+f.zone+(f.bfe!=null?' BFE '+f.bfe:''),`${F} font-size="9.5" fill="#174f99" font-weight="bold" text-anchor="middle" stroke="#fbfaf6" stroke-width="2.5" paint-order="stroke"`))});
 // 2b transmission lines with assumed ROW band [A]; substations
 (ext.tx||[]).forEach(o=>{const w=o.row||100;o.L.forEach((p,i)=>{if(i)g.push(poly(shBand(o.L[i-1],p,w/2),'fill="url(#hP)" fill-opacity=".55" stroke="none"'))});g.push(pl(o.L,'stroke="#7b2cbf" stroke-width="1.8" stroke-dasharray="14 4 2 4"'));
  const VL=o.L.filter(vis),m=VL[Math.floor(VL.length/2)];if(m)lab.push(txt(X(m[0])+5,Y(m[1])+12,(o.kv?o.kv+' kV':'TRANSMISSION')+' '+(o.owner?o.owner.slice(0,24)+' ':'')+'('+w+"' ROW [A])",`${F} font-size="9.5" fill="#5a189a" font-weight="bold" stroke="#fbfaf6" stroke-width="2.5" paint-order="stroke"`))});
 shCross(R,(ext.tx||[]).map(o=>o.L)).forEach(p=>PT.add(p,'Transmission line at boundary'));
 (ext.subs||[]).forEach(o=>{if(o.R)g.push(poly(o.R,'fill="#e9d8fd" stroke="#5a189a" stroke-width="1"'));const p=o.at;if(!vis(p))return;lab.push(`<rect x="${X(p[0])-5}" y="${Y(p[1])-5}" width="10" height="10" fill="#7b2cbf" stroke="#fff"/>`+txt(X(p[0])+8,Y(p[1])+4,'SUB '+(o.name||'').slice(0,26)+(o.kv?' '+o.kv+' kV':''),`${F} font-size="9.5" fill="#5a189a" font-weight="bold"`));PT.add(p,'Substation (OSM)')});
 // 3 infrastructure: roads with ROW band, easements as hatched bands
 (ext.roads||[]).forEach(o=>{const w=o.row||60;o.L.forEach((p,i)=>{if(i)g.push(poly(shBand(o.L[i-1],p,w/2),'fill="#cfcac0" stroke="none"'))});g.push(pl(o.L,'stroke="#fff" stroke-width="1" stroke-dasharray="10 8"'));cl.push(o.L);
  const m=o.L[Math.floor(o.L.length/2)];if(vis(m)&&o.name)lab.push(txt(X(m[0])+4,Y(m[1])-4,o.name.toUpperCase()+' ('+w+"' ROW)",`${F} font-size="10" fill="#555"`))});
 (N.segs||[]).filter(q=>(q[5]||1)===1).forEach(q=>{const a=[q[0],q[1]],b=[q[2],q[3]];g.push(poly(shBand(a,b,q[6]!=null?q[6]/2:q[4]),'fill="url(#hE)" stroke="#d62728" stroke-width=".8"'));if(vis(a))PT.add(a,'Easement end'+(q[7]?' · '+q[7]:''));if(vis(b))PT.add(b,'Easement end'+(q[7]?' · '+q[7]:''))});
 const eL=(meta.easeLab||[]);eL.forEach(e=>{if(vis(e.at))lab.push(txt(X(e.at[0])+6,Y(e.at[1])+12,e.t,`${F} font-size="10" fill="#a01818"`))});
 // boundary line + vertices
 g.push(poly(R,`fill="${meta.polySrc==='square'?'none':'rgba(255,255,255,.0)'}" stroke="${ink}" stroke-width="2.4" ${meta.polySrc==='square'?'stroke-dasharray="12 6"':''}`));
 const CO=shCourses(R),per=CO.reduce((a,c)=>a+c.dist,0),many=CO.length>10;
 CO.forEach(c=>{const mx=(c.a[0]+c.b[0])/2,my=(c.a[1]+c.b[1])/2;let an=Math.atan2(-(c.b[1]-c.a[1]),c.b[0]-c.a[0])*180/Math.PI;if(an>90)an-=180;if(an<-90)an+=180;
  const short=c.dist*sc<150;lab.push(`<text ${F} font-size="10" fill="${ink}" text-anchor="middle" transform="translate(${X(mx).toFixed(1)},${Y(my).toFixed(1)}) rotate(${an.toFixed(1)}) translate(0,-6)">${esc2(many||short?'L'+c.n:c.brg+'  '+c.dist.toFixed(2)+"'")}</text>`)});
 // setbacks: dashed ring + per-edge dimension
 if(C.setRing&&C.setRing.length>2){const S=shOpen(C.setRing.map(un));g.push(poly(S,'fill="none" stroke="#b8860b" stroke-width="1.3" stroke-dasharray="8 5"'));S.forEach(p=>PT.add(p,'Setback line corner'))}
 if(C.rowRing&&C.rowRing.length>2)g.push(poly(C.rowRing.map(un),'fill="none" stroke="#c0392b" stroke-width="1" stroke-dasharray="3 3"'));
 C.edges.forEach(([a,b,s,h,k])=>{if(!(s>0))return;const A=un(a),B=un(b),L=shDist(A,B);if(L*sc<60)return;const mx=(A[0]+B[0])/2,my=(A[1]+B[1])/2,cx=(x0+x1)/2,cy=(y0+y1)/2;let nx=-(B[1]-A[1])/L,ny=(B[0]-A[0])/L;if(nx*(cx-mx)+ny*(cy-my)<0){nx=-nx;ny=-ny}
  const P2=[mx+nx*s,my+ny*s];lab.push(`<line x1="${X(mx)}" y1="${Y(my)}" x2="${X(P2[0])}" y2="${Y(P2[1])}" stroke="#b8860b" stroke-width=".8" marker-end="url(#ar)" marker-start="url(#ar)"/>`+txt(X(P2[0])+3,Y(P2[1])+11,Math.round(s)+"' "+String(k.kind||'').toUpperCase()+' SETBACK',`${F} font-size="9.5" fill="#8a6100"`))});
 // access points where roads touch / cross the boundary
 const AX=shCross(R,cl);AX.forEach((p,i)=>{const n=PT.add(p,'Access / road crossing at boundary');lab.push(`<path d="M${X(p[0])-6},${Y(p[1])}l6,-9l6,9z" fill="#F14B21"/>`+txt(X(p[0])+8,Y(p[1])+3,'ACCESS '+(i+1),`${F} font-size="9.5" fill="#b83a14" font-weight="bold"`))});
 // 4 detention pond as a basin with contour rings
 if(r.pond){const Q=rc(r.pond),[px,py,pw,ph]=r.pond;g.push(poly(Q,'fill="#a9cfe8" stroke="#1f4e79" stroke-width="1.2"'));for(let i=1;i<=3;i++){const d=Math.min(pw,ph)*.11*i;if(pw-2*d>4&&ph-2*d>4)g.push(poly(rc([px+d,py+d,pw-2*d,ph-2*d]),'fill="none" stroke="#1f4e79" stroke-width=".6" stroke-dasharray="4 3"'))}
  Q.forEach(p=>PT.add(p,'Detention pond top-of-bank corner'));const c=un([px+pw/2,py+ph/2]);lab.push(txt(X(c[0]),Y(c[1]),'DETENTION BASIN',`${F} font-size="10" fill="#0d3557" text-anchor="middle" font-weight="bold"`)+txt(X(c[0]),Y(c[1])+12,(r.sw?r.sw.Vac.toFixed(2)+' ac-ft req · ':'')+(pw*ph/43560).toFixed(2)+' ac',`${F} font-size="9.5" fill="#0d3557" text-anchor="middle"`))}
 // 5 buildings (only when a real boundary exists)
 const BS=[],bld=(Rr,fill,name,ph)=>{const Q=rc(Rr);g.push(poly(Q,`fill="${fill}" fill-opacity=".85" stroke="${ink}" stroke-width=".9"`));const ns=Q.map(p=>PT.add(p,name+' corner'));const c=un([Rr[0]+Rr[2]/2,Rr[1]+Rr[3]/2]);
  if(Rr[2]*sc>40&&Rr[3]*sc>14)lab.push(txt(X(c[0]),Y(c[1])+3,name+' '+Math.round(Rr[2])+"'×"+Math.round(Rr[3])+"'",`${F} font-size="${Math.min(10,Math.max(7,Rr[3]*sc/3))}" fill="#111" text-anchor="middle"`));BS.push([name,Math.round(Rr[2])+"×"+Math.round(Rr[3]),Math.round(Rr[2]*Rr[3]),ph||'',ns[0]+'–'+ns[3]])};
 if(!r.boundaryNeeded){if(r.co==='land'){r.halls.forEach((h,i)=>{bld(h.hall,TF_PH[(r.phase[i]-1)%8],'HALL '+(i+1),'P'+r.phase[i]);if(h.gen)bld(h.gen,'#9a9a9a','YARD '+(i+1),'P'+r.phase[i])});if(r.sub)bld(r.sub,'#ffd23f','SUBSTATION','P1');if(r.park)bld(r.park,'#bdbdbd','PARKING','P1')}
  else{if(r.mu)bld(r.mu,'#F14B21','CLIMATE-CTRL','');r.du.forEach((d,i)=>bld(d,'#f2b45a','DRIVE-UP '+(i+1),''));if(r.office)bld(r.office,'#ffffff','OFFICE','');r.rv.forEach((d,i)=>bld(d,'#7da7d9','RV/BOAT '+(i+1),''))}}
 // vertex markers on top
 const vx=PT.L.map(p=>{const b=p.n<=BC.length;return `<circle cx="${X(p.xy[0]).toFixed(1)}" cy="${Y(p.xy[1]).toFixed(1)}" r="${b?3.2:1.8}" fill="${b?ink:'#fff'}" stroke="${ink}" stroke-width=".8"/>`+(b||PT.L.length<160?txt(X(p.xy[0])+4,Y(p.xy[1])-4,(b?'P':'')+p.n,`${F} font-size="${b?10:7.5}" fill="${b?ink:'#444'}"${b?' font-weight="bold"':''}`):'')}).join('');
 if(r.boundaryNeeded)lab.push(`<rect x="${MW/2-230}" y="${MH/2-34}" width="460" height="68" fill="#fff" stroke="#F14B21" stroke-width="2"/>`+txt(MW/2,MH/2-6,'BOUNDARY NEEDED',`font-family="Jost,sans-serif" font-size="22" fill="#F14B21" text-anchor="middle"`)+txt(MW/2,MH/2+16,'No parcel polygon on file · dashed square = '+(r.site/43560).toFixed(2)+' ac around the pin · no buildings placed',`${F} font-size="9.5" fill="#333" text-anchor="middle"`));
 // furniture: north arrow, graphic scale
 const nb=shNice((x1-x0)/5),sx=30,sy=MH-26;let fur=`<g ${F} font-size="9" fill="${ink}"><rect x="${sx}" y="${sy}" width="${nb*sc/2}" height="5" fill="${ink}"/><rect x="${sx+nb*sc/2}" y="${sy}" width="${nb*sc/2}" height="5" fill="#fff" stroke="${ink}" stroke-width=".8"/>${txt(sx,sy+16,'0')}${txt(sx+nb*sc/2-6,sy+16,String(nb/2))}${txt(sx+nb*sc-8,sy+16,nb+' ft')}${txt(sx+nb*sc+16,sy+16,'GRAPHIC SCALE  1" ≈ '+Math.round(96/sc)+' ft @ 96 dpi')}</g>`;
 fur+=`<g transform="translate(${MW-50},56)"><path d="M0,-30L10,10L0,2L-10,10Z" fill="${ink}"/><text ${F} font-size="14" text-anchor="middle" y="-34" fill="${ink}">N</text></g>`;
 // right panel
 const b=r.build||{},AC=v=>v==null||!isFinite(v)?'—':v.toFixed(2),zt=(v,u)=>v==null?null:v+(u||''),tag=(v,t)=>v==null?'[A]':'['+t+']',lines=[];
 const H1=t=>lines.push(['h',t]),Ln=t=>lines.push(['t',t]);
 H1(((meta.s&&meta.s.name)||'Site')+' · SHEET C-1 · CONCEPT SITE PLAN');Ln('Parcel '+((meta.apn)||'—')+' · '+(meta.polySrc==='square'?'NO BOUNDARY ON FILE':'boundary '+(meta.bsrc||'GIS'))+' · '+((r.site||0)/43560).toFixed(2)+' ac gross');
 H1('DEVELOPABLE LAND BUDGET (ac)');[['Gross parcel',b.gross],['− ROW dedication',b.row],['− Public road ROW + setback',b.road],['− Setbacks & buffers',b.setback],['− Easements',b.easement],['− Streams + buffer (NHD)',b.stream],['− Transmission ROW [A]',b.power],['− Floodplain FEMA A/AE',b.flood],['− Other no-build',b.excl],['− Detention',b.pond],['= NET DEVELOPABLE',b.net]].forEach(([l,v])=>Ln(l.padEnd(30,'.')+AC(v).padStart(8)));
 H1('ZONING / SITE DATA');Ln('[Z]oneomics [C]ounty GIS [F]EMA NFHL [N]HD [T]IGER [H]IFLD [O]SM [U]SGS 3DEP [A]ssumed');
 Ln('District '+(Z.district||'—')+' '+(Z.has?'[Z]':'[A]')+' · use '+(Z.use||'not stated')+' '+(Z.use?'[Z]':'[A]'));
 Ln('Setbacks F/S/R '+(E.setF)+'/'+(E.setS)+'/'+(E.setR)+' ft '+(Z.front!=null?'[Z]':'[A]'));Ln('Max height '+(E.maxH===''||E.maxH==null?'—':E.maxH+' ft')+' '+tag(Z.maxH,'Z')+' · coverage '+(zt(Z.cov,'%')||'—')+' '+tag(Z.cov,'Z')+' · FAR '+(Z.far==null?'—':Z.far)+' '+tag(Z.far,'Z'));
 Ln('Boundary '+(meta.polySrc==='square'?'[A] square at pin':'[C] '+(meta.bsrc||'county GIS')));Ln('Roads '+((ext.roads||[]).length?((ext.roads||[]).some(o=>o.src==='TIGER')?'[T] Census TIGER centerlines':'[O] OSM centerlines')+((ext.roads||[]).some(o=>o.rail)?' + rail':'')+', ROW by class [A]':'none found / not loaded'));const SR=ext.src||{},ER=ext.errs||{};Ln('Streams '+((ext.streams||[]).length?'[N] '+(SR.streams||'NHD')+', '+(ext.streamBuf||50)+"' buffer each side [A]":ER.streams?'NOT LOADED ('+ER.streams.slice(0,60)+')':'none mapped ('+(SR.streams||'NHD')+')'));
 const TX=ext.tx||[];Ln('Power '+(TX.length?'['+(TX.some(o=>o.src==='HIFLD')?'H':'O')+'] '+[...new Set(TX.map(o=>o.kv?o.kv+' kV':'? kV'))].join(', ')+' transmission; ROW '+[...new Set(TX.map(o=>o.row))].join('/')+"' by voltage [A] (no recorded easement)":ER.tx?'NOT LOADED ('+ER.tx.slice(0,60)+')':'no transmission within 600 ft [H]')+((ext.subs||[]).length?' · substations: '+ext.subs.map(o=>o.name+(o.kv?' '+o.kv+' kV':'')).slice(0,3).join('; ')+' [O]':''));
 const FZ=[...new Set((ext.flood||[]).map(f=>f.zone))].filter(Boolean);Ln('Flood '+(FZ.length?'[F] '+(SR.flood||'FEMA NFHL')+' zones '+FZ.join(', ')+(b.flood>0?' · '+AC(b.flood)+' ac A/AE on parcel = no-build':' · none in SFHA on parcel'):ER.flood?'NOT LOADED ('+ER.flood.slice(0,60)+')':b.flood>0?'[F] FEMA NFHL SFHA/floodway':'[F] no SFHA within 600 ft'));
 Ln('Topo '+(topoS?'[U] '+(T.src||'USGS 3DEP')+' · '+topoIv+"' contours (index every "+topoIv*5+"') · elev "+Math.round(topoS.lo)+'–'+Math.round(topoS.hi)+" ft, relief "+Math.round(topoS.relief)+" ft · slope avg "+topoS.mean.toFixed(1)+'% max '+topoS.max.toFixed(1)+'%'+(topoS.max>15?' · steep areas >15% need grading review':topoS.mean<1?' · flat: confirm positive drainage (min 1%)':''):ER.topo?'NOT LOADED ('+ER.topo.slice(0,60)+')':'DEM not loaded'));Ln('Impervious '+(r.sw?(r.sw.imp*100).toFixed(1)+'%':'—')+' · detention '+(r.sw?r.sw.Vac.toFixed(2)+' ac-ft req [A] TR-55':'—'));
 if(BS.length){H1('BUILDING SCHEDULE');Ln('ID'.padEnd(14)+'Size ft'.padEnd(11)+'SF'.padStart(9)+'  Ph  Pts');BS.slice(0,14).forEach(q=>Ln(q[0].padEnd(14)+q[1].padEnd(11)+q[2].toLocaleString('en-US').padStart(9)+'  '+String(q[3]).padEnd(4)+q[4]));if(BS.length>14)Ln('… '+(BS.length-14)+' more (Points CSV)');
  Ln(r.co==='land'?'Total '+(r.k.it||0).toFixed(1)+' MW IT · '+(r.k.fac||0).toFixed(1)+' MW facility':'Total '+Math.round(r.nrsf||0).toLocaleString('en-US')+' NRSF')}
 H1('BOUNDARY COURSES');CO.slice(0,many?18:12).forEach(c=>Ln(('L'+c.n).padEnd(5)+('P'+c.from+'→P'+c.to).padEnd(10)+c.brg.padEnd(17)+(c.dist.toFixed(2)+"'").padStart(11)));if(CO.length>(many?18:12))Ln('… '+(CO.length-(many?18:12))+' more (Points CSV)');Ln('Perimeter '+shFt(per)+' · closure from GIS polygon');
 H1('POINT TABLE (lat, lon WGS84)');const PB=meta.P?p=>meta.P.b(p):null;PT.L.slice(0,22).forEach(p=>{const ll=PB?PB(p.xy):null;Ln(String(p.n).padEnd(4)+(ll?ll[1].toFixed(6)+', '+ll[0].toFixed(6):'').padEnd(24)+p.desc.slice(0,26))});if(PT.L.length>22)Ln('… '+(PT.L.length-22)+' more points (Points CSV)');
 // wrap to the panel width; shrink the font if the panel would overflow the map height
 let fs=9.2,WL=[];for(let it=0;it<6;it++){const n=Math.floor((W-MW-24)/(fs*.61)),nh=Math.floor((W-MW-24)/(fs*1.14*.61));WL=[];lines.forEach(([k,t])=>shWrap(t,k==='h'?nh:n).forEach(u=>WL.push([k,u])));const h=20+WL.reduce((a,[k])=>a+(k==='h'?fs*1.85:fs*1.36),0);if(h<=MH-6||fs<6.6)break;fs=Math.max(6.5,fs*(MH-6)/h*.99)}
 let ty=20;const pan=WL.map(([k,t])=>{ty+=k==='h'?fs*1.85:fs*1.36;return txt(MW+14,ty,t,k==='h'?`${F} font-size="${(fs*1.14).toFixed(2)}" font-weight="bold" fill="${ink}" xml:space="preserve"`:`${F} font-size="${fs.toFixed(2)}" fill="#333" xml:space="preserve"`)}).join('');
 const now=new Date().toISOString().slice(0,10),tb=`<rect x="0" y="${MH}" width="${W}" height="${TB}" fill="#fff" stroke="${ink}"/><text x="14" y="${MH+22}" font-family="Jost,sans-serif" font-size="17" font-weight="300" fill="${ink}">${esc2((r.co==='storage'?'EVERSTOW':'TERRAFICE')+'  |  '+((meta.s&&meta.s.name)||''))}</text>`+txt(14,MH+42,`SHEET C-1 · ${now} · ${((r.site||0)/43560).toFixed(2)} AC${r.co==='land'&&!r.boundaryNeeded?' · '+(r.k.it||0).toFixed(1)+' MW IT':''} · APN ${meta.apn||'—'}`,`${F} font-size="10" fill="#333"`)+txt(W-14,MH+32,'CONCEPTUAL — NOT FOR CONSTRUCTION · NOT A SURVEY',`${F} font-size="12" fill="#F14B21" text-anchor="end" font-weight="bold"`);
 const leg=[['#cfcac0','Public road ROW'],['url(#hE)','Easement'],['url(#hW)','Stream / FEMA A,AE'],['url(#hP)','Transmission ROW'],['#a9cfe8','Detention'],['none','Setback (dashed)'],['#a0805a','Contour']].map(([c,t],i)=>`<rect x="${30+i*112}" y="${MH-52}" width="12" height="9" fill="${c}" stroke="${ink}" stroke-width=".5"/>`+txt(46+i*112,MH-44,t,`${F} font-size="9" fill="${ink}"`)).join('');
 tfSheet._last=PT.L;
 return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" style="background:#fbfaf6;display:block">${defs.replace('</defs>','<marker id="ar" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0L6,3L0,6z" fill="#b8860b"/></marker></defs>')}<rect x="0" y="0" width="${MW}" height="${MH}" fill="#fbfaf6" stroke="${ink}"/><g clip-path="url(#shClip)">${g.join('')}${lab.join('')}${vx}</g>${fur}${leg}<line x1="${MW}" y1="0" x2="${MW}" y2="${MH}" stroke="${ink}"/>${pan}${tb}</svg>`}
// CSV of every numbered point (for the export button)
function shPointsCsv(r,meta){const s=tfSheetPts(r,meta);return 'point,description,lat,lon,x_ft,y_ft\n'+s.map(p=>{const ll=meta.P?meta.P.b(p.xy):[NaN,NaN];return [p.n,'"'+p.desc+'"',ll[1].toFixed(7),ll[0].toFixed(7),p.xy[0].toFixed(2),p.xy[1].toFixed(2)].join(',')}).join('\n')}
function tfSheetPts(r,meta){tfSheet(r,meta);return tfSheet._last||[]}
