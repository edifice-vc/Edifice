#!/usr/bin/env python3
"""Generate OSI (Apache Ossie) 0.1.1 semantic models for SunflowerOS from repo configs,
dc-references standards and durable memory facts. Public models -> ./*.yaml ; confidential -> ./private/."""
import json, yaml, os
H=os.path.dirname(os.path.abspath(__file__)); os.chdir(H)
R=os.path.join(H,"..","pipeline"); ST=os.path.join(H,"sources","standards.json"); PRIVF=os.path.join(H,"private","private_facts.json")
V="0.1.1"; VEN="COMMON"; NS="edifice_sunflower"   # 0.1.1 vendor enum has no custom vendors; namespace inside data
def X(**d): return [{"vendor_name":VEN,"data":json.dumps(dict(d,namespace=NS),sort_keys=True)}]
def F(n,e,dt=None,desc="",syn=None,time=None,**prov):
    # 0.1.1: ANSI_SQL over a flattened export (column = field name); Firestore JSON path + datatype in the extension
    f={"name":n,"expression":{"dialects":[{"dialect":"ANSI_SQL","expression":n}]}}
    prov=dict(prov,firestore_path=e,**({"datatype":dt} if dt else {}))
    if desc: f["description"]=desc
    if time is not None: f["dimension"]={"is_time":time}
    if syn: f["ai_context"]={"synonyms":syn}
    if prov: f["custom_extensions"]=X(**prov)
    return f
def M(n,sql,desc,dt="Decimal",syn=None,**prov):
    m={"name":n,"expression":{"dialects":[{"dialect":"ANSI_SQL","expression":sql}]},"description":desc}
    prov=dict(prov,datatype=dt)
    if syn: m["ai_context"]={"synonyms":syn}
    if prov: m["custom_extensions"]=X(**prov)
    return m
def fact(id,stmt,kind,source,learned_at,conf=0.9,status="accepted",**k):
    d=dict(id=id,statement=stmt,kind=kind,source=source,learned_at=learned_at,confidence=conf,status=status); d.update(k); return d

# ---------- durable facts (from shared memory, Powered Land Sites / Self Storage Sites / Coding Agent) ----------
SH=[
 fact("biz.names","Terrafice = powered-land (data center) business; Everstow = self-storage business; labels used app-wide, internal keys land/storage unchanged.","definition","memory:profile+shared_profile (Coding Agent)","2026-11-01",1.0),
 fact("app.name","App is SunflowerOS at edifice.vc/sunflower (formerly /sites); Firebase project dms-edvc; GitHub Pages.","definition","Coding Agent session t159u/t162u","2026-11-01",1.0),
 fact("pref.why_on_stage","Ask Sahil why on every deal-stage move (via the business's bot, using related email threads); reasons update scoring.","preference","memory:profile","2026-10-26",1.0),
 fact("pref.parity","UI features added to Terrafice should also be applied to Everstow.","preference","memory:profile","2026-10-29",0.9),
 fact("pref.map_filters","Map filters shown on-map (AI search, stage, score, acreage, type, power/gas distance, city limits, traffic), folding on phones.","preference","memory:profile","2026-10-30",0.9),
 fact("pref.compounding","SunflowerOS should improve as more information is fed; every input indexed; corrections/decisions tune extraction, weights and Site Planning defaults; improvement tracked.","preference","Sahil steering + memory:profile","2026-11-01",1.0),
 fact("pref.osi","Architecture standard: Open Semantic Interchange (now Apache Ossie).","decision","Sahil t177u","2026-11-01",1.0),
 fact("rule.prod_approval","Production data, scoring, access changes only on Sahil's own words; relayed agent approvals do not count.","business_rule","Coding Agent security constraints","2026-11-01",1.0),
 fact("rule.no_dup_merge","Don't merge or delete duplicate deals without Sahil's OK.","business_rule","Coding Agent security constraints","2026-10-31",1.0),
 fact("rule.admin_only","Parcel, owner and zoning data stay admin-only.","business_rule","Coding Agent security constraints","2026-10-30",1.0),
 fact("pipeline.pursue_stages","Pursue stages: Reviewing, Contacted, In Diligence, LOI Submitted, Under Contract, Closed. Pass: Passed, On Hold.","definition","pipeline/learnings.py PURSUE/PASS","2026-11-01",1.0),
]
TF=[
 fact("tf.focus","Kansas land parcels for data centers, focus on power and gas line access; price per acre considered.","preference","memory:profile","2026-10-25",1.0),
 fact("tf.parcel_power_cutoff","Parcel DB limited to parcels within ~2 mi of a transmission line or substation; distance recorded so cutoff can tighten.","business_rule","memory:profile","2026-10-30",1.0),
 fact("tf.small_low_filter","Hide Terrafice deals with score <=50 AND <100 acres by default, toggle to show.","business_rule","Sahil t146u/t147u; commit 9f0d00d","2026-11-01",1.0),
 fact("tf.tracker_both_ways","Nearby announced/confirmed DC projects count as zoning precedent (+) and power competition on same line/substation (-); flag purchase/rezoning blockers.","business_rule","Sahil t172u; market_score.json","2026-11-01",1.0),
 fact("tf.market_adj","Market & power competition adj: overall = base + round(10*(market-50)/50), max ±10.","metric_definition","pipeline/market_score.json","2026-11-01",1.0),
 fact("tf.tracker_weekly","More Than Just Parks tracker scraped weekly (Mon 6 AM ET) as a Terrafice layer.","decision","Sahil t171u","2026-11-01",1.0),
 fact("tf.outreach_custom","Broker outreach emails custom per listing; ask only what the listing omits.","preference","memory:profile","2026-10-26",1.0),
 fact("tf.siteplan_goal","Site Planning goal seek: max IT MW powered by grid + on-site gas.","decision","Sahil t155u","2026-11-01",1.0),
 fact("tf.siteplan_flowback","Best plan (max MW, power mix, limiting factor, cost/MW) flows back to deal and map, usable in scoring/filters.","decision","Sahil t156u","2026-11-01",1.0),
 fact("tf.siteplan_defaults","Site Planning V1 defaults: 250x1,000 ft halls, 200 W/sf, PUE 1.3, 10 MW gas engines N+1 (Sahil-unconfirmed).","default","commit 30e2e76","2026-11-01",0.6,status="proposed"),
 fact("tf.siteplan_scope","Site Planning lists only deals at Contacted or later.","business_rule","Sahil t176u","2026-11-01",0.9),
 fact("tf.siteplan_shipped","Sahil approved Site Planning ('looks great - ship').","decision","Sahil t163u","2026-11-01",1.0),
 fact("tf.no_traffic","Traffic counts removed from Terrafice map.","decision","Sahil t174u","2026-11-01",1.0),
 fact("tf.mica_mw_per_bldg","Project Mica 2022 plan: 10 two-storey ~359,000 sf buildings at 48 MW each (only MW/bldg figure in docs).","observation","dc-references project-mica","2026-11-01",0.8),
 fact("tf.sedgwick_moratorium","Sedgwick County data center moratorium until 2026-12-25.","observation","Coding Agent research t165","2026-11-01",0.8),
 fact("tf.power_capacity_estimate","Substation/line remaining capacity is not published; competition adjustment is an ESTIMATE.","caveat","dc-tracker-impact.md","2026-11-01",1.0),
]
ES=[
 fact("es.focus","Self-storage in the six most populous Kansas cities: 5-10 ac parcels to develop and existing facilities to acquire.","preference","memory:profile","2026-10-25",1.0),
 fact("es.formats","Formats: drive-up, indoor, multi-story indoor, boat storage, contractor garages.","preference","memory:profile","2026-10-25",1.0),
 fact("es.factors","Evaluates demand drivers, zoning, traffic visibility, nearby competition.","preference","memory:profile","2026-10-25",1.0),
 fact("es.weights","Everstow score weights: demand 30, competition 25, zoning 20, visibility 15, price 10.","metric_definition","pipeline/everstow_score.json","2026-11-01",1.0),
 fact("es.map_layers","Everstow-only overlays: competitors sized by NRSF, permits distinct colour, 5-mi pop & households, traffic (thicker line = more AADT), visibility.","decision","Sahil t167u-t170u,t174u","2026-11-01",1.0),
 fact("es.colors","Everstow colours must be clearly distinct.","preference","Sahil t175u","2026-11-01",1.0),
 fact("es.rent_band","Storage rents of $1-3/SF carry land well; e.g. ~$24K/ac land pencils; risk is zoning/visibility.","observation","Self Storage Sites t83-85","2026-11-01",0.6),
 fact("es.osm_gap","Competitor data from OpenStreetMap: no Missouri, brands mostly missing, 19 facilities without size.","caveat","Coding Agent t173 Everstow ship","2026-11-01",1.0),
 fact("es.us54_class","Some US highways (Kellogg/US-54) scored as city streets; visibility understated.","caveat","Coding Agent","2026-11-01",1.0),
]
PRIV=json.load(open(PRIVF)) if os.path.exists(PRIVF) else []   # confidential; gitignored, never committed

# ---------- datasets ----------
def site_ds(view, extra):
    base=[F("site_id","__name__","String","Firestore document id"),
          F("name","j.name","String",syn=["deal","site","property","listing"]),
          F("view","view","String","land|storage internal key; label Terrafice|Everstow"),
          F("lat","j.lat","Float"),F("lon","j.lon","Float"),
          F("city","j.city","String"),F("county","j.county","String"),
          F("acres","j.acres","Decimal",syn=["acreage","size"]),
          F("stage","stage","String","Latest pipeline stage",syn=["status"]),
          F("score","j.score","Integer","Overall 0-100 score",syn=["rating"]),
          F("updated","updated","DateTimeTz")]
    return {"name":f"{view}_sites","source":"firestore:dms-edvc/sites (view=="+view+")","primary_key":["site_id"],
            "fields":base+extra}
ev={"name":"stage_events","source":"firestore:dms-edvc/sites/{id}/events","primary_key":["event_id"],
    "description":"Every stage move with Sahil's reasons — primary outcome/training signal.",
    "fields":[F("event_id","event_id","String"),F("site_id","site_id","String"),F("to_stage","to_stage","String"),
              F("from_stage","from_stage","String"),F("reasons","reasons","String"),F("ts","timestamp","DateTimeTz")],
    "metrics":[M("pursue_count","COUNT(CASE WHEN to_stage IN ('Reviewing','Contacted','In Diligence','LOI Submitted','Under Contract','Closed') THEN event_id END)","Decisions to pursue","Integer")]}
juris={"name":"jurisdictions","source":"repo:dc-references/standards/standards.json","primary_key":["jurisdiction"],
       "fields":[F("jurisdiction","jurisdiction","String",syn=["city","county","municipality"])]}
std={"name":"local_standards","source":"repo:dc-references/standards/standards.json#standards","primary_key":["standard_id"],
     "description":"Cited development standards (code requirement vs observed in project vs draft).",
     "fields":[F("standard_id","index","Integer"),F("jurisdiction","jurisdiction","String"),F("category","category","String"),
               F("value","value","String"),F("source_doc","source","String"),F("page","page","String"),F("label","label","String")]}
s=json.load(open(ST))["standards"]
STD_FACTS=[dict(id=f"std.{i}",statement=f"{x['jurisdiction']} {x['category']}: {x['value']}",kind="local_standard",binds_to="terrafice.local_standards",
       entity=x['jurisdiction'].split(" (")[0],jurisdiction=x['jurisdiction'].split(" (")[0],
       source=f"{x['source']} {x['page']}",label=x['label'],learned_at="2026-11-01",confidence=0.9 if x['label']=="code requirement" else 0.7,status="accepted") for i,x in enumerate(s)]

land=site_ds("land",[F("price_per_acre","j.price.per_acre","Decimal",syn=["$/acre"]),
  F("line_kv_best","j.power.lines_by_class[].class","Integer","Highest nearby line voltage (kV)"),
  F("line_mi","j.power.lines_by_class[].mi","Decimal","Distance to 69+ kV line",syn=["distance to power"]),
  F("substation_mi","j.power.substation.mi","Decimal"),
  F("gas_mi","j.gasline.mi","Decimal",syn=["distance to gas"]),
  F("floodplain","j.floodplain","Boolean"),F("community_score","j.community.score","Integer"),
  F("market_score","j.market.score","Integer","Market & power competition 0-100, 50 neutral"),
  F("plan_it_mw","plan.it_mw","Decimal","Site Planning best IT MW (local-only V1)",syn=["MW","capacity"]),
  F("plan_limiter","plan.limited_by","String"),F("plan_cost_per_mw","plan.cost_per_mw","Decimal")])
land["metrics"]=[M("pipeline_it_mw","SUM(plan_it_mw)","Total planned IT MW across Terrafice deals"),
                 M("avg_price_per_acre","AVG(price_per_acre)","Average asking $/acre")]
proj={"name":"dc_projects","source":"repo:pipeline/dc_tracker_enrich.json (morethanjustparks tracker, weekly)","primary_key":["project_id"],
      "fields":[F("project_id","id","String"),F("name","name","String",syn=["data center project","competitor project"]),F("developer","developer","String"),
                F("status","status","String","proposed|approved|under_construction|operational|withdrawn|cancelled|defeated"),
                F("mw","mw","Decimal"),F("acres","acres","Decimal"),F("county","county","String"),F("substation","substation","String")]}
subs={"name":"substations","source":"HIFLD/OSM via map_layers.py","primary_key":["substation_id"],"fields":[F("substation_id","id","String"),F("name","name","String"),F("kv","max_kv","Integer")]}
lines={"name":"transmission_lines","source":"HIFLD via map_layers.py","primary_key":["line_id"],"fields":[F("line_id","id","String"),F("kv","voltage","Integer"),F("owner","owner","String",syn=["utility"])]}
plans={"name":"site_plans","source":"browser localStorage (V1); proposed firestore:sitePlans","primary_key":["plan_id"],
       "fields":[F("plan_id","id","String"),F("site_id","site_id","String"),F("it_mw","it_mw","Decimal"),F("total_mw","total_mw","Decimal"),
                 F("limited_by","limited_by","String"),F("capex","cost","Decimal"),F("w_per_sf","w_per_sf","Decimal"),F("pue","pue","Decimal"),F("created","ts","DateTimeTz")]}
saved={"name":"site_plans_saved","source":"firestore:dms-edvc/site_plans_saved","primary_key":["scheme_id"],
       "description":"Saved Site Planning test-fit schemes (land data-center and storage), one compact doc per explicit Save in the plan view. Admins write; members read schemes for non-restricted deals. p/g/k are JSON or maps, exempt from indexing.",
       "ai_context":{"instructions":"KPIs live in k (it, fac, halls, nrsf, units, cov, capex, earth_cy, earth_usd, zone_ok, circ_ok). bind = binding capacity constraint, zbind = binding zoning rule. Estimates only, not engineering.","synonyms":["saved schemes","test fits","site plan options"]},
       "fields":[F("scheme_id","__name__","String"),F("site_id","site_id","String"),F("product","co","String",syn=["co","land or storage"]),F("name","name","String"),
                 F("kpis","k","String",desc="map of KPI values"),F("binding_constraint","bind","String"),F("binding_zoning_rule","zbind","String"),
                 F("jurisdiction","jur","String"),F("restricted","restricted","Boolean"),F("saved_by","by","String"),F("saved_at","ts","DateTimeTz",time=True)]}
zoning={"name":"zoning_profiles","source":"firestore:dms-edvc/zoning","primary_key":["site_id"],
       "description":"Per-site zoning from Zoneomics (licensed; ADMIN-ONLY; never redistributed or bulk-exported). j = JSON of district, permitted use and dimensional limits with a source label per value; fixture=true marks MOCK data.",
       "ai_context":{"instructions":"Do not quote or export outside admin views. Ignore records where fixture is true.","synonyms":["zoneomics","zoning"]},
       "fields":[F("site_id","__name__","String"),F("zoning_json","j","String"),F("fixture","fixture","Boolean"),F("source","src","String")]}
mc=json.load(open(f"{R}/market_score.json"))
tf={"version":V,"name":"terrafice","description":"Terrafice (powered land / data center sites) semantic model for SunflowerOS.",
    "ai_context":{"instructions":"Terrafice = Sahil's powered-land business (internal view key 'land'). Scores 0-100. Power-capacity figures are estimates unless sourced.","synonyms":["powered land","data center land","land"]},
    "datasets":[land,ev,proj,subs,lines,plans,saved,zoning,juris,std],
    "relationships":[
      {"name":"events_to_site","from":"stage_events","to":"land_sites","from_columns":["site_id"],"to_columns":["site_id"]},
      {"name":"plans_to_site","from":"site_plans","to":"land_sites","from_columns":["site_id"],"to_columns":["site_id"]},
      {"name":"saved_schemes_to_site","from":"site_plans_saved","to":"land_sites","from_columns":["site_id"],"to_columns":["site_id"]},
      {"name":"zoning_to_site","from":"zoning_profiles","to":"land_sites","from_columns":["site_id"],"to_columns":["site_id"]},
      {"name":"standards_to_jurisdiction","from":"local_standards","to":"jurisdictions","from_columns":["jurisdiction"],"to_columns":["jurisdiction"]}],
    "metrics":[M("mw_per_acre","SUM(site_plans.it_mw) / SUM(land_sites.acres)","Planned IT MW per acre",syn=["density"])],
    "custom_extensions":X(market_score_config=mc,provenance="pipeline/market_score.json; Sahil messages; memory")}
es_cfg=json.load(open(f"{R}/everstow_score.json"))
st=site_ds("storage",[F("price","j.price","Decimal"),F("price_per_acre","j.price_per_acre","Decimal"),
  F("pop3","j.demand.pop3","Integer",syn=["3 mile population"]),F("pop5","j.demand.pop5","Integer",syn=["5 mile population"]),
  F("hh5","j.demand.hh5","Integer",syn=["households"]),F("income3","j.demand.income","Decimal"),F("renter_pct","j.demand.renter_pct","Decimal"),
  F("growth_pct","j.demand.growth_pct","Decimal"),F("aadt","j.traffic.aadt","Integer",syn=["traffic count"]),
  F("visibility","j.traffic.visibility","Integer","0-100 visibility score"),F("zoning_status","j.zoning.status","String","P/S/I/C/X/?"),
  F("nrsf_supply_5mi","j.competition.nrsf5","Decimal")])
st["metrics"]=[M("sf_per_capita_5mi","SUM(nrsf_supply_5mi) / SUM(pop5)","Storage SF per capita within 5 mi (supply saturation)",syn=["NRSF per capita"])]
comp={"name":"competitors","source":"OSM via everstow_layers.py","primary_key":["facility_id"],
      "fields":[F("facility_id","id","String"),F("name","name","String",syn=["competitor","storage facility"]),F("brand","brand","String"),F("nrsf_est","nrsf","Decimal","Estimated rentable SF")]}
perm={"name":"storage_permits","source":"repo:pipeline/everstow_permits.json","primary_key":["permit_id"],
      "fields":[F("permit_id","id","String"),F("city","city","String"),F("status","status","String"),F("date","date","Date")]}
sp={"name":"site_plans","source":"firestore:dms-edvc/site_plans","primary_key":["plan_id"],
    "description":"Reference site plans (entitled precedents and internal concepts) for Everstow Site Planning; one doc per plan, embeddings float16 base64 (not indexed). Built by pipeline/site_plans.py; records private.",
    "ai_context":{"instructions":"Use as precedent specs for new storage/flex sites. Null = not stated in source; cites holds per-field source page.","synonyms":["reference plans","precedents","site plan library"]},
    "fields":[F("plan_id","__name__","String"),F("project","project","String"),F("location","location","String"),F("type","type","String"),
      F("acreage","acreage","Decimal"),F("building_sf","building_sf","Integer",syn=["GSF","building area"]),F("buildings","buildings","Integer"),
      F("unit_count_est","unit_count_est","Integer"),F("bay_unit_sizes","bay_unit_sizes","String",syn=["unit mix","bay size"]),F("doors","doors","String"),
      F("height_ft","height_ft","Decimal"),F("zoning","zoning","String"),F("parking","parking","String"),F("setbacks","setbacks","String"),
      F("coverage","coverage","String"),F("source_url","source_url","String"),F("drive_links","drive_links","String"),F("summary","summary","String"),
      F("cites","cites","String","per-field source file/page"),F("emb_model","emb_model","String"),F("emb_dim","emb_dim","Integer"),F("hash","hash","String")]}
es={"version":V,"name":"everstow","description":"Everstow (self-storage) semantic model for SunflowerOS.",
    "ai_context":{"instructions":"Everstow = Sahil's self-storage business (internal view key 'storage'). Demand layers are Everstow-only.","synonyms":["self storage","storage"]},
    "datasets":[st,ev|{"name":"stage_events"},comp,perm,sp],
    "relationships":[{"name":"events_to_site","from":"stage_events","to":"storage_sites","from_columns":["site_id"],"to_columns":["site_id"]}],
    "custom_extensions":X(score_config=es_cfg)}
sitecond={"name":"site_conditions","source":"firestore:dms-edvc/meta/sitedata (one chunked blob, gated; built by pipeline/site_data.py)","primary_key":["site_id"],
  "description":"Phase-1 civil screening per deal (score > 65, not Passed): FEMA NFHL flood share, USGS 3DEP slope/elevation stats, buildable acres (site minus 100-yr floodplain and >15% slope), county parcel availability. One blob, not per-site docs, to keep reads/writes minimal. Screening only, not a survey.",
  "fields":[F("site_id","sites.{id}","String"),F("site_ac","site_ac","Decimal","Area analysed: site polygon, else circle of listed acres around the pin"),
    F("sfha_pct","flood.sfha_pct","Decimal","% of site in FEMA 100-yr floodplain (A/AE/AH/AO incl. floodway)",syn=["floodplain","flood zone"],source="FEMA NFHL layer 28"),
    F("floodway_pct","flood.floodway_pct","Decimal","% of site in regulatory floodway",source="FEMA NFHL layer 28"),
    F("x500_pct","flood.x500_pct","Decimal","% of site in 0.2%-annual-chance (500-yr) zone",source="FEMA NFHL layer 28"),
    F("slope_mean_pct","slope.slope_mean_pct","Decimal","Mean slope %",source="USGS 3DEP"),F("pct_gt5","slope.pct_gt5","Decimal","% of site steeper than 5%",source="USGS 3DEP"),
    F("pct_gt15","slope.pct_gt15","Decimal","% of site steeper than 15%",syn=["steep slopes"],source="USGS 3DEP"),
    F("elev_min_ft","slope.elev_min_ft","Decimal"),F("elev_max_ft","slope.elev_max_ft","Decimal"),F("elev_mean_ft","slope.elev_mean_ft","Decimal"),
    F("cutfill_cy","slope.cutfill_cy","Integer","Rough earthwork to level the site to its best-fit plane (cut = fill), cubic yards"),
    F("buildable_ac","buildable_ac","Decimal","Site minus 100-yr floodplain and >15%-slope blocks",syn=["net developable","buildable area"]),
    F("parcels_found","parcels.found","Boolean","County parcel polygons available from a public service (geometry kept admin-only)"),
    F("pin_county","pin_county","String","County containing the pin (Census TIGERweb); flagged when it differs from the listing"),
    F("generated","meta.generated","String",time=True)],
  "metrics":[M("buildable_share","SUM(buildable_ac) / SUM(site_ac)","Share of analysed site area that is buildable after flood and steep-slope exclusions",syn=["net to gross"])]}
sh={"version":V,"name":"edifice_shared","description":"Shared SunflowerOS vocabulary: businesses, pipeline stages, governance rules, memory ledger.",
    "ai_context":{"instructions":"Shared terms for both businesses. Learned facts are rows of the memory_facts dataset (Firestore osi_facts, grouped per bound object/entity). Each fact binds_to a model, dataset, field or metric; osi_memory.py export surfaces accepted facts in the ai_context of the bound object."},
    "datasets":[ev,juris,sitecond,
      {"name":"memory_facts","source":"firestore:dms-edvc/osi_facts/{model}__{entity}.facts.{fact_id}","primary_key":["fact_id"],
       "description":"Learned, approved knowledge. One row per fact; Firestore groups rows per (model, entity) to keep document counts low.",
       "fields":[F("fact_id","id","String"),F("model","model","String","terrafice|everstow|shared"),
                 F("binds_to","binds_to","String","OSI object the fact is about: model | model.dataset | model.dataset.field | model.metric"),
                 F("entity","entity","String","Grouping entity (jurisdiction, site_id, factor or the bound object)"),
                 F("metric_key","key","String","Subject key metric|scope|business used for dedupe/conflict"),
                 F("jurisdiction","jurisdiction","String"),F("statement","statement","String"),F("kind","kind","String"),
                 F("value_num","value_num","Decimal"),F("unit","unit","String"),
                 F("status","status","String","accepted|superseded"),F("confidence","confidence","Float"),
                 F("source","source","String","Provenance: document/page, message id or commit"),F("extractor","extractor","String","agent|rules|seed"),
                 F("learned_at","learned_at","Date"),F("decided_by","accepted_by","String","sahil@edifice.vc|roger@edifice.vc"),
                 F("supersedes","supersedes","String"),F("superseded_by","superseded_by","String")],
       "metrics":[M("accepted_fact_count","COUNT(CASE WHEN status='accepted' THEN fact_id END)","Live accepted facts","Integer")]},
      {"name":"memory_proposals","source":"firestore:dms-edvc/osi_proposals/pending.items.{proposal_id}","primary_key":["proposal_id"],
       "description":"Pending candidate facts awaiting Sahil/Roger (scoring-affecting or conflicting ones need Sahil).",
       "fields":[F("proposal_id","id","String"),F("action","action","String","new|duplicate|conflict|supersede"),
                 F("match","match","String"),F("needs_sahil","needs_sahil","Boolean"),F("status","status","String","pending"),
                 F("proposed_at","proposed_at","DateTimeTz"),F("proposed_by","proposed_by","String")],
       "metrics":[M("open_conflicts","COUNT(CASE WHEN action IN ('conflict','supersede') THEN proposal_id END)","Pending conflicts","Integer")]},
      {"name":"memory_ledger","source":"firestore:dms-edvc/osi_ledger/{YYYY-MM}.entries[]","primary_key":["entry_id"],
       "description":"Append-only verdicts and deal outcomes, one Firestore doc per month.",
       "fields":[F("entry_id","eid","String"),F("type","type","String","verdict|outcome"),F("fact_id","id","String"),F("verdict","verdict","String"),
                 F("by","by","String"),F("rule","rule","String"),F("at","at","DateTimeTz")],
       "metrics":[M("acceptance_rate","SUM(CASE WHEN verdict='accept' THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(CASE WHEN type='verdict' THEN entry_id END),0)","Share of decided proposals accepted","Float")]}],
    "relationships":[
      {"name":"proposal_to_fact","from":"memory_proposals","to":"memory_facts","from_columns":["proposal_id"],"to_columns":["fact_id"]},
      {"name":"ledger_to_fact","from":"memory_ledger","to":"memory_facts","from_columns":["fact_id"],"to_columns":["fact_id"]}],
    "custom_extensions":X(stages={"pursue":["Reviewing","Contacted","In Diligence","LOI Submitted","Under Contract","Closed"],"pass":["Passed","On Hold"]})}
pv={"version":V,"name":"edifice_private","description":"Confidential facts (contacts, deal ids, licence terms, CIM). Never commit.",
    "datasets":[{"name":"contacts","source":"firestore:dms-edvc/sites.contact (admin-only)","primary_key":["contact_id"],"fields":[F("contact_id","id","String")]}],
    "custom_extensions":X(memory="facts live in osi/private/facts.jsonl (never synced, never committed)")}
import re as _re
def emit_facts(path,model,rows):
    """Seed facts upsert by id; learned (non-seed) rows and supersede marks already in the store are preserved."""
    os.makedirs(os.path.dirname(path),exist_ok=True)
    cur={}
    if os.path.exists(path):
        for l in open(path):
            if l.strip(): r=json.loads(l); cur[r["id"]]=r
    for f in rows:
        r=dict(model=model,binds_to=f.get("binds_to",model),entity=f.get("entity",f.get("binds_to",model)),extractor="seed",accepted_by="sahil@edifice.vc")|f
        old=cur.get(r["id"])
        if old and old.get("extractor")!="seed": continue
        if old and old.get("status")=="superseded": r|={k:old[k] for k in ("status","superseded_by") if k in old}
        cur[r["id"]]=r
    with open(path,"w") as fh:
        for r in cur.values(): fh.write(json.dumps(r,sort_keys=True)+"\n")
emit_facts("facts/terrafice.jsonl","terrafice",TF+STD_FACTS); emit_facts("facts/everstow.jsonl","everstow",ES)
emit_facts("facts/shared.jsonl","shared",SH); emit_facts("private/facts.jsonl","private",PRIV)
def to011(m):
    """0.1.1 has no dataset-scoped metrics: lift them to the model, qualifying field names as dataset.field."""
    for ds in m["datasets"]:
        for mt in ds.pop("metrics",[]) or []:
            names=sorted((f["name"] for f in ds["fields"]),key=len,reverse=True)
            for d in mt["expression"]["dialects"]:
                d["expression"]=_re.sub(r"(?<![\w.'])("+"|".join(map(_re.escape,names))+r")(?![\w'])",ds["name"]+r".\1",d["expression"])
            mt["name"]=ds["name"]+"_"+mt["name"] if any(x["name"]==mt["name"] for x in m.get("metrics",[])) else mt["name"]
            m.setdefault("metrics",[]).append(mt)
    return {"version":m.pop("version"),"semantic_model":[m]}
for p,m in [("terrafice.yaml",tf),("everstow.yaml",es),("shared.yaml",sh),("private/private.yaml",pv)]:
    os.makedirs(os.path.dirname(p) or ".",exist_ok=True); yaml.safe_dump(to011(m),open(p,"w"),sort_keys=False,allow_unicode=True,width=140)
print("facts: terrafice",len(TF),"+standards",len(s),"| everstow",len(ES),"| shared",len(SH),"| private",len(PRIV))
