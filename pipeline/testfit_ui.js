// ---- Site Plan deal list: deals enter ONLY by an explicit "Add to Site Plan" (no stage/score auto-add). Stored per browser.
const TFL_K='edks_sp_in';
function tfList(co){try{const o=JSON.parse(localStorage.getItem(TFL_K)||'{}');return Array.isArray(o[co])?o[co]:[]}catch(e){return []}}
function tfInList(co,id){return tfList(co).includes(id)}
function tfSetList(co,L){let o={};try{o=JSON.parse(localStorage.getItem(TFL_K)||'{}')||{}}catch(e){}o[co]=L;try{localStorage.setItem(TFL_K,JSON.stringify(o))}catch(e){}}
function tfAddDeal(co,id){if(!id)return;const L=tfList(co);if(!L.includes(id)){L.push(id);tfSetList(co,L)}location.hash='#plan/'+co+'/'+id;if(SP.co===co&&SP.id===id)spShow(id,co)}
function tfDelDeal(co,id){tfSetList(co,tfList(co).filter(x=>x!==id));try{localStorage.removeItem('edks_tf_'+co+'_'+id)}catch(e){}if(SP.id===id){SP.id=null;spShow('',co)}}
spSites=function(co){co=co||SP.co;const A=co==='storage'?SR:S,L=tfList(co);return A.filter(s=>L.includes(s.id)&&s.lat&&s.lon).slice().sort((a,b)=>String(a.name).localeCompare(String(b.name)))};
// ---- configurator UI
const TF={I:null,key:null,r:null,undo:[],chat:[],opts:[],cmp:[],raf:0,url:null};
const TF_SL={land:[['Program',[['halls','Data halls',0,40,1],['hallMW','IT MW / hall',1,60,.5],['pue','PUE',1.05,1.8,.01],['stories','Stories',1,4,1],['phases','Phases',1,8,1]]],
 ['Prototype',[['hallW','Hall width ft',100,400,10],['hallL','Hall length ft',200,1500,25],['genAc','Gen/cooling yard ac/hall',0,6,.25],['subAc','Substation ac',0,20,.5],['park','Parking / hall',0,150,1]]],
 ['Site',[['setF','Front setback ft',0,400,5],['setS','Side setback ft',0,400,5],['setR','Rear setback ft',0,400,5],['lane','Fire lane ft',20,60,1],['rot','Row orientation °',0,179,1]]]],
 storage:[['Product',[['stories','CC storeys',1,6,1],['mW','CC depth ft',60,200,5],['duW','Drive-up depth ft',20,60,1],['aisle','Drive aisle ft',20,40,1],['office','Office sf',0,5000,100],['rv','RV/boat stalls',0,200,1]]],
 ['Unit mix %',[['mix5x5','5x5',0,100,1],['mix5x10','5x10',0,100,1],['mix10x10','10x10',0,100,1],['mix10x15','10x15',0,100,1],['mix10x20','10x20',0,100,1],['mix10x30','10x30',0,100,1]]],
 ['Site',[['setF','Front setback ft',0,200,5],['setS','Side setback ft',0,200,5],['setR','Rear setback ft',0,200,5],['rot','Row orientation °',0,179,1]]]]};
const TF_SEL={land:[['cool','Cooling',['air','liquid','hybrid']],['subPos','Substation',['auto','N','S','E','W','NE','NW','SE','SW']],['front','Front faces',['S','N','E','W']]],storage:[['mode','Layout',[['hy','Hybrid'],['du','All drive-up'],['mu','All climate-controlled']]],['front','Front faces',['S','N','E','W']]]};
const TF_KPI={land:[['it','IT MW',1],['fac','Facility MW',1],['halls','Halls',0],['cov','Coverage %',1],['far','FAR',3],['stalls','Parking',0]],storage:[['nrsf','Net rentable sf',0],['units','Units',0],['cov','Coverage %',1],['gsf','Gross sf',0],['rv','RV/boat',0]]};
const tfK=(s)=>'edks_tf_'+SP.co+'_'+s.id;
function tfCtxFor(s){const P=spProj(+s.lat,+s.lon),R=SP.poly.map(P.f),N=spNB(s,SP.inp),ge=SP.co==='storage'?null:spGridEst(s);
 return {P,R,ctx:{gridMW:ge?(SP.inp.gridOv!==''&&SP.inp.gridOv!=null?+SP.inp.gridOv:ge.mw):null,gridWhy:ge?(ge.cap?'site cap':'estimate'):'',nb:(x,y)=>spNBhit(x,y,N)>0,zone:tfZone(SPX.zn[s.id],SP.co)}}}
function tfMount(s){const host=$('viewPlan');let el=$('tfX');if(!el){el=document.createElement('section');el.id='tfX';el.className='tf';$('spX').before(el);tfWire(el)}
 ['sp-bldf','sp-hallf','sp-halll','sp-plantf','sp-subf','sp-flagf','sp-flagl'].forEach(k=>SP.map&&SP.map.getLayer(k)&&SP.map.setLayoutProperty(k,'visibility','none'));
 const co=SP.co,inL=s&&tfInList(co,s.id),A=(co==='storage'?SR:S).filter(x=>!tfInList(co,x.id)&&!(typeof hidK==='function'&&hidK(co,x.id)));
 const add=`<div class="tfadd"><label class="lbl mono" for="tfAddQ">Add deal</label><input id="tfAddQ" class="inp mono" list="tfAddL" placeholder="Search ${co==='storage'?'Everstow':'Terrafice'} pipeline"><datalist id="tfAddL">${A.map(x=>`<option value="${esc(x.name)}" data-id="${esc(x.id)}">`).join('')}</datalist><button class="tbtn" type="button" id="tfAddB">Add to Site Plan</button>${inL?`<button class="tbtn" type="button" id="tfDelB">Remove from Site Plan</button>`:''}</div>`;
 if(!s||!inL){el.innerHTML=`<div class="tfhd"><h3>Configurator</h3>${add}</div><p class="lbl mono">${s?'This deal is not in Site Plan. Add it to plan it.':'No deals in Site Plan yet. Add one from the pipeline.'}</p>`;tfMapClear();return}
 const key=co+'/'+s.id;if(TF.key!==key){TF.key=key;TF.undo=[];TF.chat=[];TF.opts=[];TF.cmp=[];let p=null;try{p=JSON.parse(localStorage.getItem(tfK(s))||'null')}catch(e){}
  TF.I=Object.assign({},TF_DEF[co],SP.inp.tf||{},p||{});if(co==='land'&&!p){const ge=spGridEst(s),cap=SP.inp.gridOv!==''&&SP.inp.gridOv!=null?+SP.inp.gridOv:ge.mw;if(cap>0)TF.I.halls=Math.max(1,Math.ceil(cap/TF.I.pue/TF.I.hallMW))}
  el.innerHTML=`<div class="tfhd"><h3>Configurator <span class="lbl mono">live solve · TestFit-style</span></h3>${add}</div><div class="tfbadges" id="tfBadges"></div>
  <div class="tfgrid"><aside class="tfin" id="tfIn"></aside><div class="tfmid"><div class="tfkpi" id="tfKpi"></div><div class="tfplan" id="tfPlan"></div><div id="tfChk"></div>
  <div class="btns"><button class="tbtn" type="button" id="tfGen">Generate options</button><button class="tbtn" type="button" id="tfSave">Save scheme</button><button class="tbtn" type="button" id="tfPng">Export PNG</button><button class="tbtn" type="button" id="tfGeo">GeoJSON</button><button class="tbtn" type="button" id="tfDxf">DXF</button><span class="lbl mono" id="tfMsg"></span></div>
  <div id="tfOpts"></div><div id="tfCmp"></div></div>
  <aside class="tfchat"><div class="lbl mono">Chat to modify <span id="tfEng"></span></div><div class="tflog" id="tfLog"></div><form id="tfF"><input id="tfQ" class="inp mono" autocomplete="off" placeholder="e.g. add a second hall · setbacks to 100 ft"><button class="tbtn" type="submit">Send</button><button class="tbtn" type="button" id="tfUndo">Undo</button></form></aside></div>`;tfForm()}
 else{const a=el.querySelector('.tfadd');if(a)a.outerHTML=add}
 Promise.resolve(spxZn(s)).then(()=>{if(spSite()===s)tfRun()})}
function tfForm(){const co=SP.co,I=TF.I;$('tfIn').innerHTML=TF_SL[co].map(([h,F])=>`<div class="spsec"><div class="lbl mono">${h}</div>${F.map(([k,l,a,b,st])=>`<label class="tfsl"><span>${l}</span><input type="range" data-tf="${k}" min="${a}" max="${b}" step="${st}" value="${esc(I[k])}"><input class="inp mono" type="number" data-tf="${k}" step="${st}" value="${esc(I[k])}"></label>`).join('')}</div>`).join('')+
 `<div class="spsec"><div class="lbl mono">Options</div>${TF_SEL[co].map(([k,l,O])=>`<label class="spf"><span>${l}</span><select class="inp mono" data-tf="${k}">${O.map(o=>{const [v,t]=Array.isArray(o)?o:[o,o];return `<option value="${v}"${String(I[k])===v?' selected':''}>${t}</option>`}).join('')}</select></label>`).join('')}</div>`}
function tfRun(){const s=spSite();if(!s||!TF.I)return;const {P,R,ctx}=tfCtxFor(s),r=tfSolve(SP.co,R,TF.I,ctx);TF.r=r;TF.P=P;TF.ctx=ctx;try{localStorage.setItem(tfK(s),JSON.stringify(TF.I))}catch(e){}tfOut(s,r);tfDraw(r)}
function tfFmt(v,d){return v==null?'—':spN(v,d)}
function tfOut(s,r){const co=SP.co,Z=r&&TF.ctx.zone,E=r.E;
 const bd=[];if(Z&&Z.has)bd.push(`<span class="spbadge">ZONING ${esc(Z.district||'')}</span>`);else bd.push('<span class="spbadge spest">ZONING: NO DATA · DEFAULTS</span>');
 r.warn.filter(w=>w.k==='use'||w.k==='height').forEach(w=>bd.push(`<span class="spbadge tfwarn">${esc(w.t)}</span>`));
 if(co==='land')bd.push(`<span class="spbadge">GRID ${tfFmt(TF.ctx.gridMW,0)} MW · ${esc(TF.ctx.gridWhy)}</span>`);
 if(Z&&Z.has)bd.push(`<span class="lbl mono">Setbacks used ${E.setF}/${E.setS}/${E.setR} ft · height ${E.maxH===''||E.maxH==null?'—':E.maxH+' ft'}</span>`);$('tfBadges').innerHTML=bd.join(' ');
 $('tfKpi').innerHTML=TF_KPI[co].map(([k,l,d])=>`<div class="tfk"><div class="lbl mono">${l}</div><b class="mono">${tfFmt(r.k[k],d)}</b></div>`).join('')+`<div class="tfk"><div class="lbl mono">Binding</div><b class="mono">${esc(r.bind)}</b></div>`;
 const ph=co==='land'?`<div class="lbl mono">Phasing ${r.phMW.map((m,i)=>'P'+(i+1)+' '+spN(m,1)+' MW').join(' · ')} · height ${r.height} ft · ${r.n}/${r.want} halls placed${r.capIT!=null?' · cap '+spN(r.capIT,1)+' MW IT':''}</div>`:`<div class="lbl mono">Mix ${r.mix.map(([k,n])=>k+' '+n).join(' · ')} · avg ${spN(r.avg)} sf · CC ${r.stories} storeys</div>`;
 $('tfChk').innerHTML=ph+r.circ.concat(r.warn.filter(w=>w.k!=='use'&&w.k!=='height').map(w=>({ok:false,t:w.t}))).map(c=>`<div class="lbl mono ${c.ok?'':'tfbad'}">${c.ok?'OK':'CHECK'} · ${esc(c.t)}</div>`).join('');
 $('tfPlan').innerHTML=tfSvg(r,520,300);$('tfEng').textContent=tfUrl()?'· AI':'· rules';tfLog();tfOptsR();tfCmpR()}
// features in lon/lat for map + exports
function tfFeats(r){const P=TF.P,F=[],q=(R,kind,lab)=>{const [x,y,w,h]=R,c=[[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]].map(p=>P.b(r.C.un(p)));F.push({type:'Feature',properties:{kind,label:lab||kind},geometry:{type:'Polygon',coordinates:[c]}})};
 if(r.co==='land'){r.halls.forEach((h,i)=>{q(h.hall,'hall','Hall '+(i+1)+' · P'+r.phase[i]);if(h.gen)q(h.gen,'yard','Gen/cooling yard')});if(r.sub)q(r.sub,'sub','Substation');if(r.park)q(r.park,'park','Parking '+r.stalls)}
 else{if(r.mu)q(r.mu,'cc','Climate-controlled · '+r.stories+' storeys');r.du.forEach(d=>q(d,'du','Drive-up'));if(r.office)q(r.office,'office','Office');r.rv.forEach(d=>q(d,'rv','RV/boat'))}return F}
const TF_COL={hall:'#F14B21',yard:'#7a7a7a',sub:'#ffd23f',park:'#4a4a4a',cc:'#F14B21',du:'#c9a227',office:'#ffffff',rv:'#5a5a5a'};
function tfDraw(r){const m=SP.map;if(!m)return;const fc={type:'FeatureCollection',features:tfFeats(r)};if(!m.getSource('tf-geo')){m.addSource('tf-geo',{type:'geojson',data:fc});
 m.addLayer({id:'tf-f',type:'fill',source:'tf-geo',paint:{'fill-color':['match',['get','kind'],...Object.entries(TF_COL).flat(),'#888'],'fill-opacity':.55}});m.addLayer({id:'tf-l',type:'line',source:'tf-geo',paint:{'line-color':'#fff','line-width':1}})}else m.getSource('tf-geo').setData(fc)}
function tfMapClear(){const m=SP.map;if(m&&m.getSource('tf-geo'))m.getSource('tf-geo').setData({type:'FeatureCollection',features:[]})}
function tfSvg(r,W,H){const C=r.C,pts=C.Q,[x0,y0,x1,y1]=C.bb,sc=Math.min((W-20)/(x1-x0||1),(H-20)/(y1-y0||1)),X=x=>10+(x-x0)*sc,Y=y=>H-10-(y-y0)*sc,rect=(R,c,o)=>`<rect x="${X(R[0])}" y="${Y(R[1]+R[3])}" width="${R[2]*sc}" height="${R[3]*sc}" fill="${c}" fill-opacity="${o||.7}" stroke="#fff" stroke-width=".5"/>`;
 let g=`<polygon points="${pts.map(p=>X(p[0])+','+Y(p[1])).join(' ')}" fill="none" stroke="#9A9A9A" stroke-dasharray="4 3"/>`;
 if(r.co==='land'){r.halls.forEach(h=>{g+=rect(h.hall,TF_COL.hall);if(h.gen)g+=rect(h.gen,TF_COL.yard)});if(r.sub)g+=rect(r.sub,TF_COL.sub);if(r.park)g+=rect(r.park,TF_COL.park)}else{if(r.mu)g+=rect(r.mu,TF_COL.cc);r.du.forEach(d=>g+=rect(d,TF_COL.du));if(r.office)g+=rect(r.office,TF_COL.office);r.rv.forEach(d=>g+=rect(d,TF_COL.rv))}
 return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" style="background:#000;display:block">${g}</svg>`}
function tfLog(){const el=$('tfLog');if(!el)return;el.innerHTML=TF.chat.map(c=>`<div class="tfmsg ${c.who}"><span class="lbl mono">${c.who==='u'?'You':'Plan'}</span> ${esc(c.t)}${c.diff?`<div class="mono tfdiff">${c.diff}</div>`:''}</div>`).join('');el.scrollTop=1e6}
function tfDiff(a,b){return TF_KPI[SP.co].filter(([k])=>a[k]!==b[k]).map(([k,l,d])=>`${l}: ${tfFmt(a[k],d)} → ${tfFmt(b[k],d)}`).join('<br>')||('No change in metrics'+(TF.r&&TF.r.bind?' · binding: '+TF.r.bind:''))}
// LLM adapter: POST to the kmask plan-edit endpoint when configured; any failure falls back to the rule parser
function tfUrl(){const u=window.EDKS_PLAN_EDIT_URL||(()=>{try{return localStorage.getItem('edks_plan_edit_url')}catch(e){return null}})()||TF_EDIT_SCHEMA.url;return u==='off'?null:u}
async function tfInterpret(text){const u=tfUrl(),co=SP.co,rb=tfParse(text,co,TF.I);if(rb.undo||rb.goal)return Object.assign({src:'rules'},rb);
 if(u&&window.EDKS_BK&&EDKS_BK.idToken){try{const tok=await EDKS_BK.idToken();if(tok){const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),6000);
  const res=await fetch(u,{method:'POST',signal:ac.signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+tok},body:JSON.stringify({message:text.slice(0,500),schema:tfEditSchemaFor(co),params:TF.I})});clearTimeout(tm);
  if(res.ok){const j=await res.json();if(j&&j.changes&&typeof j.changes==='object'){const ops=Object.entries(j.changes).filter(([,v])=>v!=null).map(([k,v])=>({k,v}));
   if(ops.length||!rb.ops.length)return {src:'ai',ops,goal:null,reply:j.reply||(ops.length?'Updated':'No change')}}}}}catch(e){}}
 return Object.assign({src:'rules'},rb)}
async function tfChat(text){if(!text.trim())return;TF.chat.push({who:'u',t:text});tfLog();const a=await tfInterpret(text),before=TF.r.k;
 if(a.undo){tfUndo();return}if(!a.ops.length&&!a.goal){TF.chat.push({who:'p',t:a.reply});tfLog();return}
 TF.undo.push(Object.assign({},TF.I));TF.I=tfApplyOps(SP.co,TF.I,a.ops);
 if(a.goal){const X=tfCtxFor(spSite()),O=tfGen(SP.co,X.R,TF.I,X.ctx);O.sort((x,y)=>(y.k[a.goal]||0)-(x.k[a.goal]||0));if(O[0])TF.I=Object.assign({},O[0].p)}
 tfForm();tfRun();TF.chat.push({who:'p',t:a.reply,diff:tfDiff(before,TF.r.k)});tfLog()}
function tfUndo(){const p=TF.undo.pop();if(!p){TF.chat.push({who:'p',t:'Nothing to undo'});tfLog();return}const b=TF.r.k;TF.I=p;tfForm();tfRun();TF.chat.push({who:'p',t:'Undone',diff:tfDiff(b,TF.r.k)});tfLog()}
function tfOptsR(){const el=$('tfOpts');if(!el)return;if(!TF.opts.length){el.innerHTML='';return}const K=TF_KPI[SP.co];
 el.innerHTML=`<table class="tftab"><thead><tr><th>#</th>${K.map(([,l])=>`<th>${l}</th>`).join('')}<th>Rows °</th><th>Binding</th><th>Flags</th><th></th><th>Compare</th></tr></thead><tbody>${TF.opts.map((o,i)=>`<tr><td class="mono">${i+1}</td>${K.map(([k,,d])=>`<td class="mono">${tfFmt(o.k[k],d)}</td>`).join('')}<td class="mono">${o.p.rot}</td><td>${esc(o.bind)}</td><td class="mono">${o.warn}</td><td><button class="tbtn" type="button" data-tfa="${i}">Apply</button></td><td><input type="checkbox" data-tfc="${i}"${TF.cmp.includes(i)?' checked':''}></td></tr>`).join('')}</tbody></table>`}
function tfCmpR(){const el=$('tfCmp');if(!el)return;const s=spSite();if(!TF.cmp.length||!s){el.innerHTML='';return}const {R,ctx}=tfCtxFor(s);
 el.innerHTML=`<div class="tfcmp">${TF.cmp.slice(0,3).map(i=>{const o=TF.opts[i];if(!o)return '';const r=tfSolve(SP.co,R,o.p,ctx);return `<div><div class="lbl mono">Option ${i+1}</div>${tfSvg(r,300,180)}${TF_KPI[SP.co].map(([k,l,d])=>`<div class="lbl mono">${l} <b>${tfFmt(r.k[k],d)}</b></div>`).join('')}</div>`}).join('')}</div>`}
function tfDl(name,blob){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},500)}
function tfDxf(r){const L=['0','SECTION','2','ENTITIES'],poly=(pts,layer)=>{L.push('0','LWPOLYLINE','8',layer,'90',String(pts.length),'70','1');pts.forEach(p=>L.push('10',p[0].toFixed(2),'20',p[1].toFixed(2)))},q=(R,ly)=>{const [x,y,w,h]=R;poly([[x,y],[x+w,y],[x+w,y+h],[x,y+h]].map(r.C.un),ly)};
 poly(tfCtxFor(spSite()).R.slice(0,-1),'BOUNDARY');if(r.co==='land'){r.halls.forEach(h=>{q(h.hall,'HALL');if(h.gen)q(h.gen,'YARD')});if(r.sub)q(r.sub,'SUBSTATION');if(r.park)q(r.park,'PARKING')}else{if(r.mu)q(r.mu,'CLIMATE');r.du.forEach(d=>q(d,'DRIVEUP'));if(r.office)q(r.office,'OFFICE');r.rv.forEach(d=>q(d,'RV'))}
 L.push('0','ENDSEC','0','EOF');return L.join('\n')}
async function tfSaveScheme(){const s=spSite(),B=spxBK(),r=TF.r;if(!s||!r||!tfInList(SP.co,s.id))return;const co=SP.co,R=x=>Math.round(x*1e6)/1e6;
 const g={poly:SP.poly.map(p=>[R(p[0]),R(p[1])]),b:tfFeats(r).slice(0,60).map(f=>({t:f.properties.kind,c:f.geometry.coordinates[0].slice(0,4).flat().map(R)}))};
 const nm=(co==='storage'?spN(r.k.nrsf)+' NRSF':spN(r.k.it,1)+' MW IT · '+r.n+' halls')+' · TF · '+new Date().toLocaleDateString();
 const d={site_id:s.id,co,name:nm.slice(0,80),v:2,k:Object.assign({},r.k),bind:r.bind,zbind:'',circ:r.circ.filter(c=>!c.ok).map(c=>c.id),jur:'',p:JSON.stringify(Object.assign({},SP.inp,{tf:TF.I})).slice(0,8000),g:JSON.stringify(g).slice(0,24000),restricted:!!(typeof RIDS!=='undefined'&&RIDS.has&&RIDS.has(s.id))};
 if(!B){$('tfMsg').textContent='No Firestore connection: not saved';return}try{const id=await B.savePlan(d);const L=SPX.saved[co+'/'+s.id]||(SPX.saved[co+'/'+s.id]={list:[],st:'ok'});L.list.unshift(Object.assign({id,ts:new Date().toISOString(),by:B.email},d));$('tfMsg').textContent='Saved "'+d.name+'" (1 write)';spxSavedRender(s)}catch(e){$('tfMsg').textContent='Save failed: '+e.message}}
function tfWire(el){const sched=()=>{cancelAnimationFrame(TF.raf);TF.raf=requestAnimationFrame(tfRun)};
 el.addEventListener('input',e=>{const t=e.target,k=t.dataset.tf;if(!k||!TF.I)return;TF.I[k]=t.tagName==='SELECT'?t.value:+t.value;el.querySelectorAll(`[data-tf="${k}"]`).forEach(x=>{if(x!==t)x.value=t.value});sched()});
 el.addEventListener('change',e=>{const t=e.target;if(t.dataset.tf&&!TF.undo.length)TF.undo.push(Object.assign({},TF.I));if(t.dataset.tfc!=null){const i=+t.dataset.tfc;TF.cmp=t.checked?TF.cmp.concat(i).slice(-3):TF.cmp.filter(x=>x!==i);tfCmpR()}});
 el.addEventListener('submit',e=>{e.preventDefault();const q=$('tfQ');const v=q.value;q.value='';tfChat(v)});
 el.addEventListener('click',e=>{const id=e.target.id,s=spSite(),co=SP.co;
  if(id==='tfAddB'){const v=$('tfAddQ').value.trim(),A=co==='storage'?SR:S,x=A.find(y=>y.name===v||y.id===v);if(x)tfAddDeal(co,x.id);else $('tfAddQ').value=''}
  else if(id==='tfDelB'&&s)tfDelDeal(co,s.id);else if(id==='tfUndo')tfUndo();else if(id==='tfSave')tfSaveScheme();
  else if(id==='tfGen'&&s){$('tfMsg').textContent='Generating…';setTimeout(()=>{const {R,ctx}=tfCtxFor(s);TF.opts=tfGen(co,R,TF.I,ctx);TF.cmp=[];$('tfMsg').textContent=TF.opts.length+' options ranked by '+(co==='storage'?'NRSF':'IT MW');tfOptsR();tfCmpR()},20)}
  else if(id==='tfGeo'&&TF.r)tfDl(s.id+'-plan.geojson',new Blob([JSON.stringify({type:'FeatureCollection',features:tfFeats(TF.r)})],{type:'application/geo+json'}));
  else if(id==='tfDxf'&&TF.r)tfDl(s.id+'-plan.dxf',new Blob([tfDxf(TF.r)],{type:'application/dxf'}));
  else if(id==='tfPng'&&TF.r){const svg=tfSvg(TF.r,1600,1000).replace('width="100%"','width="1600" height="1000"'),img=new Image();img.onload=()=>{const c=document.createElement('canvas');c.width=1600;c.height=1100;const x=c.getContext('2d');x.fillStyle='#0A0A0A';x.fillRect(0,0,1600,1100);x.drawImage(img,0,0);x.fillStyle='#fff';x.font='22px JetBrains Mono, monospace';x.fillText(s.name+' · '+TF_KPI[co].map(([k,l,d])=>l+' '+tfFmt(TF.r.k[k],d)).join(' · '),20,1060);c.toBlob(b=>tfDl(s.id+'-plan.png',b))};img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg)}
  const a=e.target.closest('[data-tfa]');if(a){TF.undo.push(Object.assign({},TF.I));TF.I=Object.assign({},TF.opts[+a.dataset.tfa].p);tfForm();tfRun()}})}
const spRunTF0=spRun;spRun=function(){spRunTF0();tfMount(spSite())};
