"""Public reference data for the Site Plan civil layer (pipeline/civil.js). Run on demand; never in the refresh job.

  python3 civil_ref.py build          # -> pipeline/civil_ref.json (public data only; committed and inlined by render.py)
  python3 civil_ref.py site LAT LON   # exact NOAA Atlas 14 point values for one location (cached)

Sources (all public, no key):
  * NOAA Atlas 14 Vol. 8 precipitation-frequency estimates, PFDS point service
    https://hdsc.nws.noaa.gov/cgi-bin/new/cgi_readH5.py (partial-duration series, depth in inches). Sampled on a
    0.5 deg grid over Kansas; the app interpolates bilinearly (Atlas 14 varies smoothly, about 0.3 in per 0.5 deg).
  * FAA ADDS / NASR airports (US_Airport) and runway centerlines (RunwayLine) ArcGIS services, public-use and
    operational airports in and within ~30 mi of Kansas, for 14 CFR Part 77 screening.
Raw responses are cached under pipeline/private/civil_cache/ (gitignored). No site, parcel, owner or zoning data is
written to civil_ref.json.
"""
import json, math, os, re, sys, time, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "private", "civil_cache")
OUT = os.path.join(HERE, "civil_ref.json")
PFDS = "https://hdsc.nws.noaa.gov/cgi-bin/new/cgi_readH5.py?lat={:.4f}&lon={:.4f}&type=pf&data=depth&units=english&series=pds"
FAA = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services"
DUR = ["5m", "10m", "15m", "30m", "60m", "2h", "3h", "6h", "12h", "24h"]   # first 10 PFDS rows
ARI = {"2": 1, "10": 3, "25": 4, "100": 6}                                   # PFDS columns 1,2,5,10,25,50,100,...
BBOX = (36.5, -102.6, 40.5, -94.0)


def _get(url, key, data=None):
    os.makedirs(CACHE, exist_ok=True)
    p = os.path.join(CACHE, key)
    if os.path.exists(p):
        return open(p, encoding="utf-8").read()
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "edifice-siteplan/1.0 (planning estimates)"})
    for i in range(3):
        try:
            t = urllib.request.urlopen(req, timeout=40).read().decode("utf-8", "replace")
            open(p, "w", encoding="utf-8").write(t)
            time.sleep(0.25)
            return t
        except Exception:
            time.sleep(2 + 3 * i)
    raise RuntimeError("fetch failed: " + url.split("?")[0])


def pfds(lat, lon):
    t = _get(PFDS.format(lat, lon), "pfds_%.4f_%.4f.txt" % (lat, lon))
    m = re.search(r"quantiles\s*=\s*(\[\[.*?\]\]);", t, re.S)
    if not m:
        raise RuntimeError("PFDS parse")
    Q = json.loads(m.group(1).replace("'", '"'))
    return {a: [round(float(Q[r][c]), 2) for r in range(len(DUR))] for a, c in ARI.items()}


def noaa_grid():
    lats = [37.0 + 0.5 * i for i in range(7)]
    lons = [-102.0 + 0.5 * j for j in range(16)]
    G = {a: [] for a in ARI}
    for la in lats:
        row = {a: [] for a in ARI}
        for lo in lons:
            v = pfds(la, lo)
            for a in ARI:
                row[a].append(v[a])
        for a in ARI:
            G[a].append(row[a])
    return {"lat0": lats[0], "lon0": lons[0], "d": 0.5, "nlat": len(lats), "nlon": len(lons), "dur": DUR, "ari": list(ARI), "depth_in": G,
            "src": "NOAA Atlas 14 Vol. 8 v2, PFDS partial-duration depths (in), 0.5 deg grid, fetched " + time.strftime("%Y-%m-%d")}


def _q(layer, params, key):
    q = urllib.parse.urlencode(dict(params, f="json"))
    return json.loads(_get(f"{FAA}/{layer}/FeatureServer/0/query?{q}", key))


def airports():
    env = "%f,%f,%f,%f" % (BBOX[1], BBOX[0], BBOX[3], BBOX[2])
    base = {"geometry": env, "geometryType": "esriGeometryEnvelope", "inSR": 4326, "outSR": 4326, "spatialRel": "esriSpatialRelIntersects"}
    A = []
    off = 0
    while True:
        j = _q("US_Airport", dict(base, where="PRIVATEUSE=0 AND OPERSTATUS='OPERATIONAL'", outFields="IDENT,NAME,ELEVATION,TYPE_CODE,SERVCITY,STATE,MIL_CODE",
                                 resultOffset=off, resultRecordCount=1000), f"faa_apt_{off}.json")
        F = j.get("features", [])
        A += F
        if len(F) < 1000:
            break
        off += 1000
    R = []
    off = 0
    while True:
        j = _q("RunwayLine", dict(base, where="1=1", outFields="OBJECTID", resultOffset=off, resultRecordCount=2000), f"faa_rwy_{off}.json")
        F = j.get("features", [])
        R += F
        if len(F) < 2000:
            break
        off += 2000
    out = []
    for f in A:
        a, g = f["attributes"], f["geometry"]
        out.append({"id": a["IDENT"], "name": a["NAME"], "city": a.get("SERVCITY"), "st": a.get("STATE"), "type": a.get("TYPE_CODE"),
                    "mil": a.get("MIL_CODE"), "elev": a.get("ELEVATION"), "lat": round(g["y"], 6), "lon": round(g["x"], 6), "rwy": []})
    kx = lambda la: 364000 * math.cos(math.radians(la))
    for f in R:
        for path in (f.get("geometry") or {}).get("paths", []):
            if len(path) < 2:
                continue
            a, b = path[0], path[-1]
            mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            best, bd = None, 1e18
            for ap in out:
                d = math.hypot((ap["lon"] - mx) * kx(my), (ap["lat"] - my) * 364000)
                if d < bd:
                    best, bd = ap, d
            L = math.hypot((a[0] - b[0]) * kx(my), (a[1] - b[1]) * 364000)
            if best and bd < 12000 and L > 300:
                best["rwy"].append([round(a[0], 6), round(a[1], 6), round(b[0], 6), round(b[1], 6), round(L)])
    return {"airports": out, "src": "FAA ADDS (NASR) US_Airport + RunwayLine, public-use operational, fetched " + time.strftime("%Y-%m-%d")}


def build():
    ref = {"v": 1, "noaa": noaa_grid(), "faa": airports()}
    json.dump(ref, open(OUT, "w"), separators=(",", ":"))
    print("wrote", OUT, os.path.getsize(OUT), "bytes;", len(ref["faa"]["airports"]), "airports")


if __name__ == "__main__":
    if sys.argv[1:2] == ["build"]:
        build()
    elif sys.argv[1:2] == ["site"]:
        print(json.dumps(pfds(float(sys.argv[2]), float(sys.argv[3]))))
    else:
        print(__doc__)
