#!/usr/bin/env python3
"""Site data phase 1: FEMA flood, USGS 3DEP slope and county parcels per deal -> compact static layers.

Scope (Sahil, 2026-11-01): deals with site score > 65, any stage except Passed (merged/deleted skipped).
Site shape = floodplain.site_shape(rec): the site polygon when on file, else a circle of the listed acres
(20-2,000 ac; 40 ac when unknown) around the pin.

Outputs (no Firestore writes; read-only Firestore access to list deals):
  pipeline/private/sitedata.json   (gitignored build artifact) per-site flood %, slope stats, buildable acres + simplified
                                   flood/steep/buildable polygons (FEMA & USGS public data only).
                                   Deal locations are confidential, so this is NOT put in the public web root;
                                   ship it inside the gated data the app already loads after sign-in (pending
                                   Sahil's approval). Admin-only deals (rsites) go only to the private file.
  pipeline/private/sitedata_private.json   (gitignored) parcel ids/geometry + admin-only deals; ship via the
                                   encrypted/admin path once approved.

  python3 site_data.py build [--deals /tmp/deals.json] [--min-score 65]
"""
import argparse, json, math, os, sys, time, datetime as dt, io
from concurrent.futures import ThreadPoolExecutor
import numpy as np, requests
from shapely.geometry import shape, mapping, box, Point
import warnings; warnings.filterwarnings('ignore', category=DeprecationWarning)
from shapely.ops import unary_union, transform
import floodplain as fp

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(HERE, "private", "sitedata.json")   # gated: deal ids + site shapes reveal deal locations
PRIV = os.path.join(HERE, "private", "sitedata_private.json")
UA = fp.UA
NFHL = fp.NFHL
DEP = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer"
COUNTY = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1"
# county parcel services that answer public point queries (checked 2026-11-01). Others: see GAPS.
PARCELS = {
    "statewide": ("https://services.kansasgis.org/arcgis4/rest/services/KS_Parcels_ORKA_EB/MapServer/0", "KSPID",
                  "Kansas ORKA statewide parcels (DASC/KDOR; currently only 4 counties populated)"),
    "Sedgwick": ("https://gismaps.sedgwickcounty.org/arcgis/rest/services/Map/Op_Parcel_Dynamic_SP/MapServer/0", "PIN",
                 "Sedgwick County tax parcels"),
}
GAPS = {  # county -> what it takes to get parcels
    "Johnson": "AIMS property service is subscription (CUE/JCLR); free shapefile via AIMS Free Data request",
    "_default": "no public parcel REST service found; request parcel shapefile from county appraiser/GIS (often a fee) or ORKA",
}
SLOPE_STEEP, SLOPE_MOD = 15.0, 5.0
CELL_M = 3.0          # requested DEM cell (3DEP serves best available: 1 m lidar resampled)
MAXPX = 1600

def _get(url, params, timeout=40, tries=3, raw=False):
    err = None
    for i in range(tries):
        try:
            r = requests.get(url, params=params, timeout=timeout, headers=UA); r.raise_for_status()
            if raw: return r.content
            d = r.json()
            if "error" in d: raise RuntimeError(str(d["error"])[:150])
            return d
        except Exception as e:
            err = e; time.sleep(2 * (i + 1))
    raise RuntimeError(f"{type(err).__name__}: {str(err)[:150]}")

def ll(m): return transform(fp._TO_LL, m)
def mm(g): return transform(fp._TO_M, g)

# ------------------------------------------------------------- flood (zone + floodway)
def flood(m):
    x0, y0, x1, y1 = ll(m.envelope.buffer(30)).bounds
    feats, off = [], 0
    while True:
        d = _get(NFHL + "/query", {"geometry": f"{x0},{y0},{x1},{y1}", "geometryType": "esriGeometryEnvelope", "inSR": 4326,
                 "spatialRel": "esriSpatialRelIntersects", "where": "SFHA_TF='T' OR ZONE_SUBTY LIKE '%FLOODWAY%' OR ZONE_SUBTY LIKE '%0.2%'",
                 "outFields": "FLD_ZONE,ZONE_SUBTY", "outSR": 4326, "returnGeometry": "true", "geometryPrecision": 6,
                 "f": "geojson", "resultOffset": off, "resultRecordCount": 750})
        fs = d.get("features") or []; feats += fs
        if not (d.get("exceededTransferLimit") or (d.get("properties") or {}).get("exceededTransferLimit")) or not fs: break
        off += len(fs)
    sfha, fway, x500, zones = [], [], [], set()
    for f in feats:
        try: g = mm(shape(f["geometry"]).buffer(0)).intersection(m)
        except Exception: continue
        if g.is_empty: continue
        p = f.get("properties") or {}; sub = (p.get("ZONE_SUBTY") or "").upper(); z = p.get("FLD_ZONE") or "?"
        if "FLOODWAY" in sub: fway.append(g); zones.add("AE floodway")
        elif z.startswith("A") or z.startswith("V"): sfha.append(g); zones.add(z)
        elif "0.2" in sub: x500.append(g); zones.add("X (0.2%)")
    U = lambda L: unary_union(L) if L else None
    return {"sfha": U(sfha + fway), "floodway": U(fway), "x500": U(x500), "zones": sorted(zones)}

# ------------------------------------------------------------- elevation / slope
def dem(m):
    x0, y0, x1, y1 = m.envelope.buffer(10).bounds
    cell = max(CELL_M, (x1 - x0) / MAXPX, (y1 - y0) / MAXPX)
    w, h = int(math.ceil((x1 - x0) / cell)), int(math.ceil((y1 - y0) / cell))
    import tifffile
    b = _get(DEP + "/exportImage", {"bbox": f"{x0},{y0},{x1},{y1}", "bboxSR": 5070, "imageSR": 5070, "size": f"{w},{h}",
             "format": "tiff", "pixelType": "F32", "noData": -9999, "interpolation": "RSP_BilinearInterpolation", "f": "image"},
             timeout=90, raw=True)
    z = tifffile.imread(io.BytesIO(b)).astype("float64")
    if z.ndim > 2: z = z[..., 0]
    z[z < -1000] = np.nan
    return z, (x0, y1), cell

def slope_stats(m):
    z, (ox, oy), c = dem(m)
    gy, gx = np.gradient(z, c)
    s = np.hypot(gx, gy) * 100.0
    h, w = z.shape
    xs = ox + (np.arange(w) + .5) * c; ys = oy - (np.arange(h) + .5) * c
    X, Y = np.meshgrid(xs, ys)
    from shapely import contains_xy
    inside = contains_xy(m, X, Y) & ~np.isnan(z) & ~np.isnan(s)
    if inside.sum() < 50: raise RuntimeError("DEM empty")
    zi, si = z[inside], s[inside]
    # rough cut/fill: level the site to its best-fit plane; half the absolute residual volume ~ cut (= fill)
    A = np.c_[X[inside], Y[inside], np.ones(inside.sum())]
    coef, *_ = np.linalg.lstsq(A, zi, rcond=None); res = zi - A @ coef
    cutfill = float(np.abs(res).sum() * c * c / 2)
    # steep polygon: 30 m blocks where most cells are >15 %
    k = max(1, int(round(30 / c))); steep = []
    for i in range(0, h, k):
        for j in range(0, w, k):
            blk = inside[i:i+k, j:j+k]
            if blk.sum() and (s[i:i+k, j:j+k][blk] > SLOPE_STEEP).mean() > .5:
                steep.append(box(ox + j*c, oy - (i+k)*c, ox + (j+k)*c, oy - i*c))
    sg = unary_union(steep).intersection(m) if steep else None
    return {"elev_min_ft": round(float(np.nanmin(zi)) * 3.28084, 1), "elev_max_ft": round(float(np.nanmax(zi)) * 3.28084, 1),
            "elev_mean_ft": round(float(np.nanmean(zi)) * 3.28084, 1), "relief_ft": round(float(np.ptp(zi)) * 3.28084, 1),
            "slope_mean_pct": round(float(si.mean()), 2), "slope_p90_pct": round(float(np.percentile(si, 90)), 2),
            "pct_gt5": round(float((si > SLOPE_MOD).mean() * 100), 1), "pct_gt15": round(float((si > SLOPE_STEEP).mean() * 100), 1),
            "cutfill_cy": int(cutfill * 1.30795), "cutfill_cy_per_ac": int(cutfill * 1.30795 / (m.area / fp.AC_M2)),
            "dem_cell_m": round(c, 1)}, sg

# ------------------------------------------------------------- county + parcels
def county_at(lat, lon):
    d = _get(COUNTY + "/query", {"geometry": f"{lon},{lat}", "geometryType": "esriGeometryPoint", "inSR": 4326,
             "outFields": "NAME", "returnGeometry": "false", "f": "json"})
    fs = d.get("features") or []
    return fs[0]["attributes"]["NAME"].replace(" County", "") if fs else None

def parcels(m, county):
    for key in ("statewide", county):
        if key not in PARCELS: continue
        url, idf, src = PARCELS[key]
        x0, y0, x1, y1 = ll(m).bounds
        d = _get(url + "/query", {"geometry": f"{x0},{y0},{x1},{y1}", "geometryType": "esriGeometryEnvelope", "inSR": 4326,
                 "spatialRel": "esriSpatialRelIntersects", "outFields": idf, "outSR": 4326, "returnGeometry": "true",
                 "geometryPrecision": 6, "f": "geojson", "resultRecordCount": 1000})
        fs = [f for f in d.get("features") or [] if f.get("geometry")]
        if fs:
            return {"source": src, "url": url, "n": len(fs),
                    "features": [{"type": "Feature", "properties": {"id": (f.get("properties") or {}).get(idf)},
                                  "geometry": f["geometry"]} for f in fs]}
    return None

# ------------------------------------------------------------- per site
def gj(g, tol=4.0):
    if g is None or g.is_empty: return None
    import shapely
    g = g.simplify(tol)
    if g.is_empty or g.area < 400: return None
    return mapping(shapely.set_precision(ll(g), 1e-5))

def one(rec):
    out = {"id": rec["id"], "name": rec.get("name"), "view": rec.get("view"), "score": rec.get("score"), "stage": rec.get("stage"),
           "listed_county": (rec.get("county") or "").replace(", KS", "").strip() or None, "errors": []}
    m, method = fp.site_shape(rec)
    try: acr = float(rec.get("acres") or 0)
    except Exception: acr = 0
    if not rec.get("site_geojson") and 0.5 <= acr < 20 and rec.get("lat") is not None:  # small (storage) sites: true acreage
        m = Point(*fp._TO_M(rec["lon"], rec["lat"])).buffer(math.sqrt(acr * fp.AC_M2 / math.pi), 32)
        method = f"circle of {acr:g} ac around the pin (no site polygon)"
    if m is None: out["errors"].append(method); return out, None
    ac = m.area / fp.AC_M2; out["site_method"] = method; out["site_ac"] = round(ac, 1)
    try: out["pin_county"] = county_at(rec["lat"], rec["lon"])
    except Exception as e: out["errors"].append(f"county: {e}")
    try:
        F = flood(m)
        out["flood"] = {"sfha_pct": round((F["sfha"].area if F["sfha"] else 0) / m.area * 100, 1),
                        "floodway_pct": round((F["floodway"].area if F["floodway"] else 0) / m.area * 100, 1),
                        "x500_pct": round((F["x500"].area if F["x500"] else 0) / m.area * 100, 1), "zones": F["zones"]}
    except Exception as e: F = None; out["errors"].append(f"flood: {e}")
    try: S, steep = slope_stats(m); out["slope"] = S
    except Exception as e: steep = None; out["errors"].append(f"dem: {e}")
    excl = unary_union([g for g in ((F or {}).get("sfha"), steep) if g is not None and not g.is_empty]) if (F or steep) else None
    bld = m.difference(excl) if excl is not None and not excl.is_empty else m
    out["buildable_ac"] = round(bld.area / fp.AC_M2, 1); out["buildable_pct"] = round(bld.area / m.area * 100, 1)
    fl = []
    fz = (out.get("flood") or {})
    if fz.get("floodway_pct", 0) > 0: fl.append(f"floodway on {fz['floodway_pct']}% of site")
    if fz.get("sfha_pct", 0) >= 5: fl.append(f"100-yr floodplain on {fz['sfha_pct']}% of site")
    sl = out.get("slope") or {}
    if sl.get("pct_gt15", 0) >= 5: fl.append(f"{sl['pct_gt15']}% of site steeper than 15%")
    if sl.get("pct_gt5", 0) >= 40: fl.append(f"{sl['pct_gt5']}% of site steeper than 5% (heavy grading)")
    if out.get("pin_county") and out["listed_county"] and out["pin_county"].lower() != out["listed_county"].lower():
        fl.append(f"pin is in {out['pin_county']} Co but listing says {out['listed_county']} Co")
    out["flags"] = fl
    out["geo"] = {"site": gj(m), "sfha": gj((F or {}).get("sfha")), "floodway": gj((F or {}).get("floodway")),
                  "steep": gj(steep, 5), "buildable": gj(bld)}
    priv = None
    try:
        P = parcels(m, out.get("pin_county"))
        out["parcels"] = {"found": bool(P), "n": P["n"] if P else 0, "source": P["source"] if P else
                          GAPS.get(out.get("pin_county") or "", GAPS["_default"])}
        if P: priv = {"id": rec["id"], **P}
    except Exception as e:
        out["parcels"] = {"found": False, "n": 0, "source": f"error {e}"}
    return out, priv

def build(a):
    recs = [r for r in json.load(open(a.deals)) if (r.get("score") or 0) > a.min_score and r.get("stage") != "Passed"]
    print(f"[site_data] {len(recs)} deals (score > {a.min_score}, not Passed)")
    with ThreadPoolExecutor(4) as ex: res = list(ex.map(lambda r: (r, *one(r)), recs))
    pub, priv = [], {"parcels": [], "restricted": []}
    for r, o, p in res:
        if p: priv["parcels"].append(p)
        (priv["restricted"] if r.get("col") == "rsites" else pub).append(o)
        print(f"  {o['name'][:40]:40} flood {(o.get('flood') or {}).get('sfha_pct')}%  >15% {(o.get('slope') or {}).get('pct_gt15')}  parcel {o.get('parcels',{}).get('found')}  {'; '.join(o.get('errors', []))[:80]}")
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    meta = {"generated": stamp, "scope": f"site score > {a.min_score}, not Passed",
            "sources": {"flood": {"name": "FEMA National Flood Hazard Layer, layer 28", "url": NFHL},
                        "elevation": {"name": "USGS 3DEP bare-earth DEM (best available; 1 m lidar in most of Kansas)", "url": DEP},
                        "county": {"name": "Census TIGERweb counties", "url": COUNTY}},
            "rules": {"buildable": "site minus 100-yr floodplain (incl. floodway) minus 30 m blocks mostly >15% slope",
                      "flags": "floodway any; SFHA >=5%; >15% slope on >=5%; >5% slope on >=40%; pin county != listed county"}}
    os.makedirs(os.path.dirname(PRIV), exist_ok=True)
    json.dump({"meta": meta, "sites": {o["id"]: o for o in pub}}, open(PUB, "w"), separators=(",", ":"))
    json.dump({"meta": meta, **priv}, open(PRIV, "w"), separators=(",", ":"))
    print(f"[site_data] wrote {PUB} ({os.path.getsize(PUB)//1024} KB), private {os.path.getsize(PRIV)//1024} KB")

def push(a):
    """Upload pipeline/private/sitedata.json as the gated meta blob 'sitedata' (chunked, change-hash skip).
    Dry-run unless --apply. Needs Sahil's approval before --apply (production write)."""
    import edks
    text = open(PUB).read()
    client = edks.db(); writes = []
    old = client.collection("meta").document("sitedata").get()
    if old.exists and (old.to_dict() or {}).get("h") == edks._h(text):
        print("[site_data] unchanged: 1 read, 0 writes"); return
    edks._put_blob(client, "sitedata", text, writes)
    print(f"[site_data] {len(writes)} writes planned ({len(text)//1024} KB)")
    if a.apply: edks._commit(client, writes); print("[site_data] pushed")
    else: print("[site_data] dry run; pass --apply to write")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); sp = ap.add_subparsers(dest="cmd", required=True)
    b = sp.add_parser("build"); b.add_argument("--deals", default="/tmp/deals.json"); b.add_argument("--min-score", type=float, default=65)
    pu = sp.add_parser("push"); pu.add_argument("--apply", action="store_true")
    a = ap.parse_args(); (build if a.cmd == "build" else push)(a)
