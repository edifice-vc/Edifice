"""Site Planning no-build constraints (admin-only): easements, drawn exclusions, site power caps, and a site-data
record (FEMA flood / 3DEP slope) for deals outside meta/sitedata.

Inputs live ONLY in pipeline/private (gitignored, never committed):
  private/site_constraints_src.json   {site_id: {name, lat, lon, acres, restricted, caps:{grid_mw,grid_src,gas_mw,gas_src},
                                         easements:[{id,type,label,width_ft,setback_ft,approx,basis,
                                                     osm_way: <id> | geometry: LineString}], exclusions:[...], gaps:[...]}}
Output:
  private/site_constraints.json       same shape with easement geometry resolved (OSM ways clipped near the site) and sd.

  python3 site_constraints.py stage            # build the private output (public OSM / FEMA / USGS reads only)
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
    a = ap.parse_args(); sys.path.insert(0, HERE); {"stage": stage, "push": push}[a.cmd](a)
