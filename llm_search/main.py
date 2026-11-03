"""Map AI search: turns a plain-English query into the structured filter JSON the in-browser rule parser understands.
Input is only the query text (plus the fixed stage list); no deal, parcel, owner, zoning or constraint data is sent or read.
Auth: Firebase ID token (verified Google account) + membership checked by reading users/{email} *as that user*
(Firestore rules decide; this service has no Firestore access). Model: Gemini on Vertex AI via the runtime service
account (no API key, no key file). In-memory rate limit; max one instance."""
import json, os, re, time, threading
import requests
from flask import Flask, request, jsonify
import google.auth
from google.auth.transport.requests import Request as GReq
from google.oauth2 import id_token

PROJECT = os.environ.get("FB_PROJECT", "dms-edvc")
MODEL = os.environ.get("MODEL", "gemini-3.5-flash-lite")
LOC = os.environ.get("VERTEX_LOCATION", "global")
ORIGINS = set(os.environ.get("ALLOWED_ORIGINS", "https://edifice.vc,https://www.edifice.vc").split(","))
PER_MIN, PER_DAY, GLOBAL_DAY = 12, 300, 3000
STAGES = ["New", "Under Consideration", "Reviewing", "Contacted", "In Diligence", "LOI Submitted",
          "Under Contract", "Closed", "Passed", "On Hold"]
SUB_ST = ["planned", "ntc_issued", "under_construction"]

app = Flask(__name__)
_lock = threading.Lock()
_hits, _members, _day = {}, {}, {"d": "", "n": 0}
_greq = GReq()
_creds = None

def _num():
    return {"type": "NUMBER", "nullable": True}

SCHEMA = {"type": "OBJECT", "properties": {
    "business": {"type": "STRING", "enum": ["land", "storage", "both"], "description": "land = data-center / powered land (Terrafice); storage = self-storage (Everstow); both if unclear"},
    "place": {"type": "STRING", "nullable": True, "description": "town, county ('X County') or address the user wants results near; null if none"},
    "radius_mi": _num(),
    "stages": {"type": "ARRAY", "items": {"type": "STRING", "enum": STAGES}},
    "min_score": _num(), "min_acres": _num(), "max_acres": _num(),
    "min_kv": _num(), "line_within_mi": _num(), "gas_within_mi": _num(), "gas": {"type": "BOOLEAN", "nullable": True},
    "mw_min": _num(), "mw_max": _num(),
    "flood": {"type": "STRING", "enum": ["exclude", "only", "any"]},
    "city_limits": {"type": "STRING", "enum": ["in", "out", "any"]},
    "min_aadt": _num(), "max_price": _num(), "max_price_per_acre": _num(),
    "sort": {"type": "STRING", "enum": ["score", "price", "none"]},
    "substations": {"type": "BOOLEAN", "description": "true only if the user is asking for substations themselves"},
    "substation_status": {"type": "ARRAY", "items": {"type": "STRING", "enum": SUB_ST}},
    "state": {"type": "STRING", "nullable": True, "description": "two-letter US state if named"},
    "name_terms": {"type": "ARRAY", "items": {"type": "STRING"}, "description": "words that look like a deal/site name, not covered by other fields"},
}, "required": ["business", "stages", "flood", "city_limits", "sort", "substations", "substation_status", "name_terms"]}

PROMPT = ("You convert a search typed into a Kansas real-estate deal map into filters. Deals are either data-center/powered "
          "land sites (Terrafice) or self-storage sites (Everstow). Pipeline stages: " + ", ".join(STAGES) + ". "
          "'LOI' means LOI Submitted; 'under contract' means Under Contract. Only set a field the user actually asked for; "
          "otherwise null / 'any' / empty. Distances in miles, power in kV and MW, price in US dollars. "
          "If a place is given without a radius, leave radius_mi null. Never invent places. Query: ")

def _cors(resp):
    o = request.headers.get("Origin", "")
    if o in ORIGINS:
        resp.headers["Access-Control-Allow-Origin"] = o
        resp.headers["Vary"] = "Origin"
        resp.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        resp.headers["Access-Control-Max-Age"] = "3600"
    return resp

def _err(msg, code):
    return _cors(jsonify({"error": msg})), code

def _member(email, tok):
    now = time.time()
    c = _members.get(email)
    if c and c[1] > now:
        return c[0]
    u = "https://firestore.googleapis.com/v1/projects/%s/databases/(default)/documents/users/%s?mask.fieldPaths=role" % (PROJECT, requests.utils.quote(email, safe=""))
    try:
        ok = requests.get(u, headers={"Authorization": "Bearer " + tok}, timeout=4).status_code == 200
    except requests.RequestException:
        return False
    _members[email] = (ok, now + (600 if ok else 60))
    return ok

def _limit(email):
    now = time.time(); d = time.strftime("%Y-%m-%d")
    with _lock:
        if _day["d"] != d:
            _day.update(d=d, n=0); _hits.clear()
        h = [t for t in _hits.get(email, []) if t > now - 86400]
        if len([t for t in h if t > now - 60]) >= PER_MIN or len(h) >= PER_DAY or _day["n"] >= GLOBAL_DAY:
            return False
        h.append(now); _hits[email] = h; _day["n"] += 1
    return True

def _token():
    global _creds
    if _creds is None:
        _creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    if not _creds.valid:
        _creds.refresh(_greq)
    return _creds.token

def clean(j):
    """Keep only known fields with sane types/ranges."""
    out = {}
    def num(k, lo, hi):
        v = j.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool) and lo <= v <= hi:
            out[k] = round(float(v), 2)
    out["business"] = j.get("business") if j.get("business") in ("land", "storage", "both") else "both"
    p = j.get("place")
    if isinstance(p, str) and 2 <= len(p.strip()) <= 80:
        out["place"] = re.sub(r"[^\w .,'#-]", "", p.strip())
    for k, lo, hi in [("radius_mi", 1, 300), ("min_score", 0, 100), ("min_acres", 0, 100000), ("max_acres", 0, 100000),
                      ("min_kv", 34, 765), ("line_within_mi", 0, 50), ("gas_within_mi", 0, 50), ("mw_min", 0, 10000),
                      ("mw_max", 0, 10000), ("min_aadt", 0, 500000), ("max_price", 1000, 1e10), ("max_price_per_acre", 1, 1e8)]:
        num(k, lo, hi)
    out["stages"] = [s for s in (j.get("stages") or []) if s in STAGES][:10]
    for k, ok in [("flood", ("exclude", "only")), ("city_limits", ("in", "out")), ("sort", ("score", "price"))]:
        if j.get(k) in ok:
            out[k] = j[k]
    if j.get("gas") is True:
        out["gas"] = True
    if j.get("substations") is True:
        out["substations"] = True
        out["substation_status"] = [s for s in (j.get("substation_status") or []) if s in SUB_ST]
    st = j.get("state")
    if isinstance(st, str) and re.fullmatch(r"[A-Za-z]{2}", st.strip()):
        out["state"] = st.strip().upper()
    out["name_terms"] = [re.sub(r"[^\w .'-]", "", t)[:40] for t in (j.get("name_terms") or []) if isinstance(t, str) and t.strip()][:4]
    return out

def ask_model(q):
    url = "https://aiplatform.googleapis.com/v1/projects/%s/locations/%s/publishers/google/models/%s:generateContent" % (PROJECT, LOC, MODEL)
    if LOC != "global":
        url = url.replace("https://aiplatform", "https://%s-aiplatform" % LOC)
    body = {"contents": [{"role": "user", "parts": [{"text": PROMPT + json.dumps(q)}]}],
            "generationConfig": {"temperature": 0, "maxOutputTokens": 400, "thinkingConfig": {"thinkingLevel": "minimal"}, "responseMimeType": "application/json", "responseSchema": SCHEMA}}
    r = requests.post(url, json=body, headers={"Authorization": "Bearer " + _token()}, timeout=6)
    r.raise_for_status()
    d = r.json()
    txt = d["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(txt), d.get("usageMetadata", {})

def _gate():
    """Origin + Firebase token + membership + rate limit. Returns (email, None) or (None, error response)."""
    if request.headers.get("Origin", "") not in ORIGINS:
        return None, _err("origin", 403)
    auth = request.headers.get("Authorization", "")
    tok = auth[7:] if auth.startswith("Bearer ") else ""
    try:
        info = id_token.verify_firebase_token(tok, _greq, audience=PROJECT) if tok else None
    except Exception:
        info = None
    email = (info or {}).get("email", "").lower()
    if not info or not email or not info.get("email_verified"):
        return None, _err("auth", 401)
    if not _member(email, tok):
        return None, _err("not a member", 403)
    if not _limit(email):
        return None, _err("rate limit", 429)
    return email, None

def _gen(text, schema, max_out=400):
    url = "https://aiplatform.googleapis.com/v1/projects/%s/locations/%s/publishers/google/models/%s:generateContent" % (PROJECT, LOC, MODEL)
    if LOC != "global":
        url = url.replace("https://aiplatform", "https://%s-aiplatform" % LOC)
    body = {"contents": [{"role": "user", "parts": [{"text": text}]}],
            "generationConfig": {"temperature": 0, "maxOutputTokens": max_out, "thinkingConfig": {"thinkingLevel": "minimal"},
                                 "responseMimeType": "application/json", "responseSchema": schema}}
    r = requests.post(url, json=body, headers={"Authorization": "Bearer " + _token()}, timeout=6)
    r.raise_for_status()
    d = r.json()
    return json.loads(d["candidates"][0]["content"]["parts"][0]["text"]), d.get("usageMetadata", {})

def ask_model(q):
    return _gen(PROMPT + json.dumps(q), SCHEMA)

@app.route("/parse", methods=["POST", "OPTIONS"])
def parse():
    if request.method == "OPTIONS":
        return _cors(app.make_response(("", 204)))
    email, bad = _gate()
    if bad:
        return bad
    q = ((request.get_json(silent=True) or {}).get("q") or "").strip()
    if not q or len(q) > 300:
        return _err("bad query", 400)
    t0 = time.time()
    try:
        j, use = ask_model(q)
    except Exception as e:
        print(json.dumps({"event": "model_error", "ep": "parse", "type": type(e).__name__}))
        return _err("model", 502)
    print(json.dumps({"event": "parse", "ms": int((time.time() - t0) * 1000), "in": use.get("promptTokenCount"), "out": use.get("candidatesTokenCount")}))
    return _cors(jsonify({"filters": clean(j), "model": MODEL}))

# ---- Site Plan chat edits ------------------------------------------------------------------------------------
# Request:  {"message": str<=500, "schema": {key: {"type": "number"|"integer"|"string"|"boolean", "min"?, "max"?,
#            "enum"?: [str], "desc"?: str<=120}} (<=40 keys), "params": {key: current value} (keys from schema only)}
# Response: {"changes": {key: new value} (validated against schema), "reply": str<=200, "model": str}
KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,31}$")
PLAN_PROMPT = ("You edit a data-center site plan by changing its numeric/text parameters. Given the parameter schema, the "
               "current values, and the user's request, set in changes every parameter (by its exact SCHEMA key, matched via its "
               "desc) that must change, with its new value; leave all others null. "
               "respecting min/max and enums. Feet for lengths unless stated; acres for areas; MW for power. If the request "
               "cannot be done with these parameters, return no changes and say why in reply. reply: one short sentence.\n")

def plan_schema(sch):
    """Validate the client's plan-edit schema; return (clean schema, Vertex response schema) or raise ValueError."""
    if not isinstance(sch, dict) or not 0 < len(sch) <= 40:
        raise ValueError("schema")
    out, props = {}, {}
    for k, v in sch.items():
        if not isinstance(k, str) or not KEY_RE.match(k) or not isinstance(v, dict):
            raise ValueError("schema key")
        t = v.get("type")
        if t not in ("number", "integer", "string", "boolean"):
            raise ValueError("schema type")
        e = {"type": t}
        for b in ("min", "max"):
            if isinstance(v.get(b), (int, float)) and not isinstance(v.get(b), bool):
                e[b] = float(v[b])
        if t == "string" and isinstance(v.get("enum"), list):
            e["enum"] = [str(x)[:40] for x in v["enum"][:30]]
        if isinstance(v.get("desc"), str):
            e["desc"] = v["desc"][:120]
        out[k] = e
        p = {"type": {"number": "NUMBER", "integer": "INTEGER", "string": "STRING", "boolean": "BOOLEAN"}[t], "nullable": True}
        if "enum" in e:
            p["enum"] = e["enum"]
        if "desc" in e:
            p["description"] = e["desc"]
        props[k] = p
    rs = {"type": "OBJECT", "properties": {"changes": {"type": "OBJECT", "properties": props}, "reply": {"type": "STRING"}},
          "required": ["changes", "reply"]}
    return out, rs

def plan_clean(j, sch, cur):
    ch = {}
    for k, v in ((j or {}).get("changes") or {}).items():
        e = sch.get(k)
        if e is None or v is None:
            continue
        t = e["type"]
        if t in ("number", "integer"):
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                continue
            if ("min" in e and v < e["min"]) or ("max" in e and v > e["max"]):
                continue
            v = int(round(v)) if t == "integer" else round(float(v), 4)
        elif t == "boolean":
            if not isinstance(v, bool):
                continue
        else:
            if not isinstance(v, str) or len(v) > 80 or ("enum" in e and v not in e["enum"]):
                continue
        if cur.get(k) != v:
            ch[k] = v
    r = (j or {}).get("reply")
    return {"changes": ch, "reply": r.strip()[:200] if isinstance(r, str) else ""}

@app.route("/plan_edit", methods=["POST", "OPTIONS"])
def plan_edit():
    if request.method == "OPTIONS":
        return _cors(app.make_response(("", 204)))
    email, bad = _gate()
    if bad:
        return bad
    b = request.get_json(silent=True) or {}
    msg = (b.get("message") or "").strip() if isinstance(b.get("message"), str) else ""
    if not msg or len(msg) > 500:
        return _err("bad message", 400)
    try:
        sch, rs = plan_schema(b.get("schema"))
    except ValueError:
        return _err("bad schema", 400)
    cur = b.get("params") if isinstance(b.get("params"), dict) else {}
    cur = {k: v for k, v in cur.items() if k in sch and (v is None or isinstance(v, (int, float, str, bool))) and len(str(v)) <= 80}
    t0 = time.time()
    try:
        j, use = _gen(PLAN_PROMPT + "SCHEMA: " + json.dumps(sch) + "\nCURRENT: " + json.dumps(cur) + "\nREQUEST: " + json.dumps(msg), rs, 500)
    except Exception as e:
        print(json.dumps({"event": "model_error", "ep": "plan_edit", "type": type(e).__name__}))
        return _err("model", 502)
    print(json.dumps({"event": "plan_edit", "ms": int((time.time() - t0) * 1000), "in": use.get("promptTokenCount"), "out": use.get("candidatesTokenCount")}))
    return _cors(jsonify(dict(plan_clean(j, sch, cur), model=MODEL)))

@app.get("/healthz")
@app.get("/health")
def health():
    return "ok"
