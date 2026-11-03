// ---- Site Plan chat-edit contract (single source of truth; render.py inlines this file into the app).
// Matches kmask POST /plan_edit (llm_search/main.py). URL: TF_EDIT_SCHEMA.url, overridable via window.EDKS_PLAN_EDIT_URL
// or localStorage edks_plan_edit_url ('off' disables the LLM and uses the rule parser only).
// Client -> server: headers Authorization: Bearer <Firebase ID token>, Content-Type: application/json
//   body: {message:"<user text, <=500 chars>", schema:tfEditSchemaFor(co), params:{...current params}}
//   schema: {<key>:{type:"number"|"integer"|"string", min?, max?, enum?, desc}} built from keys[co] below (<=40 keys).
// Server -> client: {changes:{<key>:<new value>}, reply:"<one short sentence>", model}
//   The client drops unknown keys and clamps to [min,max] again (tfApplyOps).
// Goals ("maximize NRSF"), undo and "regenerate" are handled locally by the rule parser (tfParse) before any call.
// Errors: non-200, timeout (4 s) or malformed JSON -> rule parser fallback.
const TF_EDIT_SCHEMA={v:1,
 keys:{
  land:{halls:['Data halls (count)',0,40,1],hallW:['Hall width ft',80,400,10],hallL:['Hall length ft',150,1500,25],stories:['Hall stories',1,4,1],
   hallMW:['IT MW per hall',1,120,0.5],pue:['Design PUE',1.05,2,0.01],subAc:['Substation acres',0,30,0.5],genAc:['Generator yard acres per hall',0,10,0.25],
   cool:['Cooling: air|liquid|hybrid'],setF:['Front setback ft',0,500,5],setS:['Side setback ft',0,500,5],setR:['Rear setback ft',0,500,5],
   lane:['Fire lane / drive width ft',20,60,1],park:['Parking stalls per hall',0,200,1],phases:['Phases',1,8,1],rot:['Row orientation deg',0,179,1],
   subPos:['Substation position: auto|N|S|E|W|NE|NW|SE|SW'],maxH:['Max height ft (zoning)',0,400,1],cov:['Max coverage % (zoning)',0,100,1]},
  storage:{mode:['Product: du|mu|hy'],stories:['Climate-controlled stories',1,6,1],mW:['Multi-storey building depth ft',60,200,5],
   duW:['Drive-up building depth ft',20,60,1],aisle:['Drive aisle ft',20,40,1],office:['Office sq ft',0,5000,100],rv:['RV/boat stalls',0,300,1],
   setF:['Front setback ft',0,200,5],setS:['Side setback ft',0,200,5],setR:['Rear setback ft',0,200,5],rot:['Row orientation deg',0,179,1],
   mix5x5:['Unit mix % 5x5',0,100,1],mix5x10:['Unit mix % 5x10',0,100,1],mix10x10:['Unit mix % 10x10',0,100,1],mix10x15:['Unit mix % 10x15',0,100,1],
   mix10x20:['Unit mix % 10x20',0,100,1],mix10x30:['Unit mix % 10x30',0,100,1],maxH:['Max height ft (zoning)',0,200,1],cov:['Max coverage % (zoning)',0,100,1]}},
 goals:{land:['it','score'],storage:['nrsf','units','score']},
 path:'/plan_edit',url:'https://kmask-312620064853.us-central1.run.app/plan_edit'};
function tfEditSchemaFor(co){const o={};for(const [k,a] of Object.entries(TF_EDIT_SCHEMA.keys[co])){if(a.length>1)o[k]={type:Number.isInteger(a[3])&&Number.isInteger(a[1])?'integer':'number',min:a[1],max:a[2],desc:a[0]};
 else{const m=a[0].split(': ');o[k]={type:'string',enum:m[1]?m[1].split('|'):[],desc:a[0]}}}return o}
