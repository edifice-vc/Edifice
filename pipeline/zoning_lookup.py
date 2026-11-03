"""On-demand, cached Zoneomics zoning lookup for Site Planning (ADMIN-ONLY licensed data).

Scope (Sahil, Nov 3 2026): fetch zoning only when a deal enters the Site Plan tool; cache it forever after the first
fetch. No bulk pulls. Zoneomics licence: internal business use only, no republishing/redistribution/resale.
  * Raw responses: pipeline/private/zoneomics_cache/ll_<lat>_<lng>.json (gitignored). Never committed.
  * Normalised records: Firestore zoning/{siteId} (rules: admin read, client write false). Never member-read blobs.
  * The API key is read from ZONEOMICS_API_KEY and is never printed, logged or written (errors are redacted).

DATA CONTRACT (ZoningRecord, one per site; the app reads zoning/{siteId}.j = JSON of this):
  status            "ok" | "no_coverage" | "error"
  jurisdiction      e.g. "Mcpherson County Unincorporated"     data_updated  Zoneomics last_updated date
  district, district_name, zone_type, zone_sub_type, link
  uses              {as_of_right:[str], conditional:[str], prohibited:[str]}   (capped at 200 each)
  flags             {industrial_uses_permitted, commercial_uses_permitted}      (bool|None, from Zoneomics)
  treatment         {data_center|industrial|self_storage: {status, matches:[str]}}
                    status in "permitted" | "conditional" | "prohibited" | "not listed"
  dc_use, storage_use   = treatment.data_center.status / treatment.self_storage.status (legacy fields the app uses)
  setbacks_ft       {front, side, rear}: {v: float, src} | None     <- the layout solver consumes these
  max_height_ft, max_lot_coverage_pct, max_far, min_lot_area_sf, min_lot_width_ft: {v, src} | None
  overlays          [str]  (only if Zoneomics returns overlay data; empty otherwise)
  parking           {text, per_1000sf, per_building}
  lat, lng, src, fetched (ISO date), fixture: false
Numeric fields: "NA" / "STF" (see text field) values become None, so the solver falls back to its defaults.

Python:   from zoning_lookup import lookup;  rec = lookup(lat, lng)          # cache hit = 0 API calls
CLI:      python3 zoning_lookup.py latlng LAT LNG [--offline]
          python3 zoning_lookup.py stage SITE_ID [SITE_ID ...]   # -> private/zoning_stage.json (sites from private/zon_sites.json)
          python3 zoning_lookup.py push [--apply]                # dry run unless --apply (needs Sahil's own OK)
"""
import argparse, datetime, hashlib, json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
PRIV = os.path.join(HERE, "private")
CACHE = os.path.join(PRIV, "zoneomics_cache")
SITES = os.path.join(PRIV, "zon_sites.json")
STAGE = os.path.join(PRIV, "zoning_stage.json")
BASE = os.environ.get("ZONEOMICS_BASE", "https://api.zoneomics.com/v2")

PAT = {
    "data_center": re.compile(r"data (center|centre|processing)|server farm|computer (center|facilit)|telecommunication.*(facilit|center)", re.I),
    "self_storage": re.compile(r"self[- ]?(service )?storage|mini[- ]?(storage|warehouse)|storage units?|personal storage", re.I),
    "industrial": re.compile(r"\bindustr|manufacturing|(?<!mini )warehous|distribution (center|facilit)", re.I),
}

def _key(lat, lng): return f"ll_{round(float(lat), 6)}_{round(float(lng), 6)}"

def fetch(lat, lng, offline=False):
    """Raw Zoneomics zoneDetail (plu+controls) for a point. Cached; at most one API call per point, ever."""
    os.makedirs(CACHE, exist_ok=True); f = os.path.join(CACHE, _key(lat, lng) + ".json")
    if os.path.exists(f): return json.load(open(f)), False
    if offline: return None, False
    import requests
    k = os.environ.get("ZONEOMICS_API_KEY")
    if not k: raise SystemExit("ZONEOMICS_API_KEY not set in this process")
    try:
        r = requests.get(f"{BASE}/zoneDetail", params={"api_key": k, "lat": round(float(lat), 6), "lng": round(float(lng), 6),
                                                        "output_fields": "plu,controls"}, timeout=60)
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {"text": r.text[:500]}
        raw = {"status": r.status_code, "body": body, "fetched": datetime.date.today().isoformat()}
    except Exception as e:
        return {"status": 0, "body": {"error": str(e).replace(k, "<KEY>")}}, True    # errors are not cached
    if r.status_code == 200: json.dump(raw, open(f, "w"))
    return json.loads(json.dumps(raw).replace(k, "<KEY>")), True

def _num(v):
    if v is None: return None
    m = re.match(r"^\s*([\d,]*\.?\d+)\s*(acres?)?", str(v))
    if not m: return None
    x = float(m.group(1).replace(",", "")); return x * 43560 if m.group(2) else x

def _ctl(c, group, *keys):
    g = c.get(group) or {}
    for part in ("standard", "non-standard"):
        for k in keys:
            x = _num((g.get(part) or {}).get(k))
            if x is not None: return x
    return None

def _treat(uses, kind):
    for st, lst in (("permitted", uses["as_of_right"]), ("conditional", uses["conditional"]), ("prohibited", uses["prohibited"])):
        m = [u for u in lst if PAT[kind].search(u)]
        if m: return {"status": st, "matches": m[:8]}
    return {"status": "not listed", "matches": []}

def normalize(raw, lat=None, lng=None):
    today = datetime.date.today().isoformat()
    base = {"lat": lat, "lng": lng, "fixture": False, "fetched": (raw or {}).get("fetched", today)}
    if not raw or raw.get("status") != 200:
        return dict(base, status="error", src="Zoneomics", error=str((raw or {}).get("body"))[:200])
    d = (raw.get("body") or {}).get("data") or {}
    if not d: return dict(base, status="no_coverage", src="Zoneomics (no coverage)", message=(raw["body"].get("message") or [""])[0])
    meta, z, p, c = d.get("meta") or {}, d.get("zone_details") or {}, d.get("permitted_land_uses") or {}, d.get("controls") or {}
    uses = {"as_of_right": list(p.get("as_of_right") or [])[:200], "conditional": list(p.get("conditional_uses") or [])[:200],
            "prohibited": list(p.get("prohibited") or [])[:200]}
    src = f"Zoneomics {meta.get('city_name', '')} {z.get('zone_code', '')} ({meta.get('last_updated', '')})".strip()
    F = lambda x: None if x is None else {"v": x, "src": src}
    tr = {k: _treat(uses, k) for k in PAT}
    ov = d.get("overlays") or z.get("overlays") or []
    return dict(base, status="ok", jurisdiction=meta.get("city_name"), data_updated=meta.get("last_updated"),
        district=z.get("zone_code"), district_name=z.get("zone_name"), zone_type=z.get("zone_type"), zone_sub_type=z.get("zone_sub_type"),
        link=z.get("link"), uses=uses,
        flags={"industrial_uses_permitted": p.get("industrial_uses_permitted"), "commercial_uses_permitted": p.get("commercial_uses_permitted")},
        treatment=tr, dc_use=tr["data_center"]["status"], storage_use=tr["self_storage"]["status"],
        permitted_uses=uses["as_of_right"][:60],
        setbacks_ft={"front": F(_ctl(c, "front_setback_standard", "min_front_yard_ft", "minimum_front_yard_ft")),
                     "side": F(_ctl(c, "side_setback_standard", "min_side_yard_ft", "minimum_side_yard_ft")),
                     "rear": F(_ctl(c, "rear_setback_standard", "min_rear_yard_ft", "minimum_rear_yard_ft"))},
        max_height_ft=F(_ctl(c, "building_height_standard", "max_building_height_ft", "maximum_height_ft")),
        max_lot_coverage_pct=F(_ctl(c, "coverage_standard", "max_coverage", "maximum_lot_coverage_percent")),
        max_far=F(_ctl(c, "far_standard", "max_far")),
        min_lot_area_sf=F(_ctl(c, "lot_standard", "min_lot_area_sq_ft", "minimum_lot_area_sq_ft")),
        min_lot_width_ft=F(_ctl(c, "lot_width_standard", "min_lot_width_ft", "minimum_lot_width_ft")),
        overlays=[str(o) for o in ov] if isinstance(ov, list) else [str(ov)],
        parking={"text": None, "per_1000sf": None, "per_building": None}, src=src)

def lookup(lat, lng, offline=False):
    raw, _ = fetch(lat, lng, offline); return normalize(raw, lat, lng) if raw else None

def _brief(sid, r):
    if not r: return f"{sid}: not cached"
    if r["status"] != "ok": return f"{sid}: {r['status']}"
    sb = {k: (v or {}).get("v") for k, v in r["setbacks_ft"].items()}
    return (f"{sid}: {r['jurisdiction']} {r['district']} ({r['district_name']}) DC={r['dc_use']} storage={r['storage_use']} "
            f"industrial={r['treatment']['industrial']['status']} setbacks={sb} height={(r['max_height_ft'] or {}).get('v')}")

def stage(a):
    sites = json.load(open(SITES)); st = json.load(open(STAGE)) if os.path.exists(STAGE) else {"sites": {}}
    calls = 0
    for sid in a.ids:
        o = sites[sid]; raw, net = fetch(o["lat"], o.get("lon", o.get("lng")), a.offline); calls += net
        r = normalize(raw, o["lat"], o.get("lon", o.get("lng"))) if raw else None
        if r: st["sites"][sid] = dict(r, site_name=o.get("name"), view=o.get("view"), restricted=bool(o.get("restricted")))
        print(_brief(sid, r))
    st["meta"] = {"handling": "ADMIN-ONLY Zoneomics licensed data. Do not commit, share, or add to member-read blobs.",
                  "built": datetime.datetime.now().isoformat(timespec="seconds")}
    json.dump(st, open(STAGE, "w"), separators=(",", ":")); print(f"[zoning] {calls} API calls; staged {len(st['sites'])} -> private/zoning_stage.json")

def push(a):
    """zoning/{siteId} = {j, h, fixture:false, src}. Change-hash skip: 1 read per staged site, writes only on change."""
    st = json.load(open(STAGE))["sites"]; import edks
    col = edks.db().collection("zoning"); W = []
    for sid, rec in st.items():
        if rec.get("fixture"): raise SystemExit("refusing to push fixture data")
        rec = {k: v for k, v in rec.items() if k not in ("site_name", "restricted")}
        j = json.dumps(rec, separators=(",", ":")); h = hashlib.sha1(j.encode()).hexdigest()[:16]
        old = col.document(sid).get()
        if old.exists and (old.to_dict() or {}).get("h") == h: continue
        W.append((sid, {"j": j, "h": h, "fixture": False, "src": rec.get("src", "")}))
    print(f"[zoning] {len(st)} reads, {len(W)} writes planned: {[s for s, _ in W]}")
    if a.apply:
        for sid, v in W: col.document(sid).set(v)
        print("[zoning] pushed")
    else: print("[zoning] dry run; pass --apply to write (needs Sahil's own OK)")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); sp = ap.add_subparsers(dest="cmd", required=True)
    l = sp.add_parser("latlng"); l.add_argument("lat", type=float); l.add_argument("lng", type=float); l.add_argument("--offline", action="store_true")
    s = sp.add_parser("stage"); s.add_argument("ids", nargs="+"); s.add_argument("--offline", action="store_true")
    p = sp.add_parser("push"); p.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    if a.cmd == "latlng": print(_brief("point", lookup(a.lat, a.lng, a.offline)))
    else: {"stage": stage, "push": push}[a.cmd](a)
