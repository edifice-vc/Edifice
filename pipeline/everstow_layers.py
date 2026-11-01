#!/usr/bin/env python3
"""Everstow (self-storage) map layers -> sunflower/layers/  (public data only; run by hand: python3 pipeline/everstow_layers.py)
  sscomp.geojson   competitor self-storage across Kansas : OpenStreetMap (ODbL) via a Geofabrik Kansas extract (--pbf=) or Overpass. Size = est. NRSF from mapped
                   footprint (buildings x levels x 85%, or site polygon x 40%); points-only facilities have size null.
  sspermit.geojson recent self-storage permits/approvals, hand-curated in everstow_permits.json (each with a source URL)
  bgpop.json       ACS 5-yr block-group population at 2020 Census population-weighted BG centroids (KS + MO border counties),
                   used in the browser to sum population within 5 miles of a site.
"""
import json, os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import storage as S

HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, "..", "sunflower", "layers")
BB = (36.99, -102.06, 40.01, -94.30)  # s, w, n, e (east edge reaches KC-MO Northland)
MO_NEAR = {"037", "047", "095", "165", "013", "217", "011", "097", "145", "119", "021", "107", "049", "063", "087", "003", "177"}

def write(name, obj):
    p = os.path.join(OUT, name); json.dump(obj, open(p, "w"), separators=(",", ":")); print(name, os.path.getsize(p) // 1024, "KB")

NAME_RE = re.compile(r"self[ -]?stor|mini[ -]?stor|storage (center|centre|units|depot|mart)|storagemart|cubesmart|extra space|public storage|u-?haul moving|life storage", re.I)

def pbf_elements(path):
    """Same element set as storage.storage_osm's Overpass query, read from a Geofabrik Kansas extract
    (used when public Overpass servers time out). Relations are kept as centroid-less members are skipped."""
    import osmium
    out = []
    def want(t): return t.get("shop") == "storage_rental" or t.get("amenity") == "storage_rental" or NAME_RE.search(t.get("name", ""))
    for o in osmium.FileProcessor(path).with_locations().with_filter(osmium.filter.KeyFilter("shop", "amenity", "name")):
        t = dict(o.tags)
        if not want(t): continue
        if o.is_node(): out.append({"type": "node", "id": o.id, "lat": o.location.lat, "lon": o.location.lon, "tags": t})
        elif o.is_way():
            try: g = [{"lat": nd.lat, "lon": nd.lon} for nd in o.nodes]
            except Exception: continue
            out.append({"type": "way", "id": o.id, "geometry": g, "tags": t})
    return out

def comps(pbf=None):
    s, w, n, e = BB; feats = []
    if pbf:
        els = pbf_elements(pbf); S.overpass = lambda q: els; raw = S.storage_osm(BB)
    else:
        # 8x2 tiles keep each Overpass query small; retry a tile on timeout
        xs = [w + (e - w) * i / 8 for i in range(9)]; ys = [s, (s + n) / 2, n]; raw = []
        for y0, y1 in zip(ys, ys[1:]):
            for a, b in zip(xs, xs[1:]):
                for t in range(3):
                    try: raw += S.storage_osm((y0, a, y1, b)); break
                    except RuntimeError as ex:
                        if t == 2: raise
                        print("retry tile", ex, flush=True); time.sleep(30)
                time.sleep(2)
    for k in S.cluster_storage(raw):
        if not k.get("tagged") and k["name"].startswith("Self storage (unnamed"): continue
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(k["lon"], 5), round(k["lat"], 5)]},
                      "properties": {"n": k["name"], "o": k.get("brand") or None, "sf": k.get("est_nrsf"), "b": k.get("basis") or None, "u": k["osm"]}})
    return {"type": "FeatureCollection", "source": "OpenStreetMap contributors (ODbL)", "built": time.strftime("%Y-%m-%d"), "features": feats}

def bgpop():
    cen = {}
    for st in ("20", "29"):
        txt = S.get(f"https://www2.census.gov/geo/docs/reference/cenpop2020/blkgrp/CenPop2020_Mean_BG{st}.txt", timeout=120).text
        for line in txt.splitlines()[1:]:
            p = line.split(",")
            if st == "29" and p[1] not in MO_NEAR: continue
            cen[p[0] + p[1] + p[2] + p[3]] = (float(p[5]), float(p[6]))
    counties = sorted({g[:5] for g in cen}); pop = {}; rel = ""
    for c in counties:
        for i in range(8):
            try: d = S.get(S.CENSUS_REPORTER, params={"table_ids": "B01003,B25003,B19013", "geo_ids": f"150|05000US{c}"}, timeout=90, tries=1).json(); break
            except RuntimeError: time.sleep(20 * (i + 1))
        else: raise RuntimeError("census reporter " + c)
        time.sleep(2)
        rel = (d.get("release") or {}).get("name", rel)
        for gid, t in (d.get("data") or {}).items():
            try: pop[gid.split("US")[-1]] = (int(t["B01003"]["estimate"]["B01003001"] or 0), int(t["B25003"]["estimate"]["B25003001"] or 0), int(t["B25003"]["estimate"]["B25003003"] or 0), t["B19013"]["estimate"]["B19013001"])
            except (KeyError, TypeError): pass
    pts = [[round(cen[g][0], 4), round(cen[g][1], 4), *pop[g]] for g in cen if g in pop]
    print("block groups", len(pts), "of", len(cen), rel)
    return {"source": f"US Census Bureau {rel} (B01003 population, B25003 households/renters, B19013 median HH income) at 2020 population-weighted block-group centroids", "release": rel, "built": time.strftime("%Y-%m-%d"), "cols": ["lat", "lon", "pop", "hh", "renter_hh", "med_inc"], "p": pts}

def permits():
    recs = json.load(open(os.path.join(HERE, "everstow_permits.json")))
    return {"type": "FeatureCollection", "source": "City/county agendas, permit records and news (see each record)", "built": time.strftime("%Y-%m-%d"),
            "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [r["lon"], r["lat"]]}, "properties": {k: v for k, v in r.items() if k not in ("lat", "lon")}} for r in recs]}

if __name__ == "__main__":
    pbf = next((x.split("=", 1)[1] for x in sys.argv[1:] if x.startswith("--pbf=")), None)
    want = {x for x in sys.argv[1:] if not x.startswith("--")} or {"comp", "pop", "permit"}
    if "comp" in want: write("sscomp.geojson", comps(pbf))
    if "pop" in want: write("bgpop.json", bgpop())
    if "permit" in want: write("sspermit.geojson", permits())
