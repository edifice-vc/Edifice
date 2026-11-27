#!/usr/bin/env python3
"""Build Kansas-clipped, simplified GeoJSON overlay layers for the sites map (sunflower/layers/*.geojson).

Run by hand, or weekly from .github/workflows/map-layers.yml:
    python3 pipeline/map_layers.py

Sources (all public, no keys):
  lines.geojson  HIFLD Electric Power Transmission Lines (public domain) merged with
                 OpenStreetMap power=line (ODbL, © OpenStreetMap contributors).
                 OSM is unverified. A same-voltage OSM segment within ~30 m of HIFLD is dropped.
  gas.geojson    EIA Natural Gas Interstate and Intrastate Pipelines (public domain, US EIA)
  subs.geojson   OpenStreetMap power=substation via Overpass (ODbL, © OpenStreetMap contributors)
  aadt.geojson   KDOT AADT Flow Map, state system (Kansas DOT public data)

A source that fails does not blank the layer. The previous committed file is kept and a warning
is printed. If there is no previous file, the script exits with an error.
"""
import json, os, sys, time, urllib.parse, urllib.request
from shapely.geometry import LineString, MultiLineString, mapping, shape
from shapely.ops import transform, unary_union
from shapely.strtree import STRtree
from pyproj import Transformer

BBOX = (-102.06, 36.99, -94.58, 40.01)  # west, south, east, north
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sunflower", "layers")
UA = {"User-Agent": "edifice-sites-map/1.0 (transmission layer; +https://edifice.vc)"}
LINES = "https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Electric_Power_Transmission_Lines/FeatureServer/0"
GAS = "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Natural_Gas_Interstate_and_Intrastate_Pipelines_1/FeatureServer/0"
AADT = "https://kanplan.ksdot.gov/arcgis_web_adaptor/rest/services/Transportation/AADT_Flow_Map/FeatureServer/0"
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"]
MIN_KV = 69
DEDUPE_M = 30.0
MIN_PIECE_M = 40.0
OSM_SIMPLIFY_M = 18.0
TO_M = Transformer.from_crs("EPSG:4326", "EPSG:5070", always_xy=True)
TO_LL = Transformer.from_crs("EPSG:5070", "EPSG:4326", always_xy=True)


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def get(url, data=None, timeout=180):
    last = None
    for i in range(4):
        try:
            req = urllib.request.Request(url, data=data, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.load(resp)
        except Exception as e:
            last = e
            time.sleep(3 * (i + 1))
    raise RuntimeError(f"{url}: {last}")


def overpass(query, timeout=240):
    """POST an Overpass query. Every endpoint is tried; failure raises (never an empty result)."""
    body = urllib.parse.urlencode({"data": query}).encode()
    errors = []
    for url in OVERPASS:
        try:
            return get(url, data=body, timeout=timeout)
        except Exception as e:
            errors.append(f"{url}: {e}")
            log(f"WARNING: Overpass endpoint failed ({url}): {e}")
    raise RuntimeError("Overpass failed: " + " | ".join(errors))


def arc(url, fields, where="1=1", offset=0.002, page=1000):
    feats, start = [], 0
    while True:
        q = {"where": where, "outFields": ",".join(fields), "geometry": ",".join(map(str, BBOX)),
             "geometryType": "esriGeometryEnvelope", "inSR": 4326, "outSR": 4326,
             "spatialRel": "esriSpatialRelIntersects", "maxAllowableOffset": offset,
             "geometryPrecision": 4, "resultOffset": start, "resultRecordCount": page, "f": "geojson"}
        d = get(url + "/query?" + urllib.parse.urlencode(q))
        if d.get("error"):
            raise RuntimeError(str(d["error"])[:300])
        fs = d.get("features") or []
        feats += [f for f in fs if f.get("geometry")]
        if len(fs) < page:
            if not feats:
                raise RuntimeError(f"{url}: 0 features")
            return feats
        start += page


def layer_path(name, out=None):
    return os.path.join(out or OUT, name)


def load_fc(name, out=None):
    p = layer_path(name, out)
    if not os.path.exists(p) or os.path.getsize(p) < 50:
        return None
    try:
        return json.load(open(p))
    except Exception as e:
        log(f"WARNING: could not read cached {name}: {e}")
        return None


def write(name, feats, src, out=None):
    os.makedirs(out or OUT, exist_ok=True)
    p = layer_path(name, out)
    tmp = p + ".tmp"
    with open(tmp, "w") as fh:
        json.dump({"type": "FeatureCollection", "source": src, "built": time.strftime("%Y-%m-%d"),
                   "features": feats}, fh, separators=(",", ":"))
    os.replace(tmp, p)
    kb = os.path.getsize(p) / 1024
    log(f"{name} {len(feats)} features  {kb:.0f} KB  ({kb/1024:.2f} MB)")
    return p


def refresh(name, produce, src, out=None):
    """Write a layer, or keep the committed file and warn. No silent empty overwrite."""
    try:
        feats = produce()
        if not feats:
            raise RuntimeError(f"{name}: source returned no features")
        return write(name, feats, src, out)
    except Exception as e:
        prev = load_fc(name, out)
        n = len((prev or {}).get("features") or [])
        if n:
            built = prev.get("built") or "unknown"
            log(f"WARNING: {name} refresh failed ({e}). Reusing previously committed {name} "
                f"({n} features, built {built}).")
            return layer_path(name, out)
        raise RuntimeError(f"{name} refresh failed and no committed layer is available to reuse: {e}") from e


# ---------------------------------------------------------------- voltage
def parse_multi_kv(raw):
    """Max of a ';'-separated voltage tag, in kV. Values above 2000 are volts."""
    if raw is None:
        return None
    nums = []
    for part in str(raw).split(";"):
        part = part.strip().replace(",", "")
        if not part:
            continue
        token = []
        for ch in part:
            if ch.isdigit() or (ch == "." and "." not in token):
                token.append(ch)
            elif token:
                break
        if not token or token == ["."]:
            continue
        n = float("".join(token))
        if n > 2000:
            n /= 1000.0
        if n > 0:
            nums.append(n)
    return max(nums) if nums else None


def _not_available(v):
    return "NOT AVAILABLE" in str(v or "").upper()


def hifld_voltage(voltage, volt_class):
    """HIFLD voltage in kV. 'NOT AVAILABLE' or a negative value is unknown (None).

    A missing voltage may fall back to VOLT_CLASS. UNDER 100 is treated as 69 kV.
    An explicit unknown voltage does not fall back to the class.
    """
    if _not_available(voltage):
        return None
    num = None
    if voltage not in (None, ""):
        try:
            num = float(voltage)
        except (TypeError, ValueError):
            num = parse_multi_kv(voltage)
    if num is not None and num < 0:
        return None
    if num is not None and num > 0:
        return float(num)
    c = str(volt_class or "")
    if _not_available(c):
        return None
    if "UNDER 100" in c.upper():
        return 69.0
    parsed = parse_multi_kv(c)
    return float(parsed) if parsed else None


def volt_class(kv):
    """Map class used by the map: 345 / 220-287 / 100-161 / 69 / unknown."""
    if kv is None:
        return "unknown"
    if kv >= 300:
        return "345"
    if kv >= 200:
        return "220-287"
    if kv >= 100:
        return "100-161"
    if kv >= 69:
        return "69"
    return "low"


def same_voltage(a, b):
    """Same nominal kV. Unknown matches only unknown, so an untagged OSM line is not dropped onto a known HIFLD line."""
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    return int(round(a)) == int(round(b))


def _xy(transformer):
    def fn(x, y, z=None):
        return transformer.transform(x, y)
    return fn


def to_meters(g):
    return transform(_xy(TO_M), g)


def to_lonlat(g):
    return transform(_xy(TO_LL), g)


def _dedupe_coords(coords):
    out = []
    for c in coords:
        xy = (round(float(c[0]), 4), round(float(c[1]), 4))
        if not out or xy != out[-1]:
            out.append(xy)
    return out


def clean_line(g):
    """Round to 4 decimals and drop collapsed parts. Endpoints are kept so shared junctions stay put."""
    if g is None or g.is_empty:
        return None
    if g.geom_type == "LineString":
        c = _dedupe_coords(list(g.coords))
        return LineString(c) if len(c) >= 2 else None
    if g.geom_type == "MultiLineString":
        parts = []
        for p in g.geoms:
            c = _dedupe_coords(list(p.coords))
            if len(c) >= 2:
                parts.append(LineString(c))
        if not parts:
            return None
        return parts[0] if len(parts) == 1 else MultiLineString(parts)
    if g.geom_type == "GeometryCollection":
        parts = []
        for p in g.geoms:
            c = clean_line(p)
            if c is None:
                continue
            parts.extend(list(c.geoms) if c.geom_type == "MultiLineString" else [c])
        if not parts:
            return None
        return parts[0] if len(parts) == 1 else MultiLineString(parts)
    return None


def prep_line(g, simplify_m=0):
    if g is None or g.is_empty:
        return None
    gm = to_meters(g)
    if simplify_m:
        gm = gm.simplify(simplify_m, preserve_topology=True)
    return clean_line(to_lonlat(gm))


def line_parts(g):
    if g is None or g.is_empty:
        return []
    if g.geom_type == "LineString":
        return [g]
    if g.geom_type == "MultiLineString":
        return [p for p in g.geoms if not p.is_empty]
    if g.geom_type == "GeometryCollection":
        out = []
        for p in g.geoms:
            out.extend(line_parts(p))
        return out
    return []


def _kv_key(kv):
    return None if kv is None else int(round(kv))


def clip_osm_to_hifld(osm_m, hifld_by_kv, kv, meters=DEDUPE_M, min_piece_m=MIN_PIECE_M):
    """Drop OSM pieces within `meters` of a same-voltage HIFLD line. Other voltages are kept.

    `osm_m` and the HIFLD geoms are in metres. Returns a metres geometry or None.
    """
    mates = hifld_by_kv.get(_kv_key(kv)) or []
    mates = [g for g in mates if g is not None and not g.is_empty]
    if not mates or osm_m is None or osm_m.is_empty:
        return osm_m
    tree = hifld_by_kv.get("_tree_" + str(_kv_key(kv)))
    if tree is None:
        tree = STRtree(mates)
        hifld_by_kv["_tree_" + str(_kv_key(kv))] = tree
        hifld_by_kv["_mates_" + str(_kv_key(kv))] = mates
    mates = hifld_by_kv["_mates_" + str(_kv_key(kv))]
    hits = tree.query(osm_m.buffer(meters))
    if getattr(hits, "size", len(hits)) == 0:
        return osm_m
    near = unary_union([mates[int(i)] for i in hits]).buffer(meters)
    diff = osm_m.difference(near)
    kept = [p for p in line_parts(diff) if p.length >= min_piece_m]
    if not kept:
        return None
    return kept[0] if len(kept) == 1 else MultiLineString(kept)


def _drop_empty(props):
    return {k: v for k, v in props.items() if v not in (None, "")}


def _feature(g, props):
    return {"type": "Feature", "geometry": mapping(g), "properties": _drop_empty(props)}


def hifld_feature(feat):
    p = feat.get("properties") or {}
    kv = hifld_voltage(p.get("VOLTAGE") if "VOLTAGE" in p else p.get("kv"), p.get("VOLT_CLASS") if "VOLT_CLASS" in p else p.get("c"))
    # Already-normalized committed features (a reuse path) pass through.
    if "VOLTAGE" not in p and "voltage_kv" in p:
        kv = p.get("voltage_kv")
    g = prep_line(shape(feat["geometry"]), simplify_m=0)
    if g is None:
        return None
    cls = volt_class(kv)
    owner = p.get("OWNER") if "OWNER" in p else p.get("operator") or p.get("o")
    props = {
        "source": "HIFLD",
        "kv": None if kv is None else int(round(kv)),
        "voltage_kv": None if kv is None else int(round(kv)),
        "c": cls,
        "o": owner,
        "operator": owner,
        "a": p.get("SUB_1") if "SUB_1" in p else p.get("a"),
        "b": p.get("SUB_2") if "SUB_2" in p else p.get("b"),
    }
    if kv is None:
        props["unk"] = 1
    return _feature(g, props), kv, to_meters(g)


def osm_line_feature(el, simplify_m=OSM_SIMPLIFY_M):
    tags = el.get("tags") or {}
    if tags.get("power") != "line":
        return None
    raw = tags.get("voltage")
    untagged = raw is None or str(raw).strip() == ""
    kv = None if untagged else parse_multi_kv(raw)
    if not untagged and kv is None:
        kv = None  # unparsable voltage: keep, marked unknown
    elif kv is not None and kv < MIN_KV:
        return None
    geom = el.get("geometry") or []
    if len(geom) < 2:
        return None
    g = prep_line(LineString([(pt["lon"], pt["lat"]) for pt in geom]), simplify_m=simplify_m)
    if g is None:
        return None
    circuits = tags.get("circuits")
    try:
        circuits = int(circuits) if circuits not in (None, "") else None
    except (TypeError, ValueError):
        circuits = str(circuits) if circuits else None
    props = {
        "source": "OSM",
        "unverified": True,
        "name": tags.get("name"),
        "operator": tags.get("operator"),
        "o": tags.get("operator"),
        "voltage_kv": None if kv is None else int(round(kv)),
        "kv": None if kv is None else int(round(kv)),
        "c": volt_class(kv),
        "circuits": circuits,
        "ref": tags.get("ref"),
        "osm_id": el.get("id"),
    }
    if kv is None:
        props["unk"] = 1
    return _feature(g, props), kv


def fetch_hifld_lines():
    raw = arc(LINES, ["VOLTAGE", "VOLT_CLASS", "OWNER", "SUB_1", "SUB_2"])
    out = []
    for f in raw:
        built = hifld_feature(f)
        if built:
            out.append(built)
    if not out:
        raise RuntimeError("HIFLD returned no line geometries")
    return out


def fetch_osm_lines():
    s, w, n, e = BBOX[1], BBOX[0], BBOX[3], BBOX[2]
    raw_path = os.environ.get("OSM_LINES_RAW", "/tmp/osm_power_line.json")
    d = None
    if os.environ.get("OSM_LINES_REUSE") == "1" and os.path.exists(raw_path):
        log(f"reusing Overpass response {raw_path}")
        d = json.load(open(raw_path))
    if not d or not d.get("elements"):
        q = f'[out:json][timeout:180][maxsize:1073741824];way["power"="line"]({s},{w},{n},{e});out geom tags;'
        try:
            d = overpass(q, timeout=240)
        except RuntimeError:
            q = f'[out:json][timeout:180];way["power"="line"]({s},{w},{n},{e});out geom tags;'
            d = overpass(q, timeout=240)
        try:
            json.dump(d, open(raw_path, "w"))
        except Exception as e:
            log(f"WARNING: could not cache Overpass response: {e}")
    els = d.get("elements") or []
    if not els:
        raise RuntimeError("Overpass returned no power=line ways in the Kansas bbox")
    kept, dropped = [], 0
    for el in els:
        built = osm_line_feature(el)
        if built:
            kept.append(built)
        else:
            dropped += 1
    if not kept:
        raise RuntimeError(f"Overpass returned {len(els)} power=line ways but none at >={MIN_KV} kV or untagged")
    log(f"OSM power=line: {len(els)} ways, kept {len(kept)}, dropped {dropped} under {MIN_KV} kV")
    return kept


def merge_lines(hifld_rows, osm_rows):
    """HIFLD first (drawn under OSM). OSM segments within ~30 m of the same voltage are removed."""
    by_kv = {}
    features = []
    for feat, kv, gm in hifld_rows:
        features.append(feat)
        by_kv.setdefault(_kv_key(kv), []).append(gm)
    removed = 0
    for feat, kv in osm_rows:
        gm = to_meters(shape(feat["geometry"]))
        clipped = clip_osm_to_hifld(gm, by_kv, kv)
        if clipped is None:
            removed += 1
            continue
        g = clean_line(to_lonlat(clipped))
        if g is None:
            removed += 1
            continue
        feat = dict(feat, geometry=mapping(g))
        features.append(feat)
    log(f"deduped OSM: removed {removed} of {len(osm_rows)} ways that sit within {DEDUPE_M:.0f} m of same-voltage HIFLD")
    return features


def _cached_rows(name, source):
    prev = load_fc(name) or {}
    rows = []
    for f in prev.get("features") or []:
        p = f.get("properties") or {}
        if source == "OSM" and p.get("source") != "OSM":
            continue
        if source == "HIFLD" and p.get("source") == "OSM":
            continue
        if not f.get("geometry"):
            continue
        if source == "OSM":
            kv = p.get("voltage_kv", p.get("kv"))
            try:
                kv = float(kv) if kv not in (None, "") else None
            except (TypeError, ValueError):
                kv = None
            if kv is not None and kv <= 0:
                kv = None
            rows.append((f, kv))
        else:
            built = hifld_feature(f)
            if built:
                rows.append(built)
    return rows


def build_lines():
    try:
        hifld = fetch_hifld_lines()
    except Exception as e:
        hifld = _cached_rows("lines.geojson", "HIFLD")
        if not hifld:
            raise RuntimeError(f"HIFLD transmission lines failed and no cached HIFLD lines are available: {e}") from e
        log(f"WARNING: HIFLD fetch failed ({e}). Reusing {len(hifld)} previously committed HIFLD line features.")
    try:
        osm = fetch_osm_lines()
    except Exception as e:
        osm = _cached_rows("lines.geojson", "OSM")
        if not osm:
            raise RuntimeError(
                f"Overpass power=line failed and the committed lines layer has no OSM features to reuse: {e}") from e
        log(f"WARNING: Overpass power=line failed ({e}). Reusing {len(osm)} previously committed OSM line features.")
    return merge_lines(hifld, osm)


# ---------------------------------------------------------------- other layers
def slim(feats, keep):
    out = []
    for f in feats:
        p = f.get("properties") or {}
        out.append({"type": "Feature", "geometry": f["geometry"],
                    "properties": {k2: p.get(k) for k, k2 in keep.items()}})
    return out


def sub_label(name, operator, kv, osm_type, osm_id):
    if name and str(name).strip():
        return str(name).strip()
    if operator and str(operator).strip():
        return str(operator).strip()
    kind = "way" if osm_type == "way" else "node" if osm_type == "node" else (osm_type or "way")
    if kv:
        return f"unnamed {int(kv)} kV sub (OSM {kind} {osm_id})"
    return f"unnamed sub (OSM {kind} {osm_id})"


def subs():
    s, w, n, e = BBOX[1], BBOX[0], BBOX[3], BBOX[2]
    q = (f'[out:json][timeout:180];(node["power"="substation"]({s},{w},{n},{e});'
         f'way["power"="substation"]({s},{w},{n},{e}););out center tags;')
    d = overpass(q, timeout=200)
    els = d.get("elements") or []
    if not els:
        raise RuntimeError("Overpass returned no power=substation elements")
    out = []
    for el in els:
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat is None:
            continue
        t = el.get("tags") or {}
        kv = parse_multi_kv(t.get("voltage"))
        if kv is not None:
            kv = int(round(kv))
        name, operator = t.get("name"), t.get("operator")
        out.append({"type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [round(lon, 4), round(lat, 4)]},
                    "properties": _drop_empty({
                        "n": name, "o": operator, "kv": kv, "id": el.get("id"), "typ": el.get("type"),
                        "lb": sub_label(name, operator, kv, el.get("type"), el.get("id")),
                    })})
    if not out:
        raise RuntimeError("Overpass substations had no coordinates")
    return out


def gas():
    return slim(arc(GAS, ["TYPEPIPE", "Operator"]), {"TYPEPIPE": "t", "Operator": "o"})


def aadt():
    return slim(arc(AADT, ["AADTCount", "AADTCountYear", "RouteID"], where="AADTCount>0", offset=0.003),
                {"AADTCount": "v", "AADTCountYear": "y", "RouteID": "r"})


LINES_SRC = "HIFLD Electric Power Transmission Lines (public domain) + OpenStreetMap power=line (ODbL, unverified)"


if __name__ == "__main__":
    refresh("lines.geojson", build_lines, LINES_SRC)
    refresh("gas.geojson", gas, "EIA Natural Gas Pipelines")
    refresh("subs.geojson", subs, "OpenStreetMap contributors (ODbL)")
    refresh("aadt.geojson", aadt, "KDOT AADT Flow Map")
