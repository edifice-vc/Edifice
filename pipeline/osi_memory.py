#!/usr/bin/env python3
"""SunflowerOS memory: OSI (Apache Ossie) 0.1.1 models that learn from everything you feed them.

Loop: ingest -> propose -> diff -> accept/reject -> metrics. Every input is indexed; every verdict and deal
outcome goes to an append-only ledger that tunes extraction (per-rule precision) and is measured.

  osi_memory.py ingest [PATH...] [--kind email|chat|doc|note]   index files/dirs (default drop folder osi/inbox/)
  osi_memory.py propose                     reconcile candidates vs model facts by subject key (dedupe/conflict/supersede)
  osi_memory.py diff                        show pending proposals
  osi_memory.py accept ID --by EMAIL / reject ID --by EMAIL [--why ...]
  osi_memory.py outcome SITE_ID STAGE --predicted SCORE
  osi_memory.py weekly [--weights FILE] [--push]   outcome-based weight proposals for the weekly scoring report
  osi_memory.py metrics
  osi_memory.py sync                        push public facts / proposals / ledger to Firestore osi_* (pipeline SA)

Governance: only Sahil or Roger may accept or reject; anything that changes scoring, Site Planning defaults or a
conflicting fact needs Sahil. Weight proposals are proposals only; nothing here edits score configs.
Extraction: model-based when OSI_LLM_API_KEY (or XAI_API_KEY) is set, else regex rules. The private model is never synced.
"""
import argparse, datetime as dt, difflib, hashlib, json, os, re, sys
import yaml
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("OSI_DIR", os.path.join(HERE, "..", "osi"))
MODELS = {"terrafice": "terrafice.yaml", "everstow": "everstow.yaml", "shared": "shared.yaml", "private": "private/private.yaml"}
P = lambda *a: os.path.join(ROOT, *a)
INDEX, CAND, PROP, LEDGER, WEEKLY = (P("state/index.jsonl"), P("state/candidates.jsonl"), P("state/proposals.jsonl"),
                                     P("state/ledger.jsonl"), P("state/weight_proposals.json"))
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
def ext(m):
    for e in m.get("custom_extensions") or []:
        d = json.loads(e["data"])
        if d.get("namespace") == NS: return e, d
    e = {"vendor_name": "COMMON", "data": json.dumps({"namespace": NS})}; m.setdefault("custom_extensions", []).append(e); return e, {"namespace": NS}
def model_facts(include_private=True):
    out = []
    for k in MODELS:
        if k == "private" and not include_private: continue
        doc = load_doc(k)
        if not doc: continue
        m = sm(doc); _, d = ext(m); fs = list(d.get("facts", []))
        for ds in m["datasets"]:                       # dataset-level facts (e.g. cited local standards)
            for e in ds.get("custom_extensions") or []:
                dd = json.loads(e["data"])
                if dd.get("namespace") == NS: fs += dd.get("facts", [])
        out += [dict(f, model=k, key=f.get("key") or subject_key(f["statement"], k)) for f in fs]
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

def llm_key(): return os.environ.get("OSI_LLM_API_KEY") or os.environ.get("XAI_API_KEY")
def llm_extract(text):
    """Model-based extraction (OpenAI-compatible chat endpoint). Returns [{statement, kind, model}] or None."""
    key = llm_key()
    if not key: return None
    import urllib.request
    url = os.environ.get("OSI_LLM_URL", "https://api.x.ai/v1/chat/completions")
    prompt = ("Extract durable business facts for a land-sourcing firm (Terrafice = data-center powered land; Everstow = self storage). "
              "Return JSON {\"facts\":[{\"statement\":str,\"kind\":one of preference|decision|business_rule|metric_definition|default|observation|local_standard|caveat,"
              "\"model\":terrafice|everstow|shared}]}. Only facts stated in the text; no guesses.\n\n" + text[:24000])
    body = {"model": os.environ.get("OSI_LLM_MODEL", "grok-4"), "messages": [{"role": "user", "content": prompt}],
            "response_format": {"type": "json_object"}, "temperature": 0}
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        out = json.load(urllib.request.urlopen(req, timeout=120))["choices"][0]["message"]["content"]
        return json.loads(out).get("facts") or []
    except Exception as ex:
        print(f"[osi] model extraction failed ({type(ex).__name__}); using rules"); return None

def extract(t, prec):
    got = llm_extract(t)
    if got is not None:
        return [("llm", " ".join(str(f.get("statement", "")).split())[:400], f.get("kind", "observation"), f.get("model")) for f in got if f.get("statement")]
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
                   "extractor": "llm" if llm_key() else "rules"})
        for rid, s, kind, hint in extract(t, prec):
            cid = hashlib.sha1((rid + s).encode()).hexdigest()[:10]
            if cid in seen: continue
            model = "private" if PRIVATE_RX.search(s) else hint or ("terrafice" if LAND_RX.search(s) else "everstow" if STOR_RX.search(s) else "shared")
            key = subject_key(s, model)
            if kind == "observation" and scoring_key(key) and re.search(r"\b(filter|hide|weight|should|want)\b", s, re.I): kind = "business_rule"
            aj(CAND, {"id": cid, "statement": s, "kind": kind, "rule": rid, "model": model, "key": key,
                      "confidence": round(prec.get(rid, (0.5, 0))[0], 2), "source": f"{a.kind}:{os.path.basename(f)}",
                      "learned_at": dt.date.today().isoformat(), "status": "candidate"})
            seen.add(cid); new += 1
    print(f"indexed {len(files)} file(s) with {'model' if llm_key() else 'rule'} extraction; {new} new candidate fact(s)")

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
        doc = load_doc(p["model"]); m = sm(doc); e, d = ext(m); fs = d.setdefault("facts", [])
        if p["action"] in ("supersede", "conflict") and p.get("match"):
            for host in [e] + [x for ds in m["datasets"] for x in ds.get("custom_extensions") or []]:
                hd = d if host is e else json.loads(host["data"])
                for f in hd.get("facts", []):
                    if f["id"] == p["match"]: f["status"] = "superseded"; f["superseded_by"] = p["id"]
                if host is not e: host["data"] = json.dumps(hd, sort_keys=True)
        fs.append({k: p[k] for k in ("id", "statement", "kind", "source", "learned_at", "confidence", "key")}
                  | {"status": "accepted", "accepted_by": by, "rule": p["rule"], **({"supersedes": p["match"]} if p["action"] in ("supersede", "conflict") else {})})
        e["data"] = json.dumps(d, sort_keys=True)
        yaml.safe_dump(doc, open(P(MODELS[p["model"]]), "w"), sort_keys=False, allow_unicode=True, width=140)
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
    if a.push:
        sys.path.insert(0, HERE); import edks; c = edks.db()
        for p in props: c.collection("osi_proposals").document(p["id"]).set(p, merge=True)
        c.collection("osi_proposals").document(f"weekly-{week}").set({k: v for k, v in out.items() if k != "proposals"} | {"type": "weekly_summary", "count": len(props)})
        print(f"pushed {len(props)} to osi_proposals")

def coverage():
    res = {}
    for k in MODELS:
        doc = load_doc(k)
        if not doc: continue
        m = sm(doc); fl = [f for ds in m["datasets"] for f in ds.get("fields", [])]
        _, d = ext(m); res[k] = (len([f for f in d.get("facts", []) if f.get("status") != "superseded"]), sum(bool(f.get("description") or f.get("ai_context")) for f in fl), len(fl))
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

def cmd_sync(a):
    """Firestore osi_facts / osi_proposals / osi_ledger via the pipeline service account (Admin SDK).
    Public models only; the private model is never synced. Collections are admin-read-only (firestore.rules)."""
    sys.path.insert(0, HERE); import edks
    c = edks.db(); b = c.batch(); n = 0
    def put(col, did, d):
        nonlocal b, n
        b.set(c.collection(col).document(re.sub(r"[/]", "_", did)), d); n += 1
        if n % 400 == 0: b.commit(); b = c.batch()
    for f in model_facts(include_private=False): put("osi_facts", f"{f['model']}__{f['id']}", f)
    for p in rj(PROP):
        if p["model"] != "private": put("osi_proposals", p["id"], p)
    for r in rj(LEDGER): put("osi_ledger", hashlib.sha1(json.dumps(r, sort_keys=True).encode()).hexdigest()[:16], r)
    hit, tot = outcome_accuracy()
    put("osi_ledger", "_metrics", {"type": "metrics", "at": now(), "coverage": {k: list(v) for k, v in coverage().items() if k != "private"},
                                   "outcome_hits": hit, "outcome_n": tot})
    b.commit(); print(f"[osi] synced {n} doc(s) to osi_facts/osi_proposals/osi_ledger (private model excluded)")

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter); sp = ap.add_subparsers(dest="c", required=True)
    x = sp.add_parser("ingest"); x.add_argument("paths", nargs="*"); x.add_argument("--kind", default="file"); x.set_defaults(f=cmd_ingest)
    for n, f in (("propose", cmd_propose), ("diff", cmd_diff), ("metrics", cmd_metrics), ("sync", cmd_sync)): sp.add_parser(n).set_defaults(f=f)
    for n in ("accept", "reject"):
        x = sp.add_parser(n); x.add_argument("id"); x.add_argument("--by"); x.add_argument("--why"); x.set_defaults(f=lambda a, n=n: _verdict(a, n))
    x = sp.add_parser("outcome"); x.add_argument("site_id"); x.add_argument("stage"); x.add_argument("--predicted", type=float); x.set_defaults(f=cmd_outcome)
    x = sp.add_parser("weekly"); x.add_argument("--weights"); x.add_argument("--push", action="store_true")
    x.add_argument("--min-decisions", type=int, default=5); x.add_argument("--min-delta", type=float, default=0.05); x.set_defaults(f=cmd_weekly)
    a = ap.parse_args(argv); a.f(a)

if __name__ == "__main__":
    main()
