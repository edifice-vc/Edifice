"""Site Planning no-build constraints (admin-only): easements, drawn exclusions, site power caps, and a site-data
record (FEMA flood / 3DEP slope) for deals outside meta/sitedata.

Inputs live ONLY in pipeline/private (gitignored, never committed):
  private/site_constraints_src.json   {site_id: {name, lat, lon, acres, restricted, caps:{grid_mw,grid_src,gas_mw,gas_src},
                                         easements:[{id,type,label,width_ft,setback_ft,approx,basis,
                                                     osm_way: <id> | geometry: LineString}], exclusions:[...], gaps:[...]}}
Output:
  private/site_constraints.json       same shape with easement geometry resolved (OSM ways clipped near the site) and sd.

  python3 site_constraints.py stage            # build the private output (public OSM / FEMA / USGS reads only)
  python3 site_constraints.py trace SITE FILE.geojson --id nustar --type hl [--width 75 --setback 50] [--label ..] [--basis ..]
                                               # hand-traced easement (LineString centreline + width, or Polygon of the full
                                               # easement) replaces easement --id in the private src; hard no-build in the planner
  python3 site_constraints.py parcel SITE FILE.geojson [--src ..] [--acres ..]   # stored parcel boundary (replaces the square)
  python3 site_constraints.py push [--apply]   # site_constraints/{id} docs {j,h,restricted,by,ts}; dry run without --apply.
                                               # 1 read per site for the hash skip; 1 write per changed site.
Production write: needs Sahil's explicit approval before --apply.
"""
import argparse, datetime as dt, hashlib, json, math, os, sys
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "private", "site_constraints_src.json")
OUT = os.path.join(HERE, "private", "site_constraints.json")
OSM = "https://api.openstreetmap.org/api/0.6/way/{}/full.json"


def square(lat, lon, acres):
    """The acre square Site Planning draws around the pin when no parcel is on file (matches spSquare)."""
    h = math.sqrt(acres * 43560) / 2; kx = 364000 * math.cos(math.radians(lat)); ky = 364000
    pts = [(-h, -h), (h, -h), (h, h), (-h, h), (-h, -h)]
    return {"type": "Polygon", "coordinates": [[[round(lon + x / kx, 7), round(lat + y / ky, 7)] for x, y in pts]]}


def osm_line(way, lat, lon, margin_mi=1.0):
    """Way centreline from the public OSM API, trimmed to vertices within margin of the pin (plus one neighbour each side)."""
    j = requests.get(OSM.format(way), timeout=40, headers={"User-Agent": "edifice-site-constraints/1"}).json()
    nodes = {e["id"]: (e["lon"], e["lat"]) for e in j["elements"] if e["type"] == "node"}
    w = next(e for e in j["elements"] if e["type"] == "way")
    pts = [nodes[n] for n in w["nodes"] if n in nodes]
    kx = 69.17 * math.cos(math.radians(lat))
    near = [i for i, (x, y) in enumerate(pts) if math.hypot((x - lon) * kx, (y - lat) * 69.17) <= margin_mi]
    if not near: return None, w
    a, b = max(0, near[0] - 1), min(len(pts), near[-1] + 2)
    return {"type": "LineString", "coordinates": [[round(x, 7), round(y, 7)] for x, y in pts[a:b]]}, w


def stage(a):
    import site_data
    src = json.load(open(SRC)); old = json.load(open(OUT)) if os.path.exists(OUT) else {}
    out = {}
    for sid, c in src.items():
        c = json.loads(json.dumps(c))
        for e in c.get("easements", []):
            if e.get("osm_way") and not e.get("geometry"):
                g, w = osm_line(e["osm_way"], c["lat"], c["lon"])
                e["geometry"] = g
                t = w.get("tags", {})
                e.setdefault("basis", "")
                e["basis"] = (e["basis"] + f" Centreline: OpenStreetMap way {w['id']} v{w.get('version')} "
                              f"({t.get('name', '')}, operator {t.get('operator', '?')}, {t.get('substance', '?')}), "
                              f"fetched {dt.date.today()}. OSM gives no survey accuracy for this line.").strip()
        if c.pop("need_sd", False) or a.sd:
            prev = (old.get(sid) or {}).get("sd")
            if prev and not a.sd: c["sd"] = prev
            else:
                rec = {"id": sid, "name": c.get("name"), "lat": c["lat"], "lon": c["lon"], "acres": c["acres"],
                       "site_geojson": square(c["lat"], c["lon"], c["acres"])}
                sd, _priv = site_data.one(rec)               # parcels (private) are dropped
                sd.pop("parcels", None); sd["site_method"] = f"{c['acres']:g}-ac square around the pin (Site Planning default)"
                c["sd"] = sd
        out[sid] = c
        print(f"[constraints] {sid}: {len(c.get('easements', []))} easements, {len(c.get('exclusions', []))} exclusions,"
              f" caps {c.get('caps', {})}, sd {'yes' if c.get('sd') else 'no'}")
    json.dump(out, open(OUT, "w"), separators=(",", ":"))
    print(f"[constraints] wrote {OUT} ({os.path.getsize(OUT)//1024} KB)")


def load_trace(path):
    """GeoJSON (Feature, FeatureCollection or bare geometry) -> one LineString/MultiLineString/Polygon/MultiPolygon in lon,lat."""
    j = json.load(open(path))
    if j.get("type") == "FeatureCollection":
        gs = [f["geometry"] for f in j["features"] if f.get("geometry")]
    elif j.get("type") == "Feature":
        gs = [j["geometry"]]
    else:
        gs = [j]
    kinds = {g["type"].replace("Multi", "") for g in gs}
    if len(kinds) != 1 or kinds - {"LineString", "Polygon"}:
        raise SystemExit(f"trace: need all LineStrings or all Polygons, got {sorted(kinds)}")
    k = kinds.pop()
    parts = [c for g in gs for c in (g["coordinates"] if g["type"].startswith("Multi") else [g["coordinates"]])]
    for part in parts:
        for p in (part if k == "LineString" else [q for r in part for q in r]):
            if not (-180 <= p[0] <= 180 and -90 <= p[1] <= 90):
                raise SystemExit(f"trace: coordinate {p} is not lon,lat")
    rnd = lambda v: [round(v[0], 7), round(v[1], 7)]
    if k == "LineString":
        parts = [[rnd(p) for p in L] for L in parts]
        return {"type": "LineString", "coordinates": parts[0]} if len(parts) == 1 else {"type": "MultiLineString", "coordinates": parts}
    parts = [[[rnd(p) for p in R] for R in P] for P in parts]
    return {"type": "Polygon", "coordinates": parts[0]} if len(parts) == 1 else {"type": "MultiPolygon", "coordinates": parts}


def trace(a, src_path=None):
    src_path = src_path or SRC
    src = json.load(open(src_path)); c = src.get(a.site)
    if c is None: raise SystemExit(f"trace: {a.site} not in {src_path}")
    g = load_trace(a.file)
    if g["type"].endswith("LineString") and a.width is None:
        raise SystemExit("trace: a centreline needs --width (recorded easement width, ft)")
    eas = c.setdefault("easements", []); old = next((e for e in eas if e.get("id") == a.id), {})
    e = {"id": a.id, "type": a.type or old.get("type", "ue"), "label": a.label or old.get("label", "Traced easement"),
         "width_ft": a.width, "setback_ft": a.setback if a.setback is not None else 0, "approx": bool(getattr(a, "approx", False)), "hard": True,
         "basis": a.basis or f"Hand-traced from the recorded easement map ({os.path.basename(a.file)}), {dt.date.today()}.",
         "geometry": g}
    if old.get("osm_way"): e["superseded"] = f"OSM way {old['osm_way']} (approximate centreline)"
    c["easements"] = [x for x in eas if x.get("id") != a.id] + [e]
    json.dump(src, open(src_path, "w"), indent=1)
    print(f"[constraints] {a.site}: easement {a.id} <- {g['type']} from {a.file}; run stage, then push --apply (needs Sahil's OK)")
    return e


def parcel(a, src_path=None):
    """Store a parcel boundary (GeoJSON Polygon, lon/lat) on the site; Site Planning uses it instead of the acre square."""
    src_path = src_path or SRC
    src = json.load(open(src_path)); c = src.get(a.site)
    if c is None: raise SystemExit(f"parcel: {a.site} not in {src_path}")
    g = load_trace(a.file)
    if not g["type"].endswith("Polygon"): raise SystemExit("parcel: need a Polygon")
    c["parcel"] = g; c["parcel_src"] = a.src or os.path.basename(a.file)
    if a.acres: c["parcel_ac"] = a.acres
    json.dump(src, open(src_path, "w"), indent=1)
    print(f"[constraints] {a.site}: parcel <- {g['type']} from {a.file}; run stage, then push --apply (needs Sahil's OK)")
    return g


def push(a):
    import edks
    from google.cloud import firestore
    data = json.load(open(OUT)); client = edks.db(); plan = []
    for sid, c in data.items():
        j = json.dumps(c, separators=(",", ":")); h = hashlib.sha1(j.encode()).hexdigest()[:20]
        d = client.collection("site_constraints").document(sid).get()
        if d.exists and (d.to_dict() or {}).get("h") == h: print(f"[constraints] {sid} unchanged"); continue
        plan.append((sid, j, h, bool(c.get("restricted"))))
        print(f"[constraints] {sid}: write site_constraints/{sid} ({len(j)//1024} KB, restricted={bool(c.get('restricted'))})")
    print(f"[constraints] {len(data)} reads, {len(plan)} writes planned")
    if not a.apply: print("[constraints] dry run; pass --apply to write"); return
    for sid, j, h, r in plan:
        client.collection("site_constraints").document(sid).set({"j": j, "h": h, "restricted": r, "by": "pipeline", "ts": firestore.SERVER_TIMESTAMP})
    print("[constraints] pushed")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); sp = ap.add_subparsers(dest="cmd", required=True)
    s = sp.add_parser("stage"); s.add_argument("--sd", action="store_true", help="recompute sd for every site")
    p = sp.add_parser("push"); p.add_argument("--apply", action="store_true")
    t = sp.add_parser("trace"); t.add_argument("site"); t.add_argument("file"); t.add_argument("--id", default="traced")
    t.add_argument("--type"); t.add_argument("--label"); t.add_argument("--basis")
    t.add_argument("--approx", action="store_true", help="scaled/estimated geometry (dashed, flagged APPROXIMATE)")
    t.add_argument("--width", type=float); t.add_argument("--setback", type=float)
    q = sp.add_parser("parcel"); q.add_argument("site"); q.add_argument("file"); q.add_argument("--src"); q.add_argument("--acres", type=float)
    a = ap.parse_args(); sys.path.insert(0, HERE); {"stage": stage, "push": push, "trace": trace, "parcel": parcel}[a.cmd](a)
