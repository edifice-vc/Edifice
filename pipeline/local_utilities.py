"""Admin-only local utility lines (water, sewer, storm, electric, fiber, easements) for active deals.

LICENSING / HANDLING: city and county utility GIS is ADMIN-ONLY. Fetched geometry lives only in
pipeline/private (gitignored) and Firestore utilities/{dealId} (rules: admin read, client write false).
This repo is PUBLIC: never commit the source registry, fetched geometry, or deal pins. Tests use
synthetic shapes. Layers marked DO_NOT_USE (NPMS republications) are never queried, stored or drawn.

The source registry is pipeline/private/local_gis_sources.json (not in git). Each layer may set
`scale`: the raw diameter divided by scale when scale >= 1, or multiplied when 0 < scale < 1.
City of Salina stores SIZE in hundredths of an inch, so scale 100 turns 600 into 6 in.

  python3 local_utilities.py stage [--only ID ..] [--refresh]
      # active pinned deals from private/parcel_deals.json (python3 parcels.py deals)
      # queries each county's registry layers in a 2-mile bbox, clips to a 2-mile circle,
      # keeps type/size/material/owner, caches under pipeline/private/
  python3 local_utilities.py push [--apply] [--only ID ..]
      # utilities/{id} docs {j,h,src,fetched_at}; dry run without --apply.
      # Docs over 900 KB drop storm lines, then laterals, then the farthest remaining lines
      # (binary search; the kept set is the nearest lines that fit).
      # --apply commits in batches of at most ~8 MB of payload and 500 writes.
  python3 local_utilities.py discover [--county NAME]
      # stub: search ArcGIS Online for a county the registry lists as having no public source.
      # Prints candidates. Does not write the registry or fetch utility geometry.

Do not run push --apply from an agent. Sahil runs that, and the rules deploy, from the box.
"""
import argparse, datetime as dt, hashlib, json, os, re, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
PRIV = os.path.join(HERE, "private")
REGISTRY = os.path.join(PRIV, "local_gis_sources.json")
DEALS = os.path.join(PRIV, "parcel_deals.json")
OUT = os.path.join(PRIV, "utilities.json")
CACHE = os.path.join(PRIV, "utilities_cache")
RADIUS_M = 3218.69          # 2 miles
SIMPLIFY_M = 2.0
STALE_DAYS = 90
CAP = 900_000               # bytes of the stored j string
BATCH_BYTES = 8_000_000     # Firestore commit payload cap is 10 MB; stay under it
BATCH_WRITES = 500          # Firestore batch write limit
COLLECTION = "utilities"
MI = 1609.344
OWNER_DEFAULT = ["OWNER", "OWNERNAME", "Owner", "OwnerName", "UTILITY", "OPERATOR", "COMPANY"]
WIDTH_DEFAULT = ["WIDTH", "WIDTH_FT", "EASEMENT_WIDTH", "EaseWidth", "EASE_WIDTH"]

# ---------------------------------------------------------------- pure helpers (unit tested)
def norm_county(c):
    if not c: return None
    c = str(c).split(",")[0].replace(" County", "").strip()
    return c or None

def norm_size(raw, scale=None):
    """Diameter in inches. scale>=1 divides (Salina 600 / 100 = 6 in); 0<scale<1 multiplies.
    Strings may carry a unit (in, mm, ft). A bare number uses scale, defaulting to inches."""
    if raw is None or raw == "": return None
    if isinstance(raw, str):
        s = raw.strip().lower().replace('"', " in ").replace("inches", "in").replace("inch", "in")
        m = re.search(r"([0-9]*\.?[0-9]+)\s*(mm|in|ft|feet)?", s)
        if not m or not m.group(1): return None
        n = float(m.group(1)); u = m.group(2) or ""
        if u == "mm": return round(n / 25.4, 2)
        if u in ("ft", "feet"): return round(n * 12, 2)
        if u == "in" or scale in (None, "", 1, 1.0): return round(n, 2)
        raw = n
    try: n = float(raw)
    except (TypeError, ValueError): return None
    if scale in (None, "", 1, 1.0): return round(n, 2)
    try: sc = float(scale)
    except (TypeError, ValueError): return round(n, 2)
    if sc >= 1: return round(n / sc, 2)
    if sc > 0: return round(n * sc, 2)
    return round(n, 2)

def kind_of(typ, name):
    n = (name or "").lower().replace("-", " ").replace("_", " ")
    if typ == "storm" or "storm" in n: return "storm"
    if "lateral" in n or "service line" in n: return "lateral"
    if "force main" in n or re.search(r"\bforce\b|\bfm\b", n): return "force"
    return "main"

def strip_ft(feat):
    """No-build full width in feet for a mapped line that crosses the parcel.
    Water/sewer mains 20 ft, mains over 12 in 30 ft, force main and storm 20 ft, fiber 10 ft.
    Easements use the recorded width (None when the source has no width). Local electric and
    gas mains use 20 ft. Returns 0 when there is nothing to reserve."""
    t, k = feat.get("t"), feat.get("k") or "main"
    if t == "easement":
        try: w = float(feat.get("w"))
        except (TypeError, ValueError): return 0
        return w if w > 0 else 0
    if t == "fiber": return 10
    if t == "storm" or k == "force": return 20
    sz = feat.get("sz")
    try: sz = float(sz) if sz is not None and sz != "" else None
    except (TypeError, ValueError): sz = None
    if t in ("water", "sewer", "electric", "gas"): return 30 if sz is not None and sz > 12 else 20
    return 0

def marked_off(layer):
    """True when the registry says not to fetch this layer (NPMS republications)."""
    v = layer.get("DO_NOT_USE")
    return bool(v) and v not in (0, "0", "false", "False")

def banned_urls(reg):
    out = set()
    for x in (reg or {}).get("statewide") or []:
        if not marked_off(x): continue
        for u in str(x.get("url") or "").split(";"):
            u = u.strip()
            if u: out.add(u.rstrip("/"))
    return out

def layers_for(reg, county):
    """Usable line/polygon layers for one county. DO_NOT_USE layers are omitted."""
    c = norm_county(county)
    if not c or not reg: return []
    ban = banned_urls(reg)
    out = []
    for j in reg.get("jurisdictions") or []:
        counties = [norm_county(x) for x in (j.get("counties") or [])]
        if c not in counties: continue
        scale_j = j.get("scale", j.get("size_scale"))
        for L in j.get("layers") or []:
            if marked_off(L) or not L.get("url"): continue
            if L["url"].rstrip("/") in ban: continue
            if (L.get("geom") or "Polyline") not in ("Polyline", "Polygon", "LineString", "MultiLineString"): continue
            out.append({
                "type": L.get("type") or "other", "name": L.get("name") or "", "url": L["url"],
                "geom": L.get("geom") or "Polyline",
                "diameter_fields": L.get("diameter_fields") or [],
                "material_fields": L.get("material_fields") or [],
                "owner_fields": L.get("owner_fields") or OWNER_DEFAULT,
                "width_fields": L.get("width_fields") or (WIDTH_DEFAULT if L.get("type") == "easement" else []),
                "scale": L.get("scale", L.get("size_scale", scale_j)),
                "publisher": j.get("publisher") or "", "jurisdiction": j.get("jurisdiction") or "",
            })
    return out

def lacking_counties(reg):
    return [x.get("county") for x in (reg or {}).get("no_public_source") or [] if x.get("county")]

def discover_query(county):
    return (f'"{county} County" Kansas (water OR sewer OR storm OR utility) '
            'AND (type:"Feature Service" OR type:"Map Service")')

def clip_geom(geom, lat, lon, radius_m=RADIUS_M, simplify_m=SIMPLIFY_M):
    """Clip a GeoJSON geometry to a circle around the pin. Returns (geojson, meters_from_pin) or None."""
    import parcels as P
    from shapely.geometry import Point
    from shapely.ops import unary_union
    try: g = P.to_m(geom, lat, lon)
    except Exception: return None
    if g.is_empty: return None
    if not g.is_valid: g = g.buffer(0)
    circ = Point(0, 0).buffer(radius_m, resolution=16)
    if not g.intersects(circ): return None
    h = g.intersection(circ)
    if h.is_empty: return None
    keep = ("LineString", "MultiLineString", "Polygon", "MultiPolygon")
    def pieces(x, acc):
        if x.is_empty: return
        if x.geom_type in keep: acc.append(x)
        elif x.geom_type == "GeometryCollection":
            for p in x.geoms: pieces(p, acc)
    acc = []; pieces(h, acc)
    if not acc: return None
    u = unary_union(acc)
    acc = []; pieces(u, acc)
    if not acc: return None
    u = acc[0] if len(acc) == 1 else unary_union(acc)
    if u.geom_type not in keep: u = acc[0]
    u = u.simplify(simplify_m, preserve_topology=True)
    if u.is_empty or u.geom_type not in keep: return None
    return P.to_ll(u, lat, lon), float(u.distance(Point(0, 0)))

def line_of(feat, layer, lat, lon, radius_m=RADIUS_M):
    """One registry feature -> stored line, or None. Only type/size/material/owner (plus width, publisher)."""
    import parcels as P
    g = feat.get("geometry")
    if not g: return None
    clipped = clip_geom(g, lat, lon, radius_m)
    if not clipped: return None
    geom, dist = clipped
    props = feat.get("properties") or {}
    sz = norm_size(P.pick(props, layer.get("diameter_fields")), layer.get("scale"))
    mat = P.pick(props, layer.get("material_fields"))
    ow = P.pick(props, layer.get("owner_fields"))
    w = None
    raw_w = P.pick(props, layer.get("width_fields"))
    if raw_w is not None:
        try: w = round(float(raw_w), 1)
        except (TypeError, ValueError): w = None
    t = layer.get("type") or "other"
    return {"t": t, "k": kind_of(t, layer.get("name")), "sz": sz,
            "mat": None if mat is None else str(mat)[:80], "ow": None if ow is None else str(ow)[:80],
            "w": w, "pub": layer.get("publisher") or "", "nm": (layer.get("name") or "")[:80],
            "mi": round(dist / MI, 3), "g": geom}

def record_j(rec):
    body = {"src": rec.get("src") or "local-gis", "county": rec.get("county"),
            "radius_m": rec.get("radius_m") or RADIUS_M, "lines": rec.get("lines") or []}
    return json.dumps(body, separators=(",", ":"))

def shrink(lines, cap, measure):
    """Drop storm, then laterals, then the farthest remaining lines, until measure(lines) <= cap.

    The farthest cut is a binary search over how many of the nearest lines to keep.
    Each probe encodes the candidate once, so a dense deal is log(n) encodings, not one per dropped line.
    """
    lines = list(lines or [])
    storm = lambda f: f.get("t") == "storm" or f.get("k") == "storm"
    lateral = lambda f: f.get("k") == "lateral"
    if measure(lines) <= cap: return lines
    lines = [f for f in lines if not storm(f)]
    if measure(lines) <= cap: return lines
    lines = [f for f in lines if not lateral(f)]
    if measure(lines) <= cap: return lines
    lines.sort(key=lambda f: (f.get("mi") or 0, f.get("nm") or ""))   # nearest first; a prefix is what we keep
    lo, hi, best = 0, len(lines), []
    while lo <= hi:
        mid = (lo + hi) // 2
        chunk = lines[:mid]
        if measure(chunk) <= cap:
            best = chunk
            lo = mid + 1
        else:
            hi = mid - 1
    return best

def fit(rec, cap=CAP):
    """Return rec with lines trimmed so the stored j string is at most cap bytes."""
    def measure(ls): return len(record_j(dict(rec, lines=ls)))
    out = dict(rec)
    out["lines"] = shrink(rec.get("lines") or [], cap, measure)
    return out

def payload_bytes(item):
    """Bytes of one utilities doc. item is (id, j, h, rec). j is almost the whole payload."""
    _s, j, h, r = item
    return len(j) + len(h or "") + len(str((r or {}).get("src") or "")) + len(str((r or {}).get("fetched_at") or "")) + 64

def batches(plan, max_bytes=BATCH_BYTES, max_writes=BATCH_WRITES):
    """Split a push plan so each Firestore commit stays under max_bytes and max_writes.
    A single doc larger than max_bytes is its own batch (push already skips docs over the 900 KB cap)."""
    groups, cur, size = [], [], 0
    for item in plan or []:
        n = payload_bytes(item)
        if cur and (size + n > max_bytes or len(cur) >= max_writes):
            groups.append(cur)
            cur, size = [], 0
        cur.append(item)
        size += n
    if cur: groups.append(cur)
    return groups

def doc_of(rec):
    j = record_j(rec)
    return j, hashlib.sha1(j.encode()).hexdigest()[:20]

def crosses(parcel_ll, geom_ll):
    """True when a utility geometry intersects a parcel polygon (lon/lat)."""
    import parcels as P
    try:
        # local metres about the parcel's first coordinate, so the test is in a flat frame
        c = parcel_ll["coordinates"][0][0] if parcel_ll.get("type") == "Polygon" else parcel_ll["coordinates"][0][0][0]
        lon, lat = c[0], c[1]
        a, b = P.to_m(parcel_ll, lat, lon), P.to_m(geom_ll, lat, lon)
        return a.intersects(b)
    except Exception:
        return False

def strips(parcel_ll, lines):
    """Mapped lines and easements that cross the parcel, with the no-build width and the survey label."""
    out = []
    for f in lines or []:
        g = f.get("g")
        if not g or not parcel_ll or not crosses(parcel_ll, g): continue
        w = strip_ft(f)
        if not w: continue
        out.append({"t": f.get("t"), "k": f.get("k"), "sz": f.get("sz"), "w": f.get("w"),
                    "strip_ft": w, "label": "public GIS, verify with survey", "g": g})
    return out


# ---------------------------------------------------------------- network + CLI
def _load_reg():
    if not os.path.exists(REGISTRY):
        sys.exit(f"[utilities] no registry at {REGISTRY} (gitignored; not in this repo)")
    return json.load(open(REGISTRY))

def _query(url, lat, lon, radius_m):
    import parcels as P, requests
    dx, dy = radius_m / P._kx(lat), radius_m / P.KY
    feats, offset = [], 0
    for _ in range(6):
        p = {"f": "geojson", "outFields": "*", "returnGeometry": "true", "outSR": 4326, "inSR": 4326,
             "geometry": f"{lon-dx},{lat-dy},{lon+dx},{lat+dy}", "geometryType": "esriGeometryEnvelope",
             "spatialRel": "esriSpatialRelIntersects"}
        if "/FeatureServer/" in url:
            p["resultOffset"] = offset; p["resultRecordCount"] = 2000
        err = None
        for i in range(3):
            try:
                r = requests.get(url.rstrip("/") + "/query", params=p, timeout=60)
                j = r.json()
                if "error" in j: raise RuntimeError(str(j["error"])[:200])
                break
            except Exception as e:
                err = e; time.sleep(1 + 2 * i); j = None
        if j is None: raise err
        batch = j.get("features") or []
        feats.extend(batch)
        exceeded = j.get("exceededTransferLimit") or (j.get("properties") or {}).get("exceededTransferLimit")
        if not exceeded or "/FeatureServer/" not in url or not batch: break
        offset += len(batch)
    return feats

def _one(reg, d, prev, refresh):
    lat, lon = d.get("lat"), d.get("lon")
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return {"src": "none", "why": "no pin", "lines": [], "fetched_at": dt.date.today().isoformat()}
    if prev and not refresh and not _stale(prev) and prev.get("src") != "none": return prev
    import parcels as P
    cty = None
    try: cty = P.county_of(lat, lon)
    except Exception: cty = None
    cty = cty or P.norm_county(d.get("county") or d.get("pin_county"))
    layers = layers_for(reg, cty)
    lines, why = [], []
    if not layers: why.append(f"no local utility layers for {cty}")
    for L in layers:
        try: feats = _query(L["url"], lat, lon, RADIUS_M)
        except Exception as e:
            why.append(f"{L['name']}: {e}"[:140]); continue
        for f in feats:
            row = line_of(f, L, lat, lon, RADIUS_M)
            if row: lines.append(row)
    rec = {"src": "local-gis" if lines else "none", "county": cty, "radius_m": RADIUS_M, "lines": lines,
           "n": len(lines), "why": "; ".join(why), "fetched_at": dt.date.today().isoformat(),
           "name": d.get("name"), "restricted": d.get("col") == "rsites"}
    return fit(rec)

def _stale(rec, days=STALE_DAYS):
    try: return (dt.date.today() - dt.date.fromisoformat(str(rec.get("fetched_at") or "")[:10])).days > days
    except Exception: return True

def stage(a):
    if not os.path.exists(DEALS):
        sys.exit("[utilities] no private/parcel_deals.json — run: python3 parcels.py deals")
    reg = _load_reg()
    deals = json.load(open(DEALS)); old = json.load(open(OUT)) if os.path.exists(OUT) else {}
    os.makedirs(CACHE, exist_ok=True); out = {}
    only = set(a.only or [])
    for sid, d in sorted(deals.items()):
        if only and sid not in only:
            if old.get(sid): out[sid] = old[sid]
            continue
        if d.get("stage") == "Passed": continue
        cache = os.path.join(CACHE, sid + ".json")
        prev = json.load(open(cache)) if os.path.exists(cache) else old.get(sid)
        rec = _one(reg, d, prev, a.refresh)
        json.dump(rec, open(cache, "w"), separators=(",", ":"))
        out[sid] = rec
        print(f"[utilities] {sid} {rec.get('county') or '?'}: {rec['src']} n={len(rec.get('lines') or [])} {rec.get('why') or ''}")
    json.dump(out, open(OUT, "w"), separators=(",", ":"))
    print(f"[utilities] {sum(1 for v in out.values() if v.get('lines'))} deals with lines, {len(out)} cached")

def push(a):
    import edks
    if not os.path.exists(OUT): sys.exit("[utilities] nothing staged — run stage first")
    data = json.load(open(OUT)); client = edks.db(); plan = []
    only = set(getattr(a, "only", None) or [])
    ids = [s for s, r in data.items() if r.get("src") != "none" and (not only or s in only)]
    refs = [client.collection(COLLECTION).document(s) for s in ids]; have = {}
    for k in range(0, len(refs), 100):
        for s in client.get_all(refs[k:k + 100]):
            have[s.id] = (s.to_dict() or {}).get("h") if s.exists else None
    for s in ids:
        rec = fit(data[s])
        j, h = doc_of(rec)
        if have.get(s) == h: continue
        if len(j) > CAP:
            print(f"[utilities] {s}: still {len(j)//1024} KB after dropping storm and laterals, skipped"); continue
        plan.append((s, j, h, rec))
    print(f"[utilities] {len(ids)} reads, {len(plan)} writes planned to {COLLECTION}/ ({sum(len(p[1]) for p in plan)//1024} KB)")
    groups = batches(plan)
    print(f"[utilities] {len(groups)} batches, largest {max((sum(payload_bytes(i) for i in g) for g in groups), default=0)//1024} KB")
    if not a.apply: print("[utilities] dry run; pass --apply to write"); return
    for group in groups:
        b = client.batch()
        for s, j, h, r in group:
            b.set(client.collection(COLLECTION).document(s), {"j": j, "h": h, "src": r.get("src") or "local-gis", "fetched_at": r.get("fetched_at")})
        b.commit()
    print(f"[utilities] wrote {len(plan)} docs")

def discover(a):
    """Search ArcGIS Online. Prints candidates only; does not edit the registry or download lines."""
    reg = _load_reg()
    county = a.county or (lacking_counties(reg) or [None])[0]
    if not county:
        print("[utilities] every listed county has a source"); return
    q = discover_query(county)
    print(f"[utilities] discover {county}\n  {q}")
    try:
        import requests
        r = requests.get("https://www.arcgis.com/sharing/rest/search",
                         params={"f": "json", "q": q, "num": 8, "sortField": "numviews", "sortOrder": "desc"}, timeout=40)
        items = r.json().get("results") or []
    except Exception as e:
        print(f"[utilities] search failed: {e}"); return
    ban = banned_urls(reg)
    for it in items:
        url = (it.get("url") or "").rstrip("/")
        title = it.get("title") or ""
        if marked_off(it) or "npms" in title.lower() or "npms" in url.lower() or url in ban:
            print(f"  skip DO_NOT_USE {title}"); continue
        print(f"  {title}  {url}")
    if not items: print("  (no ArcGIS Online items)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); sp = ap.add_subparsers(dest="cmd", required=True)
    s = sp.add_parser("stage"); s.add_argument("--only", nargs="*"); s.add_argument("--refresh", action="store_true")
    p = sp.add_parser("push"); p.add_argument("--apply", action="store_true"); p.add_argument("--only", nargs="*")
    d = sp.add_parser("discover"); d.add_argument("--county")
    a = ap.parse_args(); sys.path.insert(0, HERE); {"stage": stage, "push": push, "discover": discover}[a.cmd](a)
