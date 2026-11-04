"""Admin-only parcel boundaries for active pipeline deals (every stage except Passed): the deal's own parcel plus
its neighbours within NEIGHBOR_M (1/4 mile) of the deal parcel, shown on the map only when zoomed in.

LICENSING / HANDLING: county parcel data and Zoneomics data are ADMIN-ONLY. Fetched geometry, owners and APNs live only in
pipeline/private (gitignored) and Firestore parcels/{dealId} (rules: admin read, client write false). This repo is
PUBLIC: never commit fetched geometry; tests use synthetic shapes. Zoneomics: no redistribution.

Sources, in order (each behind a small adapter so one can be swapped or retired):
  1. CountyArcGIS  free public county ArcGIS REST parcel layers (deal parcel + neighbours from one envelope query)
  2. ZoneomicsV2   zoneDetail output_fields=parcels,geom: deal parcel only, 1 call per deal, cached (v2 will be retired)
  3. none          recorded as uncovered

  python3 parcels.py deals                 # active deals + pins -> private/parcel_deals.json
  python3 parcels.py stage [--only ID ..] [--refresh] [--no-zoneomics]   # fetch into private/parcels.json (cached)
  python3 parcels.py push [--apply]       # parcels/{id} docs {j,h,src,fetched_at,restricted,by,ts}; dry run without --apply
Production write: needs Sahil's explicit approval before --apply (given 2026-11-04, t279u).
"""
import argparse, datetime as dt, hashlib, json, math, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
PRIV = os.path.join(HERE, "private")
DEALS = os.path.join(PRIV, "parcel_deals.json")
OUT = os.path.join(PRIV, "parcels.json")
ZCACHE = os.path.join(PRIV, "parcel_cache")
NEIGHBOR_M = 402          # 1/4 mile around the deal parcel
MAX_NEIGHBORS = 150       # nearest kept (city blocks can return hundreds)
SIMPLIFY_M = 1.5
STALE_DAYS = 90
COLLECTION = "parcels"

# county -> layer url + field names (first non-empty wins). Verified 2026-11-04: each returns polygons; owner where listed.
COUNTY = {
    "McPherson": {"url": "https://services8.arcgis.com/5ehLV5DLlzhyV3k5/arcgis/rest/services/Ownership_Online_Map/FeatureServer/1",
                  "apn": ["ParcelNum", "KSPID"], "owner": ["owner", "PrimaryOwn"], "acres": ["Acres", "Area_Acres"]},
    "Butler": {"url": "https://ww1.bucoks.com/bucogis1/rest/services/BuCoKsGIS_ParcelBoundaries_NC/MapServer/0",   # ParcelData_NC returns no geometry
               "apn": ["PID", "PARCELNUM"], "owner": [], "acres": ["ACRES"]},
    "Lyon": {"url": "https://services8.arcgis.com/dw5aksXsLRAhbdxH/arcgis/rest/services/Lyon_County_Parcels/FeatureServer/0",
             "apn": ["FULL_PID", "PARCELNUM", "PID"], "owner": [], "acres": ["ACRES"]},
    "Franklin": {"url": "https://services1.arcgis.com/Cdr6tOjJ99MjOR6x/arcgis/rest/services/Appraiser_Parcel_Search_WFL1/FeatureServer/4",
                 "apn": ["PropertyNumber", "PARCEL_CAM", "PropertyNu"], "owner": [], "acres": []},
    "Shawnee": {"url": "https://services2.arcgis.com/2XE514jeVQMWNKHX/arcgis/rest/services/Parcels/FeatureServer/0",
                "apn": ["PIN", "QUICKREFID"], "owner": [], "acres": ["ACRES"]},
    "Montgomery": {"url": "https://services8.arcgis.com/NlV1tPHJ1eShmjwO/arcgis/rest/services/MontgomeryCountyKS_BeaconUpdated/FeatureServer/2",
                   "apn": ["ParcelID", "KSPID"], "owner": ["OwnerName"], "acres": ["GIS_Acres", "Def_Acres"]},
    "Saline": {"url": "https://services2.arcgis.com/cuBVqVP04yYSBGZ9/arcgis/rest/services/Parcels_1/FeatureServer/0",   # Saline County (sacoks) county-wide; replaces City of Salina geometry-only layer
               "apn": ["Name", "PARCNUM", "PID"], "owner": ["OWNERNAME"], "acres": ["CLACRE", "Calc_Acre"]},
    "Sedgwick": {"url": "https://services7.arcgis.com/McLat6HlPl45bNBv/arcgis/rest/services/Sedgwick_County_Land_Records/FeatureServer/4",
                 "apn": ["PIN", "AIN", "GEOCODE"], "owner": [], "acres": ["ParcAcresC"]},
    "Finney": {"url": "https://utility.arcgis.com/usrsvcs/servers/9e3691d1d0e64182aa19dac298b6c7f8/rest/services/FinneyCountyAppraisers/Parcels/MapServer/0",
               "apn": ["PARCELNUM", "ParcelID", "PID"], "owner": ["PartyName"], "acres": ["ACRES"]},
    "Labette": {"url": "https://services9.arcgis.com/zDY8zW24CdJKhVIw/arcgis/rest/services/LabetteCountyGIS/FeatureServer/2",
                "apn": ["Full_Pin", "PIDNO", "CAMANUM"], "owner": ["OwnerName", "PartyName"], "acres": ["ACRES", "Calc_Acres"]},
    "Douglas": {"url": "https://services.arcgis.com/8O9UlSTnqjKptoda/arcgis/rest/services/Parcel/FeatureServer/0",
                "apn": ["PARCELNUMBER", "PID"], "owner": ["owner1"], "acres": ["SYSCALACRES"]},
    "Ford": {"url": "https://services7.arcgis.com/QfD34vvHtHcH5kGh/arcgis/rest/services/FOCO_Parcel_Mosaic/FeatureServer/0",   # public AGOL mosaic 2025-08-28
             "apn": ["ParcelID", "QuickRefID"], "owner": ["OWNER"], "acres": ["Acres"]},
    "Cloud": {"url": "https://services9.arcgis.com/yGerJCngvNpaN2km/arcgis/rest/services/CloudCoKS_ParcelsOpenRecords/FeatureServer/0",   # county open-records layer, verified 2026-11-04
              "apn": ["PropertyNu", "PID", "QuickRefID"], "owner": ["PartyName", "PrimaryOwn"], "acres": ["ACRES", "LegalAcres"]},
    "Wyandotte": {"url": "https://gisweb.wycokck.org/arcgis/rest/services/GISPUB/Parcel_Polygons/FeatureServer/0",   # Unified Government GISPUB, geometry + parcel no. only
                  "apn": ["PARCEL", "PARCEL_NBR"], "owner": [], "acres": ["ACRE"]},
    "Geary": {"url": "https://services6.arcgis.com/FV7KF2rCsQjt0P3e/arcgis/rest/services/GeCo_Parcel_Ownership/FeatureServer/0",   # Geary County (gecoks) AGOL
              "apn": ["PIN19", "PIN", "QuickRefID"], "owner": ["OWNERNAME"], "acres": ["Acreage", "TOTACRES"]},
    "Leavenworth": {"url": "https://services9.arcgis.com/YvdlPN5z971EmeG3/arcgis/rest/services/Parcel_Boundaries/FeatureServer/0",   # Leavenworth County (lvcoks)
                    "apn": ["FULL_PID", "PID"], "owner": ["OwnerName"], "acres": ["ACRES"]},
    "Cowley": {"url": "https://services2.arcgis.com/duYcbdxVVOdnGdbq/arcgis/rest/services/Parcels/FeatureServer/0",   # Cowley KSPIDs 018-
               "apn": ["KSPID", "PIN"], "owner": ["OwnerName", "PartyName"], "acres": ["AREA_ACRES", "Acreage"]},
    "Linn": {"url": "https://services3.arcgis.com/TKhOZbXZBgxGSTZN/arcgis/rest/services/Secure_Ownership_WFL1/FeatureServer/0",   # Linn County KS ownership
             "apn": ["PARCEL_CAM", "PropertyNu"], "owner": ["PartyName"], "acres": ["Acres"]},
    "Sumner": {"url": "https://services6.arcgis.com/1T9VnnU2vFIMRmpS/arcgis/rest/services/SU_Parcels/FeatureServer/0",
               "apn": ["PARCELNUM", "PID"], "owner": [], "acres": ["GIS_Acres"]},
}


# ---------------------------------------------------------------- geometry helpers (pure; unit tested)
def _kx(lat): return 111320.0 * math.cos(math.radians(lat))
KY = 110540.0

def to_m(geom, lat0, lon0):
    """GeoJSON (lon/lat) -> shapely in local metres around (lat0, lon0)."""
    from shapely.geometry import shape
    from shapely.ops import transform
    kx = _kx(lat0)
    return transform(lambda x, y, z=None: ((x - lon0) * kx, (y - lat0) * KY), shape(geom))

def to_ll(g, lat0, lon0, nd=6):
    from shapely.geometry import mapping
    from shapely.ops import transform
    kx = _kx(lat0)
    m = mapping(transform(lambda x, y, z=None: (round(lon0 + x / kx, nd), round(lat0 + y / KY, nd)), g))
    return json.loads(json.dumps(m))   # tuples -> lists

def outer(g):
    """Polygon/MultiPolygon in metres -> same, holes dropped (keeps docs small)."""
    from shapely.geometry import Polygon, MultiPolygon
    if g.geom_type == "Polygon": return Polygon(g.exterior)
    if g.geom_type == "MultiPolygon": return MultiPolygon([Polygon(p.exterior) for p in g.geoms])
    return g

def wkt_geojson(wkt):
    from shapely import wkt as W
    from shapely.geometry import mapping
    return json.loads(json.dumps(mapping(W.loads(wkt))))

def pick(props, keys):
    for k in keys or []:
        v = props.get(k)
        if v not in (None, "", " "): return str(v).strip() if not isinstance(v, (int, float)) else v
    return None

def assemble(lat, lon, feats, fmap, src, radius=NEIGHBOR_M, max_nb=MAX_NEIGHBORS, snap_m=60):
    """feats: GeoJSON features around the pin. Returns {deal, neighbors, src, ...} or None when no parcel holds/near the pin.
    The deal parcel is the polygon containing the pin (else nearest within snap_m); neighbours are polygons within
    `radius` of it, nearest first, capped at max_nb. Geometry simplified to SIMPLIFY_M, holes dropped, 6-dp lon/lat."""
    from shapely.geometry import Point
    P = Point(0, 0); rows = []
    for f in feats:
        try:
            g = to_m(f["geometry"], lat, lon)
            if g.is_empty or g.geom_type not in ("Polygon", "MultiPolygon"): continue
            if not g.is_valid: g = g.buffer(0)
        except Exception:
            continue
        rows.append((g, f.get("properties") or {}))
    if not rows: return None
    inside = [r for r in rows if r[0].contains(P)]
    if inside: deal = min(inside, key=lambda r: r[0].area)
    else:
        deal = min(rows, key=lambda r: r[0].distance(P))
        if deal[0].distance(P) > snap_m: return None
    D = deal[0]
    near = [(r[0].distance(D), r) for r in rows if r is not deal and r[0].distance(D) <= radius
            and not (r[0].intersection(D).area > 0.9 * r[0].area)]
    near.sort(key=lambda t: t[0])
    def rec(g, p):
        ac = pick(p, fmap.get("acres"))
        try: ac = round(float(ac), 2) if ac is not None else None
        except ValueError: ac = None
        if not ac: ac = round(g.area / 4046.8564224, 2)
        s = outer(g).simplify(SIMPLIFY_M, preserve_topology=True)
        return {"apn": pick(p, fmap.get("apn")), "owner": pick(p, fmap.get("owner")), "acres": ac, "g": to_ll(s, lat, lon)}
    return {"src": src, "deal": rec(*deal), "neighbors": [rec(*r) for _, r in near[:max_nb]],
            "radius_m": radius, "n_found": len(rows)}


# ---------------------------------------------------------------- source adapters
class CountyArcGIS:
    name = "county"
    def __init__(self, county):
        self.county = county; self.cfg = COUNTY[county]
    def _q(self, **kw):
        import requests
        p = {"f": "geojson", "outFields": "*", "returnGeometry": "true", "outSR": 4326, "inSR": 4326}; p.update(kw)
        for i in range(3):
            try:
                r = requests.get(self.cfg["url"] + "/query", params=p, timeout=60)
                j = r.json()
                if "error" in j: raise RuntimeError(str(j["error"])[:200])
                return j.get("features") or []
            except Exception as e:
                err = e; time.sleep(2 + 3 * i)
        raise err
    def fetch(self, lat, lon, half_m):
        """One envelope query: the pin's surroundings out to half_m (deal parcel extent + radius)."""
        dx, dy = half_m / _kx(lat), half_m / KY
        kw = {} if "/MapServer/" in self.cfg["url"] else {"resultRecordCount": 2000}   # MapServers reject pagination
        feats = self._q(geometry=f"{lon-dx},{lat-dy},{lon+dx},{lat+dy}", geometryType="esriGeometryEnvelope",
                        spatialRel="esriSpatialRelIntersects", **kw)
        return assemble(lat, lon, feats, self.cfg, f"county:{self.county}")


class ZoneomicsV2:
    """Deal parcel only (no neighbours). One call per deal, cached in private/parcel_cache/zo_{id}.json."""
    name = "zoneomics"
    BASE = "https://api.zoneomics.com/v2/zoneDetail"
    calls = 0
    def fetch(self, sid, lat, lon, refresh=False):
        path = os.path.join(ZCACHE, f"zo_{sid}.json")
        if os.path.exists(path) and not refresh: j = json.load(open(path))
        else:
            import requests
            key = os.environ.get("ZONEOMICS_API_KEY")
            if not key: return None
            r = requests.get(self.BASE, params={"api_key": key, "lat": lat, "lng": lon, "output_fields": "parcels,geom"}, timeout=60)
            ZoneomicsV2.calls += 1
            j = r.json(); os.makedirs(ZCACHE, exist_ok=True); json.dump(j, open(path, "w"))
        return self.parse(j, lat, lon)
    @staticmethod
    def parse(j, lat, lon):
        ps = [p for p in ((j.get("data") or {}).get("parcels") or []) if isinstance(p, dict) and p.get("boundary")]
        feats = []
        for p in ps:
            oi = p.get("owner_info"); own = None
            if isinstance(oi, dict): own = oi.get("owner_name")
            elif isinstance(oi, str) and "owner_name" in oi:
                import ast
                try: own = ast.literal_eval(oi).get("owner_name")
                except Exception: own = None
            try: g = wkt_geojson(p["boundary"])
            except Exception: continue
            feats.append({"geometry": g, "properties": {"apn": p.get("apn"), "owner": own}})
        if not feats: return None
        out = assemble(lat, lon, feats, {"apn": ["apn"], "owner": ["owner"]}, "zoneomics:v2", snap_m=80)
        if out: out["neighbors"] = []
        return out


def norm_county(c):
    if not c: return None
    c = str(c).split(",")[0].replace(" County", "").strip()
    return c or None

_CC = os.path.join(ZCACHE, "county_of.json")
def county_of(lat, lon):
    """County from the pin (Census geocoder, cached): deal records sometimes carry the wrong county."""
    import requests
    c = json.load(open(_CC)) if os.path.exists(_CC) else {}; k = f"{lat:.5f},{lon:.5f}"
    if c.get(k): return c[k]
    try:
        j = requests.get("https://geocoding.geo.census.gov/geocoder/geographies/coordinates",
                         params={"x": lon, "y": lat, "benchmark": "Public_AR_Current", "vintage": "Current_Current",
                                 "layers": "Counties", "format": "json"}, timeout=40).json()
        v = norm_county(j["result"]["geographies"]["Counties"][0]["BASENAME"])
        c[k] = v; os.makedirs(ZCACHE, exist_ok=True); json.dump(c, open(_CC, "w")); return v
    except Exception:
        return None

def deals(a):
    """Active deals (stage != Passed) with pins -> private/parcel_deals.json. Reads: deals + rdeals + sites + rsites."""
    import edks
    c = edks.db(); st = {}
    for col in ("deals", "rdeals"):
        st.update({d.id: (d.to_dict() or {}).get("stage") for d in c.collection(col).stream()})
    out = {}
    for col in ("sites", "rsites"):
        for d in c.collection(col).stream():
            x = d.to_dict() or {}; j = json.loads(x["j"]) if x.get("j") else x
            if (st.get(d.id) or "New") == "Passed": continue
            out[d.id] = {"col": col, "view": x.get("view"), "stage": st.get(d.id) or "New",
                         **{k: j.get(k) for k in ("name", "lat", "lon", "acres", "county", "pin_county")}}
    json.dump(out, open(DEALS, "w"), indent=0, default=str); print(f"[parcels] {len(out)} active deals")


def stale(rec, days=STALE_DAYS):
    try: return (dt.date.today() - dt.date.fromisoformat(rec["fetched_at"][:10])).days > days
    except Exception: return True


def stage(a):
    deals = json.load(open(DEALS)); old = json.load(open(OUT)) if os.path.exists(OUT) else {}
    out = {}; z = ZoneomicsV2()
    for sid, d in sorted(deals.items()):
        if a.only and sid not in a.only: out[sid] = old.get(sid); continue
        if d.get("stage") == "Passed": continue
        prev = old.get(sid)
        if prev and not a.refresh and not stale(prev) and prev.get("src") != "none": out[sid] = prev; continue
        lat, lon = d.get("lat"), d.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            out[sid] = {"src": "none", "why": "no pin", "fetched_at": dt.date.today().isoformat()}; continue
        cty = county_of(lat, lon) or norm_county(d.get("county") or d.get("pin_county"))
        rec = None; why = []
        if cty in COUNTY:
            half = max(800.0, math.sqrt(max(float(d.get("acres") or 0), 1) * 4046.86) * 1.2 + NEIGHBOR_M)
            try: rec = CountyArcGIS(cty).fetch(lat, lon, min(half, 3000.0))
            except Exception as e: why.append(f"county {cty}: {e}"[:160])
            if rec is None and not why: why.append(f"county {cty}: no parcel at the pin")
        else: why.append(f"no county service for {cty}")
        if rec is None and not a.no_zoneomics:
            try: rec = z.fetch(sid, lat, lon, refresh=a.refresh)
            except Exception as e: why.append(f"zoneomics: {e}"[:160])
            if rec is None: why.append("zoneomics: no parcel")
        if rec is None: rec = {"src": "none", "why": "; ".join(why)}
        rec.update(county=cty, name=d.get("name"), view=d.get("view"), restricted=d.get("col") == "rsites",
                   fetched_at=dt.date.today().isoformat())
        out[sid] = rec
        print(f"[parcels] {sid} {cty or '?'}: {rec['src']} nb={len(rec.get('neighbors') or [])} {rec.get('why', '')}")
    out = {k: v for k, v in out.items() if v}
    json.dump(out, open(OUT, "w"), separators=(",", ":"))
    from collections import Counter
    print("[parcels] by source:", dict(Counter(v["src"].split(":")[0] for v in out.values())), "zoneomics calls:", ZoneomicsV2.calls)


def doc_of(rec):
    j = json.dumps({k: rec[k] for k in ("src", "deal", "neighbors", "radius_m", "county") if k in rec}, separators=(",", ":"))
    return j, hashlib.sha1(j.encode()).hexdigest()[:20]

def push(a):
    import edks
    from google.cloud import firestore
    data = json.load(open(OUT)); client = edks.db(); plan = []
    ids = [s for s, r in data.items() if r.get("src") != "none" and not r.get("flag")   # flagged = failed accuracy check, held for review
           and (not getattr(a, "only", None) or s in a.only)]
    refs = [client.collection(COLLECTION).document(s) for s in ids]; have = {}
    for k in range(0, len(refs), 100):
        for s in client.get_all(refs[k:k + 100]): have[s.id] = (s.to_dict() or {}).get("h") if s.exists else None
    for s in ids:
        j, h = doc_of(data[s])
        if have.get(s) == h: continue
        if len(j) > 900_000: print(f"[parcels] {s}: too large ({len(j)//1024} KB), skipped"); continue
        plan.append((s, j, h, data[s]))
    print(f"[parcels] {len(ids)} reads, {len(plan)} writes planned to {COLLECTION}/ ({sum(len(p[1]) for p in plan)//1024} KB)")
    if not a.apply: print("[parcels] dry run; pass --apply to write"); return
    b = client.batch(); n = 0
    for s, j, h, r in plan:
        b.set(client.collection(COLLECTION).document(s), {"j": j, "h": h, "src": r["src"], "fetched_at": r["fetched_at"],
                                                          "restricted": bool(r.get("restricted")), "by": "pipeline", "ts": firestore.SERVER_TIMESTAMP})
        n += 1
        if n % 20 == 0: b.commit(); b = client.batch()
    b.commit(); print(f"[parcels] wrote {len(plan)} docs")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); sp = ap.add_subparsers(dest="cmd", required=True)
    s = sp.add_parser("stage"); s.add_argument("--only", nargs="*"); s.add_argument("--refresh", action="store_true"); s.add_argument("--no-zoneomics", action="store_true")
    sp.add_parser("deals")
    p = sp.add_parser("push"); p.add_argument("--apply", action="store_true"); p.add_argument("--only", nargs="*")
    a = ap.parse_args(); sys.path.insert(0, HERE); {"deals": deals, "stage": stage, "push": push}[a.cmd](a)
