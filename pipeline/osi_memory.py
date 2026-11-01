#!/usr/bin/env python3
"""SunflowerOS memory, stored natively in OSI (Apache Ossie) 0.1.1.

OSI layout: osi/*.yaml are the semantic models (datasets, fields, metrics, relationships). Learned knowledge is
DATA, not model metadata: each fact is a row of the OSI dataset edifice_shared.memory_facts (osi/facts/<model>.jsonl,
Firestore osi_facts) and names the OSI object it is about in `binds_to` (model | model.dataset[.field] | model.metric).
`export` folds accepted facts into the bound objects' ai_context (the spec's slot for AI knowledge) and validates the
result against the official JSON Schema in osi/schema/.

Loop: ingest|submit -> propose -> diff -> accept/reject -> metrics -> sync/export.
  osi_memory.py submit FILE.json [--by grok-bot]   agent-supplied facts (no LLM key): [{statement, kind, source, ...}]
  osi_memory.py ingest [PATH...] [--kind ...]       regex rules over files (fallback, no network)
  osi_memory.py propose | diff | metrics
  osi_memory.py accept ID --by EMAIL / reject ID --by EMAIL [--why ...]
  osi_memory.py outcome SITE_ID STAGE --predicted SCORE
  osi_memory.py weekly [--weights FILE] [--push]
  osi_memory.py validate                      validate osi/*.yaml against osi/schema
  osi_memory.py export [--spec 0.1.1|0.2] [--from local|firestore] [--out DIR]
  osi_memory.py sync [--dry-run]              cost-aware Firestore push: 1 read + only changed docs

Governance: only Sahil or Roger may accept or reject; anything that changes scoring, Site Planning defaults or a
conflicting fact needs Sahil. Weight proposals are proposals only. The private model/facts are never synced or exported.
"""
import argparse, datetime as dt, difflib, hashlib, json, os, re, sys
import yaml
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("OSI_DIR", os.path.join(HERE, "..", "osi"))
MODELS = {"terrafice": "terrafice.yaml", "everstow": "everstow.yaml", "shared": "shared.yaml", "private": "private/private.yaml"}
P = lambda *a: os.path.join(ROOT, *a)
INDEX, CAND, PROP, LEDGER, WEEKLY, SYNCC = (P("state/index.jsonl"), P("state/candidates.jsonl"), P("state/proposals.jsonl"),
                                     P("state/ledger.jsonl"), P("state/weight_proposals.json"), P("state/sync_cache.json"))
FACTS = {"terrafice": "facts/terrafice.jsonl", "everstow": "facts/everstow.jsonl", "shared": "facts/shared.jsonl", "private": "private/facts.jsonl"}
PUBLIC = ("terrafice", "everstow", "shared")
NS = "edifice_sunflower"
SAHIL, ROGER = "sahil@edifice.vc", "roger@edifice.vc"
ACCEPTORS = {"sahil": SAHIL, SAHIL: SAHIL, "roger": ROGER, ROGER: ROGER}
GATED = {"metric_definition", "business_rule", "default", "decision", "weight"}
PRIVATE_RX = re.compile(r"@|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b|\bCIM\b|\bowner|parcel id|account|zoneomics", re.I)

# Subject keys: a fact is about (metric, scope). Same key + different numbers = conflict, whatever the wording.
METRICS = [  # (metric, all-of regexes, affects scoring/Site Planning)
 ("small_site_filter", [r"score", r"acre", r"filter|hide|show|less than|<|under"], True),
 ("market_adjustment", [r"market", r"adj|competition"], True),
 ("score_weight", [r"weight"], True),
 ("power_cutoff", [r"transmission|substation|power line", r"\bmi\b|mile", r"within|cutoff|limit"], True),
 ("siteplan_defaults", [r"W/sf|PUE|hall|gas engine"], True),
 ("setback", [r"setback"], False), ("height_limit", [r"height"], False), ("noise_limit", [r"dBA|noise"], False),
 ("screening", [r"screen|buffer|landscap"], False), ("moratorium", [r"moratorium"], False),
 ("mw_per_building", [r"MW", r"build|bldg"], False), ("rent_band", [r"rent", r"/ ?SF|psf"], False),
 ("storage_supply", [r"NRSF|per capita|sf/cap"], True), ("visibility", [r"AADT|traffic|visib"], True),
]
FACTORS = r"demand|competition|visibility|zoning|price|power|transmission|substation|gas|fiber|water|scale|community"
_STD = os.path.join(ROOT, "sources", "standards.json")
JURIS = sorted({x["jurisdiction"].split(" (")[0] for x in json.load(open(_STD))["standards"]}, key=len, reverse=True) if os.path.exists(_STD) else []
JURIS += ["Wichita", "Topeka", "Overland Park", "Olathe", "Lawrence", "Manhattan", "Garden City", "Dodge City", "Salina", "Hutchinson"]

def subject_key(text, model=""):
    t = text
    metric = next((m for m, rxs, _ in METRICS if all(re.search(r, t, re.I) for r in rxs)), None)
    if not metric: return None
    scope = next((j for j in JURIS if re.search(r"\b" + re.escape(j) + r"\b", t, re.I)), None)
    cm = re.search(r"\b([A-Z][a-z]+) County\b", t); scope = scope or (cm and cm.group(1) + " County")
    if metric == "score_weight":
        f = re.search(FACTORS, t, re.I); scope = f and f.group(0).lower()
    biz = "terrafice" if re.search(r"terrafice|data cent|MW|power", t, re.I) else "everstow" if re.search(r"everstow|storage", t, re.I) else None
    return "|".join([metric, (scope or "*").lower(), biz or "*"])
def keys_match(a, b):
    """Same metric and scope; business must agree unless one side does not name it ('*')."""
    if not a or not b: return False
    (m1, s1, b1), (m2, s2, b2) = a.split("|"), b.split("|")
    return m1 == m2 and s1 == s2 and (b1 == b2 or "*" in (b1, b2))
def scoring_key(k): return bool(k) and any(m == k.split("|")[0] and s for m, _, s in METRICS)
def nums(s): return {float(x.replace(",", "")) for x in re.findall(r"(?<![\w.])\d[\d,]*(?:\.\d+)?", s)}

RULES = [
 ("pref_want", r"\b(?:i want|i'd like|lets|let's|we should|always|never)\b[^.\n]{8,200}", "preference", None),
 ("decision_ship", r"\b(?:approved?|ship(?:ped)?|go ahead|decided)\b[^.\n]{0,160}", "decision", None),
 ("metric_mw", r"\b\d[\d,.]*\s?(?:MW|GW|kV)\b[^.\n]{0,120}", "observation", "terrafice"),
 ("std_setback", r"\b(?:setback|buffer|height|dBA|footcandle|screen(?:ing)?|moratorium)\b[^.\n]{0,160}", "local_standard", "terrafice"),
 ("storage_term", r"\b(?:NRSF|rentable|occupancy|street rate|drive-up|climate)\b[^.\n]{0,160}", "observation", "everstow"),
 ("weight_change", r"[^.\n]{0,80}\b(?:weight|score|filter)\b[^.\n]{0,40}\b(?:above|below|less than|more than|\d+)\b[^.\n]{0,120}", "business_rule", None),
]
LAND_RX = re.compile(r"data cent|MW|substation|kV|powered|terrafice|hyperscal", re.I)
STOR_RX = re.compile(r"storage|everstow|NRSF|units|renter|household", re.I)

def now(): return dt.datetime.now().astimezone().isoformat(timespec="seconds")
def rj(p): return [json.loads(l) for l in open(p)] if os.path.exists(p) else []
def wj(p, rows): os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "w").write("".join(json.dumps(r) + "\n" for r in rows))
def aj(p, row): os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "a").write(json.dumps(row) + "\n")
def norm(s): return re.sub(r"[^a-z0-9$.% ]+", " ", s.lower()).split()

def load_doc(k): return yaml.safe_load(open(P(MODELS[k]))) if os.path.exists(P(MODELS[k])) else None
def sm(doc): return doc["semantic_model"][0]
def model_facts(include_private=True):
    out = []
    for k in FACTS:
        if k == "private" and not include_private: continue
        out += [dict(f, model=k, key=f.get("key") or subject_key(f["statement"], k)) for f in rj(P(FACTS[k]))]
    return out
def save_facts(k, rows): wj(P(FACTS[k]), [{x: v for x, v in sorted(r.items()) if v is not None} for r in rows])

def osi_objects(k):
    """Names a fact may bind to in model k: model, model.dataset, model.dataset.field, model.metric."""
    doc = load_doc(k)
    if not doc: return {k}
    m = sm(doc); out = {k} | {f"{k}.{x['name']}" for x in m.get("metrics") or []}
    for ds in m["datasets"]:
        out.add(f"{k}.{ds['name']}"); out |= {f"{k}.{ds['name']}.{f['name']}" for f in ds.get("fields") or []}
    return out

def rule_precision():
    st = {}
    for r in rj(LEDGER):
        if r.get("type") != "verdict" or not r.get("rule"): continue
        a, n = st.get(r["rule"], (0, 0)); st[r["rule"]] = (a + (r["verdict"] == "accept"), n + 1)
    return {k: ((a + 1) / (n + 2), n) for k, (a, n) in st.items()}

def text_of(path):
    if path.endswith((".yaml", ".yml", ".json", ".md", ".txt", ".csv", ".eml", ".html")): return open(path, errors="ignore").read()
    if path.endswith(".pdf"):
        import subprocess
        return subprocess.run(["pdftotext", "-layout", path, "-"], capture_output=True, text=True).stdout
    return ""

def extract(t, prec):
    out = []
    for rid, rx, kind, hint in RULES:
        p, n = prec.get(rid, (0.5, 0))
        if n >= 8 and p < 0.25: continue          # rule muted by its own track record
        out += [(rid, " ".join(m.group(0).split())[:240], kind, hint) for m in re.finditer(rx, t, re.I)]
    return out

def cmd_ingest(a):
    files = []
    for p in a.paths or [P("inbox")]:
        files += [os.path.join(r, f) for r, _, fs in os.walk(p) for f in fs] if os.path.isdir(p) else [p]
    prec, seen = rule_precision(), {c["id"] for c in rj(CAND)}
    idx_seen = {r["sha"] for r in rj(INDEX)}; new = 0
    for f in files:
        t = text_of(f)
        if not t: continue
        sha = hashlib.sha1(t.encode()).hexdigest()
        if sha in idx_seen: continue
        aj(INDEX, {"path": os.path.basename(f), "sha": sha, "chars": len(t), "indexed_at": now(), "source_kind": a.kind,
                   "extractor": "rules"})
        for rid, s, kind, hint in extract(t, prec):
            cid = hashlib.sha1((rid + s).encode()).hexdigest()[:10]
            if cid in seen: continue
            model = "private" if PRIVATE_RX.search(s) else hint or ("terrafice" if LAND_RX.search(s) else "everstow" if STOR_RX.search(s) else "shared")
            key = subject_key(s, model)
            if kind == "observation" and scoring_key(key) and re.search(r"\b(filter|hide|weight|should|want)\b", s, re.I): kind = "business_rule"
            aj(CAND, {"id": cid, "statement": s, "kind": kind, "rule": rid, "model": model, "key": key,
                      "confidence": round(prec.get(rid, (0.5, 0))[0], 2), "source": f"{a.kind}:{os.path.basename(f)}",
                      "learned_at": dt.date.today().isoformat(), "status": "candidate", "extractor": "rules", "proposed_by": "rules"})
            seen.add(cid); new += 1
    print(f"indexed {len(files)} file(s) with rule extraction; {new} new candidate fact(s)")

KINDS = {"preference","decision","business_rule","metric_definition","default","observation","local_standard","caveat","definition"}
def cmd_submit(a):
    """Agent path (no LLM key): the agent reads mail/files itself and hands over JSON facts. Same gates as ingest."""
    rows = json.load(open(a.file)); rows = rows.get("facts", rows) if isinstance(rows, dict) else rows
    seen = {c["id"] for c in rj(CAND)}; new = bad = 0
    for f in rows:
        s = " ".join(str(f.get("statement", "")).split())[:400]
        if not s or not f.get("source") or f.get("kind") not in KINDS: bad += 1; continue
        model = f.get("model") if f.get("model") in MODELS else None
        if PRIVATE_RX.search(s) or f.get("private"): model = "private"
        model = model or ("terrafice" if LAND_RX.search(s) else "everstow" if STOR_RX.search(s) else "shared")
        bt = f.get("binds_to") or model
        if model != "private" and bt not in osi_objects(model): bt = model   # unknown object: bind to the model; new metrics need a model change
        cid = f.get("id") or hashlib.sha1(("agent" + s).encode()).hexdigest()[:10]
        if cid in seen: continue
        key = f.get("key") or subject_key(s, model)
        kind = f["kind"]
        if kind == "observation" and scoring_key(key) and re.search(r"\b(filter|hide|weight|should|want)\b", s, re.I): kind = "business_rule"
        aj(CAND, {"id": cid, "statement": s, "kind": kind, "rule": "agent", "model": model, "key": key, "binds_to": bt,
                  "entity": f.get("entity") or f.get("jurisdiction") or bt, "jurisdiction": f.get("jurisdiction"),
                  "value_num": f.get("value_num"), "unit": f.get("unit"),
                  "confidence": float(f.get("confidence", 0.7)), "source": str(f["source"])[:300],
                  "learned_at": f.get("learned_at") or dt.date.today().isoformat(), "status": "candidate",
                  "extractor": "agent", "proposed_by": a.by})
        seen.add(cid); new += 1
    print(f"{new} agent fact(s) queued as candidates; {bad} rejected (need statement, source and a known kind)")

def reconcile(c, facts):
    """Keyed match first (same metric+scope), then wording. Returns (action, match, similarity)."""
    if c.get("key"):
        same = [f for f in facts if keys_match(f.get("key"), c["key"]) and f.get("status") != "superseded"]
        for f in same:
            if nums(c["statement"]) and nums(f["statement"]) and nums(c["statement"]) != nums(f["statement"]):
                return ("conflict" if f.get("confidence", 0) > c["confidence"] else "supersede"), f["id"], 1.0
        if same: return "duplicate", same[0]["id"], 1.0
    best, score = None, 0.0
    for f in facts:
        r = difflib.SequenceMatcher(None, norm(c["statement"]), norm(f["statement"])).ratio()
        if r > score: best, score = f, r
    if score >= 0.85: return "duplicate", best["id"], round(score, 2)
    if score >= 0.55 and nums(c["statement"]) != nums(best["statement"]):
        return ("conflict" if best.get("confidence", 0) >= c["confidence"] else "supersede"), best["id"], round(score, 2)
    return "new", best and best["id"], round(score, 2)

def cmd_propose(a):
    facts, props = model_facts(), {p["id"]: p for p in rj(PROP)}; out = 0
    for c in rj(CAND):
        if c["id"] in props or c.get("status") != "candidate": continue
        action, match, sim = reconcile(c, facts)
        needs_sahil = c["kind"] in GATED or scoring_key(c.get("key")) or action in ("supersede", "conflict")
        props[c["id"]] = dict(c, action=action, match=match, similarity=sim, gated=needs_sahil, needs_sahil=needs_sahil,
                              status="pending", proposed_at=now()); out += 1
    wj(PROP, list(props.values())); print(f"{out} proposal(s) written")

def cmd_diff(a):
    for p in rj(PROP):
        if p["status"] != "pending": continue
        print(f"{p['id']} {p['action']:<9} {p['model']:<9} {p['kind']:<16} key={p.get('key')} conf={p['confidence']}{' [NEEDS SAHIL]' if p['needs_sahil'] else ''}\n   + {p['statement']}")
        if p.get("match"): print(f"   ~ vs {p['match']} (sim {p['similarity']})")

def who(by):
    w = ACCEPTORS.get((by or "").strip().lower())
    if not w: sys.exit("only Sahil (sahil@edifice.vc) or Roger (roger@edifice.vc) may accept or reject; pass --by")
    return w

def _verdict(a, v):
    by = who(a.by); props = rj(PROP); p = next((x for x in props if x["id"] == a.id), None)
    if not p: sys.exit("no such proposal")
    if p["status"] != "pending": sys.exit(f"already {p['status']}")
    if p.get("needs_sahil", p.get("gated")) and by != SAHIL:
        sys.exit("this proposal changes scoring, Site Planning or an existing fact: Sahil must decide (--by sahil@edifice.vc)")
    p["status"] = v + "ed"; p["decided_by"] = by; p["decided_at"] = now()
    if v == "accept" and p["action"] != "duplicate":
        if p["action"] in ("supersede", "conflict") and p.get("match"):   # the new fact lives beside the one it replaces
            p["model"] = next((f["model"] for f in model_facts() if f["id"] == p["match"]), p["model"])
            for k in FACTS:
                rows = rj(P(FACTS[k])); hit = False
                for f in rows:
                    if f["id"] == p["match"]: f["status"] = "superseded"; f["superseded_by"] = p["id"]; hit = True
                if hit: save_facts(k, rows)
        rows = rj(P(FACTS[p["model"]]))
        rows.append({k: p.get(k) for k in ("id", "statement", "kind", "source", "learned_at", "confidence", "key", "binds_to", "entity",
                                           "jurisdiction", "value_num", "unit", "extractor", "proposed_by")}
                    | {"model": p["model"], "binds_to": p.get("binds_to") or p["model"], "entity": p.get("entity") or p.get("binds_to") or p["model"],
                       "status": "accepted", "accepted_by": by, "decided_at": p["decided_at"], "rule": p["rule"],
                       **({"supersedes": p["match"]} if p["action"] in ("supersede", "conflict") else {})})
        save_facts(p["model"], rows)
    wj(PROP, props)
    aj(LEDGER, {"type": "verdict", "id": p["id"], "rule": p["rule"], "kind": p["kind"], "key": p.get("key"), "verdict": v, "by": by, "why": a.why, "at": now()})
    print(f"{p['id']} {v}ed by {by}")

def cmd_outcome(a):
    aj(LEDGER, {"type": "outcome", "site_id": a.site_id, "stage": a.stage, "predicted": a.predicted, "at": now()}); print("outcome logged")

PURSUE = {"Reviewing", "Contacted", "In Diligence", "LOI Submitted", "Under Contract", "Closed"}
def outcome_accuracy():
    o = [r for r in rj(LEDGER) if r["type"] == "outcome" and r.get("predicted") is not None]
    return (sum((r["predicted"] > 50) == (r["stage"] in PURSUE) for r in o), len(o))

def cmd_weekly(a):
    """Outcome-based weight proposals: base-weight changes where the learned deltas (learnings/weights) are
    large and backed by enough decisions. Proposals only; Sahil decides; no config is edited."""
    if a.weights: W = json.load(open(a.weights))
    else:
        sys.path.insert(0, HERE); import edks
        if not edks.configured(): sys.exit("no Firestore access for learnings/weights; pass --weights FILE")
        s = edks.db().collection("learnings").document("weights").get(); W = (s.to_dict() or {}) if s.exists else {}
    wk = dt.date.today().isocalendar(); week = f"{wk[0]}-W{wk[1]:02d}"; props = []
    for track, cfg in (("power", "pipeline/market_score.json + score_parts"), ("storage", "pipeline/everstow_score.json")):
        t = W.get(track) or {}; n = t.get("n", 0)
        for k, d in sorted((t.get("deltas") or {}).items(), key=lambda kv: -abs(kv[1])):
            if n >= a.min_decisions and abs(d) >= a.min_delta:
                drv = next((x["text"] for x in t.get("drivers", []) if x.get("factor") == k), "")
                props.append({"id": f"w-{week}-{track}-{k}", "type": "weight", "week": week, "track": track, "factor": k,
                              "proposed_change_pct": round(d * 100), "decisions": n, "why": drv, "config": cfg,
                              "needs_sahil": True, "status": "pending", "proposed_at": now()})
    hit, tot = outcome_accuracy()
    out = {"week": week, "generated_at": now(), "proposals": props, "outcome_accuracy": {"hits": hit, "n": tot},
           "note": "Proposals only. Nothing changes until Sahil approves; approved changes ship as a reviewed commit."}
    os.makedirs(os.path.dirname(WEEKLY), exist_ok=True); json.dump(out, open(WEEKLY, "w"), indent=1)
    print(f"{len(props)} weight proposal(s) for {week} -> {WEEKLY}")
    if a.push:   # one document per week (was N+1 writes)
        sys.path.insert(0, HERE); import edks
        edks.db().collection("osi_proposals").document(f"weekly-{week}").set(
            {k: v for k, v in out.items() if k != "proposals"} | {"type": "weekly_summary", "expire_at": dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=WEEKLY_TTL_DAYS), "count": len(props), "items": {p["id"]: p for p in props}})
        print(f"pushed weekly-{week} ({len(props)} proposal(s)) in 1 write")

def coverage():
    res = {}
    for k in MODELS:
        doc = load_doc(k)
        if not doc: continue
        m = sm(doc); fl = [f for ds in m["datasets"] for f in ds.get("fields", [])]
        res[k] = (len([f for f in rj(P(FACTS[k])) if f.get("status") != "superseded"]), sum(bool(f.get("description") or f.get("ai_context")) for f in fl), len(fl))
    return res

def cmd_metrics(a):
    L, props, idx = rj(LEDGER), rj(PROP), rj(INDEX)
    v = [r for r in L if r["type"] == "verdict"]; acc = sum(r["verdict"] == "accept" for r in v)
    print(f"inputs indexed: {len(idx)} | proposals: {len(props)} | verdicts: {len(v)} | acceptance rate: " + (f"{acc/len(v):.0%}" if v else "n/a"))
    for rid, (p, n) in sorted(rule_precision().items()): print(f"  rule {rid:<14} precision {p:.2f} over {n}")
    hit, tot = outcome_accuracy()
    if tot: print(f"  outcome accuracy (score>50 predicts pursue): {hit}/{tot} = {hit/tot:.0%}")
    print(f"  open conflicts: {sum(p['status']=='pending' and p['action'] in ('conflict','supersede') for p in props)}")
    for k, (nf, doc, tot) in coverage().items(): print(f"  {k:<9} facts {nf:>3} | field coverage (described) {doc}/{tot}")

SCHEMAS = {"0.1.1": "schema/osi-0.1.1.schema.json", "0.2": "schema/ossie-0.2.0.dev0.schema.json"}
def validate_doc(doc, spec="0.1.1"):
    import jsonschema
    v = jsonschema.Draft202012Validator(json.load(open(P(SCHEMAS[spec]))))
    return [f"{'/'.join(map(str, e.path))}: {e.message[:160]}" for e in v.iter_errors(doc)]

def cmd_validate(a):
    bad = 0
    for k in MODELS:
        doc = load_doc(k)
        if not doc: continue
        errs = validate_doc(doc); bad += len(errs)
        print(f"{MODELS[k]:<22} {'OK' if not errs else str(len(errs)) + ' error(s)'}"); [print("   ", e) for e in errs[:10]]
    if bad: sys.exit(1)

def _facts_firestore():
    sys.path.insert(0, HERE); import edks
    out = []   # one read per (model, entity) group document, not per fact
    for d in edks.db().collection("osi_facts").stream(): out += [dict(f, model=d.to_dict()["model"]) for f in d.to_dict().get("facts", [])]
    return out

def build_export(facts, spec="0.1.1"):
    """Valid OSI documents with accepted facts folded into the ai_context of the object each fact binds_to."""
    import copy
    docs = {}
    for k in PUBLIC:
        doc = copy.deepcopy(load_doc(k)); m = sm(doc)
        objs = {k: m} | {f"{k}.{x['name']}": x for x in m.get("metrics") or []}
        for ds in m["datasets"]:
            objs[f"{k}.{ds['name']}"] = ds; objs |= {f"{k}.{ds['name']}.{f['name']}": f for f in ds.get("fields") or []}
        bound = {}
        for f in facts:
            if f.get("model") != k or f.get("status") != "accepted": continue
            bound.setdefault(f.get("binds_to") if f.get("binds_to") in objs else k, []).append(f)
        for name, fs in bound.items():
            o = objs[name]; ac = o.get("ai_context") or {}
            ac = {"instructions": ac} if isinstance(ac, str) else dict(ac)
            lines = [f"- {f['statement']} [{f['id']}; {f.get('kind')}; source: {f.get('source')}; approved by {f.get('accepted_by', 'seed')}]"
                     for f in sorted(fs, key=lambda x: x["id"])]
            ac["instructions"] = ((ac.get("instructions") or "") + "\nLearned facts (SunflowerOS memory, approved):\n" + "\n".join(lines)).strip()
            o["ai_context"] = ac
            o.setdefault("custom_extensions", []).append({"vendor_name": "COMMON", "data": json.dumps(
                {"namespace": NS, "memory_facts": [f["id"] for f in fs], "dataset": "edifice_shared.memory_facts"}, sort_keys=True)})
        docs[k] = to_v02(doc) if spec == "0.2" else doc
    return docs

def to_v02(doc):
    """0.1.1 -> 0.2.0.dev0: flat root, native datatype, free-form vendor token."""
    m = sm(doc); m = {"version": "0.2.0.dev0", **m}
    def fix(o):
        keep = []
        for e in o.get("custom_extensions") or []:
            d = json.loads(e["data"])
            if d.get("datatype"): o["datatype"] = d.pop("datatype")
            d.pop("namespace", None)
            if d: keep.append({"vendor_name": "EDIFICE_SUNFLOWER", "data": json.dumps(d, sort_keys=True)})
        if keep: o["custom_extensions"] = keep
        else: o.pop("custom_extensions", None)
    fix(m)
    for ds in m["datasets"]:
        fix(ds); [fix(f) for f in ds.get("fields") or []]
    [fix(x) for x in m.get("metrics") or []]; [fix(x) for x in m.get("relationships") or []]
    return m

def cmd_export(a):
    facts = _facts_firestore() if a.src == "firestore" else model_facts(include_private=False)
    out = a.out or P("dist", a.spec); os.makedirs(out, exist_ok=True); bad = 0
    for k, doc in build_export(facts, a.spec).items():
        errs = validate_doc(doc, a.spec); bad += len(errs)
        yaml.safe_dump(doc, open(os.path.join(out, f"{k}.yaml"), "w"), sort_keys=False, allow_unicode=True, width=140)
        print(f"{k}.yaml -> {out} (OSI {a.spec}): {'valid' if not errs else errs[:3]}")
    if bad: sys.exit(1)

def slug(s): return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")[:80] or "_"
LAYOUT = {"layout_version": 2, "osi_spec": "0.1.1"}   # bump layout_version on any doc-shape change
WEEKLY_TTL_DAYS = 90   # osi_proposals/weekly-* carry expire_at; Firestore TTL deletes them
MAX_DOC = 900_000   # bytes; Firestore hard limit is 1 MiB per document
def sync_docs():
    """Firestore layout (all OSI-mapped, document counts kept low):
       osi_facts/{model}__{entity}  {model, entity, binds_to:[...], facts:[memory_facts rows]}   one doc per group
       osi_proposals/pending        {items:[memory_proposals rows]}                           one doc
       osi_ledger/{YYYY-MM}         {entries:[memory_ledger rows]}                            one doc per month
       osi_meta/summary             metrics; osi_meta/sync holds content hashes (the dedupe index)"""
    docs = {}
    for f in model_facts(include_private=False):
        g = docs.setdefault(f"osi_facts/{f['model']}__{slug(f.get('entity') or f['model'])}",
                            {"model": f["model"], "entity": f.get("entity") or f["model"], "binds_to": [], "facts": []})
        g["facts"].append(f); g["binds_to"] = sorted(set(g["binds_to"]) | {f.get("binds_to") or f["model"]})
    for g in docs.values(): g["facts"].sort(key=lambda x: x["id"])
    for k in [k for k in docs if len(json.dumps(docs[k], default=str)) > MAX_DOC]:
        g = docs.pop(k); part, n = [], 1
        for f in g["facts"]:
            if part and len(json.dumps(part + [f], default=str)) > MAX_DOC - 20000:
                docs[f"{k}__p{n}"] = dict(g, facts=part, part=n); part, n = [], n + 1
            part.append(f)
        docs[f"{k}__p{n}"] = dict(g, facts=part, part=n)
    if os.path.exists(PROP):
        docs["osi_proposals/pending"] = {"items": sorted([p for p in rj(PROP) if p["status"] == "pending" and p["model"] != "private"], key=lambda x: x["id"])}
    if os.path.exists(LEDGER):
        for r in rj(LEDGER):
            r = dict(r, eid=hashlib.sha1(json.dumps(r, sort_keys=True).encode()).hexdigest()[:16])
            docs.setdefault(f"osi_ledger/{r.get('at', '')[:7] or 'undated'}", {"entries": []})["entries"].append(r)
    hit, tot = outcome_accuracy()
    docs["osi_meta/summary"] = {"type": "metrics", "coverage": {k: list(v) for k, v in coverage().items() if k != "private"},
                                "outcome_hits": hit, "outcome_n": tot, "groups": sum(k.startswith("osi_facts/") for k in docs)}
    for v in docs.values(): v.update(LAYOUT)   # forward-compat marker on every synced doc (never on weekly-*)
    return docs
def h(d): return hashlib.sha1(json.dumps(d, sort_keys=True, default=str).encode()).hexdigest()[:16]

def cmd_sync(a):
    """1 read (osi_meta/sync hash index) + one batched write per changed document. No collection scans."""
    docs = sync_docs(); new = {k: h(v) for k, v in docs.items()}
    if a.dry_run:
        old = json.load(open(SYNCC)) if os.path.exists(SYNCC) else {}
    else:
        sys.path.insert(0, HERE); import edks
        c = edks.db(); s = c.collection("osi_meta").document("sync").get()
        old = (s.to_dict() or {}).get("hashes", {}) if s.exists else {}
    changed = [k for k in docs if old.get(k) != new[k]]
    gone = [k for k in old if k.startswith("osi_facts/") and k not in docs]   # regrouped fact docs only; ledger is never deleted
    if a.dry_run:
        print(f"[osi] dry run: {len(docs)} doc(s), {len(changed)} changed, {len(gone)} stale -> would cost 1 read + "
              f"{len(changed) + len(gone) + bool(changed or gone)} write(s)")
        os.makedirs(os.path.dirname(SYNCC), exist_ok=True); json.dump(new, open(SYNCC, "w")); return
    os.makedirs(os.path.dirname(SYNCC), exist_ok=True); json.dump(new, open(SYNCC, "w"))   # keep dry-run cache in step with Firestore
    if not changed and not gone: print("[osi] no changes: 1 read, 0 writes"); return
    b = c.batch(); n = 0
    for k in changed:
        col, did = k.split("/", 1); b.set(c.collection(col).document(did), docs[k] | {"synced_at": now()}); n += 1
        if n % 400 == 0: b.commit(); b = c.batch()
    for k in gone: col, did = k.split("/", 1); b.delete(c.collection(col).document(did)); n += 1
    b.set(c.collection("osi_meta").document("sync"), {"hashes": new, "at": now()}); n += 1
    b.commit(); print(f"[osi] synced: 1 read, {n} write(s) ({len(changed)} changed, {len(gone)} removed); private model excluded")

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter); sp = ap.add_subparsers(dest="c", required=True)
    x = sp.add_parser("ingest"); x.add_argument("paths", nargs="*"); x.add_argument("--kind", default="file"); x.set_defaults(f=cmd_ingest)
    for n, f in (("propose", cmd_propose), ("diff", cmd_diff), ("metrics", cmd_metrics), ("validate", cmd_validate)): sp.add_parser(n).set_defaults(f=f)
    x = sp.add_parser("sync"); x.add_argument("--dry-run", action="store_true"); x.set_defaults(f=cmd_sync)
    x = sp.add_parser("submit"); x.add_argument("file"); x.add_argument("--by", default="grok-bot"); x.set_defaults(f=cmd_submit)
    x = sp.add_parser("export"); x.add_argument("--spec", choices=["0.1.1", "0.2"], default="0.1.1"); x.add_argument("--from", dest="src", choices=["local", "firestore"], default="local")
    x.add_argument("--out"); x.set_defaults(f=cmd_export)
    for n in ("accept", "reject"):
        x = sp.add_parser(n); x.add_argument("id"); x.add_argument("--by"); x.add_argument("--why"); x.set_defaults(f=lambda a, n=n: _verdict(a, n))
    x = sp.add_parser("outcome"); x.add_argument("site_id"); x.add_argument("stage"); x.add_argument("--predicted", type=float); x.set_defaults(f=cmd_outcome)
    x = sp.add_parser("weekly"); x.add_argument("--weights"); x.add_argument("--push", action="store_true")
    x.add_argument("--min-decisions", type=int, default=5); x.add_argument("--min-delta", type=float, default=0.05); x.set_defaults(f=cmd_weekly)
    a = ap.parse_args(argv); a.f(a)

if __name__ == "__main__":
    main()
