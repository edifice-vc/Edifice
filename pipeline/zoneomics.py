"""Zoneomics v2 adapter for Site Planning (admin-only licensed data).

LICENSING / HANDLING (Sahil): Zoneomics data is ADMIN-ONLY and must never be redistributed.
  * Raw responses: pipeline/private/zoneomics_v2/ (gitignored). Never committed.
  * Normalised records: pipeline/private/zoning.json (gitignored) and Firestore zoning/{siteId}
    (rules: admin read, client write false). Raw JSON for each endpoint is zoning/{siteId}/raw/{endpoint}
    (same admin-only rule; the nested match is in this repo and is NOT deployed — deploying rules
    needs Sahil's approval). Never add any of this to the member-read sitedata blob or to sunflower/index.html.
  * The API key is read from ZONEOMICS_API_KEY and is never printed, logged, or written.

The pull calls every GET (and the documented POST /ask) in the current public v2 sidebar.
POST /v2/request is a coverage-request write and is not called.
The overview page mentions /prospect, but that page 404s and it is not in the endpoint sidebar, so it is not called.
Point and area are the same path; a parcel is queried once, by point, so it is not billed twice.

Doc URLs (fetched 2026-11-16 from https://www.zoneomics.com/api-documentation):
  zoneDetail          https://www.zoneomics.com/api-documentation/zoning-point
                      area form (same path, not called separately):
                      https://www.zoneomics.com/api-documentation/zoning-area
  conditionalControls https://www.zoneomics.com/api-documentation/conditionalControls
  flumDetails         https://www.zoneomics.com/api-documentation/flum-point
                      area form (same path, not called separately):
                      https://www.zoneomics.com/api-documentation/flum-area
  flumTiles           https://www.zoneomics.com/api-documentation/flum-tiles
  jurisdictions       https://www.zoneomics.com/api-documentation/get-jurisdictions
  parkingDetail       https://www.zoneomics.com/api-documentation/parkingDetail
  strDetail           https://www.zoneomics.com/api-documentation/strDetail
  zonePermits         https://www.zoneomics.com/api-documentation/get-permits
  tiles               https://www.zoneomics.com/api-documentation/tiles
  zoneScreenshot      https://www.zoneomics.com/api-documentation/zone-screenshots
                      (the docs call this a zoning-map screenshot; there is no "screener" path)
  zoneCodeLink        https://www.zoneomics.com/api-documentation/get-zonecodelink
                      (ordinance URL; the docs have no separate code-text body endpoint)
  ask                 https://www.zoneomics.com/api-documentation/ask
  request             https://www.zoneomics.com/api-documentation/request
                      (POST a coverage request — not called)

output_fields=all is sent only where the docs list output_fields. A 400 retries the documented
list, then omits the parameter. Other endpoints do not send it.

  python3 zoneomics.py build --provider mock
  python3 zoneomics.py build --provider zoneomics
  python3 zoneomics.py pull --id SITE --lat LAT --lng LNG [--state STATE] [--city CITY]
  python3 zoneomics.py push [--apply]
"""
import argparse, datetime, hashlib, json, math, os, time

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(HERE, "private", "sitedata.json")
OUT = os.path.join(HERE, "private", "zoning.json")
CACHE = os.path.join(HERE, "private", "zoneomics_v2")
NUM = ("max_height_ft", "max_lot_coverage_pct", "max_far")
TIMEOUT = 30
RAW_CAP = 700000
DOCS = "https://www.zoneomics.com/api-documentation"

# name, path, doc slug, output_fields attempts (None = omit), kind, zone-scoped cache
# attempts: "all" first where the docs accept output_fields, then the documented list, then omit.
V2_CALLS = (
    ("zoneDetail", "/zoneDetail", "zoning-point", ("all", "plu,plu-tags,controls,geom,parcels", None), "point", False),
    ("conditionalControls", "/conditionalControls", "conditionalControls", ("all", None), "point", True),
    ("flumDetails", "/flumDetails", "flum-point", ("all", "flum,flum_plu,flum_controls,flum_parcel,flum_geom", None), "point", False),
    ("jurisdictions", "/jurisdictions", "get-jurisdictions", (None,), "jurisdictions", True),
    ("parkingDetail", "/parkingDetail", "parkingDetail", (None,), "point", True),
    ("strDetail", "/strDetail", "strDetail", (None,), "point", True),
    ("zonePermits", "/zonePermits", "get-permits", (None,), "permits", False),
    ("tiles", "/tiles", "tiles", (None,), "tiles", False),
    ("flumTiles", "/flum/tiles", "flum-tiles", (None,), "flumTiles", False),
    ("zoneScreenshot", "/zoneScreenshot", "zone-screenshots", (None,), "screenshot", False),
    ("zoneCodeLink", "/zoneCodeLink", "get-zonecodelink", (None,), "point", True),
    ("ask", "/ask", "ask", (None,), "ask", False),
)
NOT_CALLED = (
    ("request", "/request", "request", "POST writes a coverage request; not part of the pull"),
    ("prospect", "/prospect", "", "named on the overview page only; no doc page and not in the v2 sidebar"),
)


class ZoningProvider:
    name = "base"
    def lookup(self, site):
        raise NotImplementedError

def _f(v, src):
    return None if v is None else {"v": float(v), "src": src}

def _parcel_key(site):
    ident = str(site.get("id") or "")
    lat, lng = site.get("lat"), site.get("lng", site.get("lon"))
    loc = ""
    if lat is not None and lng is not None:
        loc = f"{round(float(lat), 5)},{round(float(lng), 5)}"
    return hashlib.sha1(f"{ident}|{loc}".encode()).hexdigest()[:20]

def _zone_key(code, jurisdiction):
    if not code:
        return ""
    return hashlib.sha1(f"{code}|{jurisdiction or ''}".encode()).hexdigest()[:20]

def _point(site):
    lat, lng = site.get("lat"), site.get("lng", site.get("lon"))
    if lat is not None and lng is not None:
        return float(lat), float(lng)
    from shapely.geometry import shape
    c = shape(site["geo"]["site"]).centroid
    return float(c.y), float(c.x)

def _tile(lat, lng, z):
    n = 2 ** z
    x = int((lng + 180.0) / 360.0 * n)
    lat_r = math.radians(max(-85.0, min(85.0, lat)))
    y = int((1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y)), z

def _data(body):
    if isinstance(body, dict):
        inner = body.get("data")
        return inner if isinstance(inner, dict) else body
    return {}

def _walk_text(obj, key):
    found = []
    def walk(o):
        if isinstance(o, dict):
            if o.get(key):
                found.append(str(o[key]))
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(obj)
    return found

def _clip(v, n):
    if v is None:
        return None
    s = " ".join(str(v).split())
    return s[:n] if s else None

class ZoneomicsClient(ZoningProvider):
    """Live v2 client. One call per sidebar endpoint, cached by parcel and by zone."""
    name = "zoneomics"
    def __init__(self, key=None, base=None, transport=None, cache_dir=None, sleep=None, timeout=TIMEOUT):
        self.key = key or os.environ.get("ZONEOMICS_API_KEY")
        self.base = (base or os.environ.get("ZONEOMICS_BASE", "https://api.zoneomics.com/v2")).rstrip("/")
        self.transport = transport or self._http
        self.cache_dir = cache_dir or CACHE
        self.sleep = sleep or time.sleep
        self.timeout = timeout
        if not self.key:
            raise SystemExit("ZONEOMICS_API_KEY not set (use --provider mock until a key is available)")

    def _redact(self, text):
        s = "" if text is None else str(text)
        if self.key:
            s = s.replace(self.key, "<KEY>")
        return s

    def _redact_obj(self, obj):
        if isinstance(obj, dict):
            return {self._redact(k): self._redact_obj(v) for k, v in obj.items() if k != "api_key"}
        if isinstance(obj, list):
            return [self._redact_obj(v) for v in obj]
        if isinstance(obj, str):
            return self._redact(obj)
        return obj

    def _http(self, method, url, params, json_body, timeout):
        import requests
        r = requests.request(method, url, params=params or None, json=json_body, timeout=timeout)
        return r.status_code, {k.lower(): v for k, v in r.headers.items()}, r.content

    def _send(self, method, url, params, json_body):
        delay = 1.0
        last = None
        for attempt in range(4):
            try:
                status, headers, raw = self.transport(method, url, params, json_body, self.timeout)
            except Exception as e:
                last = e
                if attempt == 3:
                    raise
                self.sleep(min(delay, 8))
                delay *= 2
                continue
            headers = {str(k).lower(): v for k, v in (headers or {}).items()}
            if status in (429, 503) and attempt < 3:
                ra = headers.get("retry-after")
                try:
                    wait = min(float(ra), 8) if ra else delay
                except (TypeError, ValueError):
                    wait = delay
                self.sleep(wait)
                delay *= 2
                continue
            return status, headers, raw
        raise last

    def _decode(self, status, headers, raw):
        ctype = str((headers or {}).get("content-type") or "")
        raw = raw or b""
        if "json" in ctype or (raw[:1] in (b"{", b"[")):
            try:
                body = json.loads(raw.decode("utf-8", "replace"))
            except Exception:
                body = {"text": self._redact(raw[:200].decode("utf-8", "replace"))}
            return self._redact_obj(body)
        return {"binary": True, "content_type": ctype.split(";")[0][:80], "nbytes": len(raw)}

    def _query(self, path, params, attempts, method="GET", json_body=None):
        """Try output_fields attempts. A 400 advances to the next attempt."""
        last = None
        for fields in attempts:
            q = {k: v for k, v in (params or {}).items() if v is not None and k != "api_key"}
            q["api_key"] = self.key
            if fields:
                q["output_fields"] = fields
            body = None
            if json_body is not None:
                body = dict(json_body)
                body["api_key"] = self.key
                q = {}
            try:
                status, headers, raw = self._send(method, self.base + path, q, body)
            except Exception as e:
                return {"status": 0, "fields": fields or "", "body": None, "error": self._redact(e)[:200]}
            last = {"status": status, "fields": fields or "", "body": self._decode(status, headers, raw), "error": None}
            if status != 400 or not fields:
                return last
        return last

    def _params(self, kind, lat, lng, site):
        if kind == "point" or kind == "screenshot":
            q = {"lat": round(lat, 6), "lng": round(lng, 6)}
            if kind == "screenshot":
                q["map_zoom_level"] = 15
            return q, None
        if kind == "permits":
            return {"lat": round(lat, 6), "lng": round(lng, 6), "radius": 200}, None
        if kind in ("tiles", "flumTiles"):
            z = 15
            x, y, _ = _tile(lat, lng, z)
            return {"x": x, "y": y, "z": z}, None
        if kind == "jurisdictions":
            state, city = site.get("state") or "", site.get("city") or ""
            if state:
                return {"state": state}, None
            if city:
                return {"name": city}, None
            return None, None
        if kind == "ask":
            q = ("What zoning district, permitted uses, setbacks, overlays, and ordinance "
                 f"section text apply at latitude {lat:.5f}, longitude {lng:.5f}?")
            return {}, {"query": q, "conversation_id": ""}
        return {"lat": round(lat, 6), "lng": round(lng, 6)}, None

    def _read(self, kind, key, endpoint):
        if not key:
            return None
        path = os.path.join(self.cache_dir, kind, key, endpoint + ".json")
        if not os.path.exists(path):
            return None
        return json.load(open(path))

    def _write(self, kind, key, endpoint, entry):
        if not key:
            return
        path = os.path.join(self.cache_dir, kind, key, endpoint + ".json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        text = json.dumps(self._redact_obj(entry), separators=(",", ":"))
        if self.key and self.key in text:
            text = text.replace(self.key, "<KEY>")
        open(path, "w").write(text)

    def _one(self, spec, lat, lng, site, parcel, zone):
        name, path, _slug, attempts, kind, zone_scoped = spec
        hit = self._read("parcel", parcel, name)
        if hit:
            hit["cache"] = "parcel"
            return hit
        if zone_scoped and zone:
            hit = self._read("zone", zone, name)
            if hit:
                hit = dict(hit, cache="zone")
                self._write("parcel", parcel, name, hit)
                return hit
        if kind == "jurisdictions":
            state, city = site.get("state") or "", site.get("city") or ""
            jkey = ("state:" + state) if state else (("city:" + city) if city else "")
            if jkey:
                jhash = hashlib.sha1(jkey.encode()).hexdigest()[:20]
                hit = self._read("zone", jhash, name)
                if hit:
                    hit = dict(hit, cache="zone")
                    self._write("parcel", parcel, name, hit)
                    return hit
            else:
                entry = {"endpoint": name, "status": 0, "fields": "", "body": None,
                         "error": "no state or city; the all-cities dump is not pulled per parcel",
                         "fetched": datetime.date.today().isoformat(), "cache": "skip"}
                self._write("parcel", parcel, name, entry)
                return entry
        params, body = self._params(kind, lat, lng, site)
        if params is None and body is None:
            entry = {"endpoint": name, "status": 0, "fields": "", "body": None, "error": "no query",
                     "fetched": datetime.date.today().isoformat(), "cache": "miss"}
        else:
            method = "POST" if kind == "ask" else "GET"
            got = self._query(path, params, attempts, method, body)
            entry = {"endpoint": name, "status": got["status"], "fields": got["fields"], "body": got["body"],
                     "error": got["error"], "fetched": datetime.date.today().isoformat(), "cache": "miss"}
        if entry.get("status"):
            self._write("parcel", parcel, name, entry)
        if zone_scoped and zone and entry["status"] == 200 and kind != "jurisdictions":
            self._write("zone", zone, name, entry)
        if kind == "jurisdictions" and entry["status"] == 200:
            state, city = site.get("state") or "", site.get("city") or ""
            jkey = ("state:" + state) if state else ("city:" + city)
            self._write("zone", hashlib.sha1(jkey.encode()).hexdigest()[:20], name, entry)
        return entry

    def pull(self, site):
        """Full v2 pull. Cache hits make no HTTP call. One endpoint failing does not stop the rest."""
        lat, lng = _point(site)
        parcel = _parcel_key(site)
        results = {}
        zone = ""
        for spec in V2_CALLS:
            if spec[0] != "zoneDetail" and not zone:
                zd = results.get("zoneDetail") or {}
                code = (_data(zd.get("body")).get("zone_details") or {}).get("zone_code") or ""
                jur = (_data(zd.get("body")).get("meta") or {}).get("city_name") or ""
                zone = _zone_key(code, jur)
            try:
                results[spec[0]] = self._one(spec, lat, lng, site, parcel, zone if spec[5] else "")
            except Exception as e:
                # A transport failure is not a billed response, so it is not cached.
                results[spec[0]] = {"endpoint": spec[0], "status": 0, "fields": "", "body": None,
                                    "error": self._redact(e)[:200], "fetched": datetime.date.today().isoformat(), "cache": "error"}
        rec = assemble(results, lat, lng)
        rec["cache_parcel"] = parcel
        rec["cache_zone"] = zone
        return rec

    def lookup(self, site):
        return self.pull(site)


def _overlays(entry):
    if not entry or entry.get("status") != 200:
        return None
    d = _data(entry.get("body"))
    st = d.get("short_term_rental") or {}
    parts = []
    ov = st.get("short_term_rental_overlay")
    if ov is True:
        parts.append("STR overlay")
    elif ov is False:
        parts.append("no STR overlay")
    extra = d.get("overlays")
    if isinstance(extra, list) and extra:
        parts.append(", ".join(str(x)[:40] for x in extra[:6]))
    elif isinstance(extra, str) and extra.strip():
        parts.append(extra.strip()[:80])
    return _clip("; ".join(parts), 80)

def _flum_name(entry):
    if not entry or entry.get("status") != 200:
        return None
    d = _data(entry.get("body"))
    fl = d.get("flum") or d.get("Flum") or {}
    if isinstance(fl, list):
        fl = fl[0] if fl else {}
    if not isinstance(fl, dict):
        fl = {}
    return _clip(fl.get("future_land_use_name") or fl.get("flum_code") or d.get("flum_code") or d.get("future_land_use_name"), 60)

def _code_link(entry):
    if not entry or entry.get("status") != 200:
        return None
    d = _data(entry.get("body"))
    return _clip(d.get("local_ordinance_link") or (d.get("zone_details") or {}).get("link"), 160)

def _parking_text(entry):
    if not entry or entry.get("status") != 200:
        return None
    d = _data(entry.get("body"))
    pr = d.get("parking_requirements")
    if isinstance(pr, str):
        return _clip(pr, 80)
    texts = _walk_text(pr, "parking_text") if pr is not None else []
    return _clip(texts[0], 80) if texts else None

def _has_key(body, *keys):
    d = _data(body)
    return any(d.get(k) not in (None, "", [], {}) for k in keys)

def assemble(results, lat, lng):
    """Normalised ZoningRecord plus a coverage table. Raw bodies stay out of this dict."""
    from zoning_lookup import normalize
    zd = results.get("zoneDetail") or {}
    today = datetime.date.today().isoformat()
    if zd.get("status") == 200 and isinstance(zd.get("body"), dict):
        rec = normalize({"status": 200, "body": zd["body"], "fetched": zd.get("fetched") or today}, lat, lng)
    else:
        rec = {"status": "error" if zd.get("status") not in (None, 200) else "no_coverage", "fixture": False,
               "lat": lat, "lng": lng, "fetched": today, "src": "Zoneomics", "district": None, "district_name": None,
               "dc_use": None, "storage_use": None,
               "setbacks_ft": {"front": None, "side": None, "rear": None},
               "max_height_ft": None, "max_lot_coverage_pct": None, "max_far": None,
               "parking": {"text": None, "per_1000sf": None, "per_building": None}}
    for k in ("owner", "apn", "owner_info", "parcels", "geom", "geometry"):
        rec.pop(k, None)
    text = _parking_text(results.get("parkingDetail"))
    if text and isinstance(rec.get("parking"), dict):
        rec["parking"]["text"] = text
    elif text:
        rec["parking"] = {"text": text, "per_1000sf": None, "per_building": None}
    rec["overlays"] = _overlays(results.get("strDetail"))
    rec["flum"] = _flum_name(results.get("flumDetails"))
    rec["code_link"] = _code_link(results.get("zoneCodeLink"))
    rec["geom_ok"] = bool(zd.get("status") == 200 and _has_key(zd.get("body"), "geom", "geometry", "boundary"))
    rec["parcel_ok"] = bool(zd.get("status") == 200 and _has_key(zd.get("body"), "parcels", "parcel"))
    shot = results.get("zoneScreenshot") or {}
    rec["screenshot_ok"] = shot.get("status") == 200
    permits = results.get("zonePermits") or {}
    rec["permits_ok"] = permits.get("status") == 200
    tiles = results.get("tiles") or {}
    rec["tiles_ok"] = tiles.get("status") == 200
    rec["coverage"] = [{"endpoint": name, "status": int((results.get(name) or {}).get("status") or 0),
                        "fields": str((results.get(name) or {}).get("fields") or "")} for name, *_ in V2_CALLS]
    return rec

def coverage_ok(rec):
    rows = rec.get("coverage") or []
    return {r["endpoint"]: r for r in rows}


class MockZoneomics(ZoningProvider):
    """FAKE FIXTURE. Deterministic made-up values so the UI can be built before a live pull.
    NOT real zoning. Every value is labelled 'FAKE fixture'."""
    name = "mock"
    def lookup(self, site):
        h = int(hashlib.sha1(str(site.get("id") or "fixture").encode()).hexdigest(), 16)
        st = site.get("view") == "storage"
        src = "FAKE fixture (zoneomics mock)"
        d = ["I-1", "I-2", "BP", "M-1"][h % 4] if not st else ["C-2", "C-3", "I-1"][h % 3]
        return {"district": d, "district_name": "FAKE " + d,
                "permitted_uses": ["warehouse", "data center (conditional)"] if not st else ["self-storage (conditional)", "retail"],
                "dc_use": ["permitted", "conditional", "not listed"][h % 3], "storage_use": ["permitted", "conditional"][h % 2],
                "setbacks_ft": {"front": _f([25, 50, 75][h % 3], src), "side": _f([15, 25, 50][(h >> 3) % 3], src), "rear": _f([20, 30, 50][(h >> 5) % 3], src)},
                "max_height_ft": _f(([45, 60, 75, 100] if not st else [35, 45, 55])[(h >> 7) % (4 if not st else 3)], src),
                "max_lot_coverage_pct": _f([40, 50, 60, 70][(h >> 9) % 4], src), "max_far": _f([0.5, 0.75, 1.0, 1.5][(h >> 11) % 4], src),
                "parking": {"text": "FAKE: 1 per 1,000 sf office + 1 per 4 employees", "per_1000sf": 1.0, "per_building": 40.0 if not st else 6.0},
                "overlays": "none listed", "flum": "FIXTURE", "code_link": None, "geom_ok": False, "screenshot_ok": False,
                "parcel_ok": False, "permits_ok": False, "tiles_ok": False,
                "coverage": [{"endpoint": name, "status": 200, "fields": "fixture"} for name, *_ in V2_CALLS],
                "src": src, "fetched": "fixture", "fixture": True}

def build(a):
    P = MockZoneomics() if a.provider == "mock" else ZoneomicsClient()
    d = json.load(open(PUB))
    out = {"meta": {"provider": P.name, "fixture": P.name == "mock", "built": datetime.datetime.now().isoformat(timespec="seconds"),
                    "handling": "ADMIN-ONLY. Do not commit, share, or add to member-read blobs."}, "sites": {}}
    for o in d["sites"].values():
        if not o.get("geo", {}).get("site") and o.get("lat") is None:
            continue
        try:
            out["sites"][o["id"]] = P.lookup(o)
        except Exception as e:
            msg = e
            key = getattr(P, "key", None)
            if key:
                msg = str(e).replace(key, "<KEY>")
            print("  zoning fail", str(o.get("id") or "")[:40], msg)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(out, open(OUT, "w"), separators=(",", ":"))
    print(f"[zoneomics] {P.name}: {len(out['sites'])} sites -> {os.path.relpath(OUT, HERE)}{' (FAKE FIXTURE)' if P.name == 'mock' else ''}")

def _parent_record(rec):
    """The doc the app parses. Coverage and scalars only — raw bodies live in the subcollection."""
    return {k: v for k, v in rec.items() if k not in ("cache_parcel", "cache_zone")}

def _raw_payload(entry, key):
    body = entry.get("body")
    text = json.dumps(body, separators=(",", ":")) if body is not None else ""
    if key and key in text:
        text = text.replace(key, "<KEY>")
        body = json.loads(text) if text else None
    if len(text) > RAW_CAP:
        body = {"truncated": True, "sha256": hashlib.sha256(text.encode()).hexdigest(), "nbytes": len(text)}
    return {"endpoint": entry.get("endpoint"), "status": int(entry.get("status") or 0),
            "fields": str(entry.get("fields") or ""), "body": body, "fetched": entry.get("fetched") or "",
            "error": (entry.get("error") or "")[:200]}

def push(a):
    """zoning/{siteId} = {j, h, fixture, src, coverage}. Raw endpoint JSON goes to zoning/{siteId}/raw/{endpoint}."""
    Z = json.load(open(OUT))
    if Z["meta"].get("fixture") and not a.allow_fixture:
        raise SystemExit("refusing to push FAKE fixture data (pass --allow-fixture for an emulator only)")
    import edks
    c = edks.db()
    col = c.collection("zoning")
    W = []
    for sid, rec in Z["sites"].items():
        parent = _parent_record(rec)
        j = json.dumps(parent, separators=(",", ":"))
        h = hashlib.sha1(j.encode()).hexdigest()[:16]
        old = col.document(sid).get()
        raw_docs = []
        if not rec.get("fixture"):
            parcel = rec.get("cache_parcel") or ""
            folder = os.path.join(CACHE, "parcel", parcel) if parcel else ""
            if folder and os.path.isdir(folder):
                for fn in sorted(os.listdir(folder)):
                    if not fn.endswith(".json"):
                        continue
                    entry = json.load(open(os.path.join(folder, fn)))
                    raw_docs.append((fn[:-5], _raw_payload(entry, os.environ.get("ZONEOMICS_API_KEY"))))
        changed = not (old.exists and (old.to_dict() or {}).get("h") == h)
        if changed or raw_docs:
            W.append((sid, {"j": j, "h": h, "fixture": bool(rec.get("fixture")), "src": rec.get("src", ""),
                            "coverage": parent.get("coverage") or []}, raw_docs, changed))
    print(f"[zoneomics] {len(Z['sites'])} reads, {sum(1 for _s, _v, _r, ch in W if ch)} parent writes, "
          f"{sum(len(r) for _s, _v, r, _c in W)} raw endpoint writes planned")
    if a.apply:
        for sid, v, raw_docs, changed in W:
            if changed:
                col.document(sid).set(v)
            for name, doc in raw_docs:
                col.document(sid).collection("raw").document(name).set(doc)
        print("[zoneomics] pushed")
    else:
        print("[zoneomics] dry run; pass --apply to write (needs approval). Rules for zoning/{id}/raw are not deployed.")

def pull_cmd(a):
    """Print the coverage table only. Raw JSON stays in the private cache."""
    site = {"id": a.id, "lat": a.lat, "lng": a.lng, "state": a.state or "", "city": a.city or ""}
    rec = ZoneomicsClient().pull(site)
    for row in rec.get("coverage") or []:
        print(f"{row['endpoint']}\t{row['status']}\t{row['fields']}")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    b = sp.add_parser("build")
    b.add_argument("--provider", choices=["mock", "zoneomics"], default="mock")
    p = sp.add_parser("push")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--allow-fixture", action="store_true")
    u = sp.add_parser("pull")
    u.add_argument("--id", required=True)
    u.add_argument("--lat", type=float, required=True)
    u.add_argument("--lng", type=float, required=True)
    u.add_argument("--state", default="")
    u.add_argument("--city", default="")
    a = ap.parse_args()
    {"build": build, "push": push, "pull": pull_cmd}[a.cmd](a)
