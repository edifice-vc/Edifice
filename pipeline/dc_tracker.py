#!/usr/bin/env python3
"""Data-center projects in/near Kansas from the More Than Just Parks Data Center Tracker
(https://morethanjustparks.com/data-center-tracker?near=kansas) -> sunflower/layers/dc_tracker.geojson.

Source: the tracker page embeds every project (id, name, company, status, capacity_mw, lat/lng, county,
state) in its Next.js RSC payload; each project's detail page adds source_url, land_use_acres,
tax_incentives_value etc. robots.txt allows /data-center-tracker and /data-center-tracker/*.
Kept: every Kansas record + Missouri records within 60 mi of downtown Kansas City.
Coordinates come from the tracker itself (no geocoding). Detail pages are cached for 6 days in the
previous geojson, so a weekly run refetches each once. Writes a new/changed/removed diff to
pipeline/dc_tracker_changes.json. Exit 0 with the previous file kept if the tracker is unreachable.
"""
import json, math, re, sys, time, datetime, argparse, urllib.request
from pathlib import Path

BASE = "https://morethanjustparks.com/data-center-tracker"
UA = "Mozilla/5.0 (compatible; EdificeSunflower/1.0; +https://edifice.vc)"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "sunflower/layers/dc_tracker.geojson"
CHG = ROOT / "pipeline/dc_tracker_changes.json"
KC = (39.0997, -94.5786)
ENR = ROOT / "pipeline/dc_tracker_enrich.json"
SUBS = ROOT / "sunflower/layers/subs.geojson"
TRACK = ["name", "company", "status", "mw", "acres", "invest", "county", "state", "src"]


def get(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:
            err = e
            time.sleep(3 * (i + 1))
    raise err


def records(html, tail):
    """Unescape the RSC JSON objects that start with "id":"<uuid>","name" and end at the given key."""
    pat = r'\{\\"id\\":\\"[0-9a-f-]{36}\\",\\"name\\".*?\\"%s\\":(?:null|\\"(?:[^"\\]|\\\\.)*\\")\}' % tail
    out = []
    for o in re.findall(pat, html):
        try:
            out.append(json.loads(json.loads('"' + o + '"')))
        except Exception:
            pass
    return out


def miles(a, b, c, d):
    r = math.pi / 180
    x = math.sin((c - a) * r / 2) ** 2 + math.cos(a * r) * math.cos(c * r) * math.sin((d - b) * r / 2) ** 2
    return 2 * 3958.8 * math.asin(math.sqrt(x))


def keep(r):
    if r.get("lat") is None or r.get("lng") is None:
        return False
    return r.get("state") == "KS" or (r.get("state") == "MO" and miles(KC[0], KC[1], r["lat"], r["lng"]) <= 60)


def money(s):
    if not s:
        return None
    m = re.search(r"\$\s?([\d.,]+)\s*(billion|million|bn|b|m)\b", s, re.I)
    if not m:
        return None
    v = float(m.group(1).replace(",", ""))
    return v * (1e9 if m.group(2).lower() in ("billion", "bn", "b") else 1e6)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-age-days", type=float, default=6)
    ap.add_argument("--delay", type=float, default=1.0)
    a = ap.parse_args()
    today = datetime.date.today().isoformat()
    prev = {}
    if OUT.exists():
        for f in json.load(open(OUT)).get("features", []):
            prev[f["properties"]["id"]] = f
    try:
        lst = [r for r in records(get(BASE + "?near=kansas"), "pin_town") if keep(r)]
    except Exception as e:
        print(f"dc_tracker: tracker unreachable ({e}); keeping previous layer", file=sys.stderr)
        return 0
    if not lst:
        print("dc_tracker: no records parsed (page format changed?); keeping previous layer", file=sys.stderr)
        return 0
    feats, fetched = [], 0
    for r in {x["id"]: x for x in lst}.values():
        old = prev.get(r["id"], {}).get("properties", {})
        d = None
        fresh = old.get("_dt") and (datetime.date.fromisoformat(today) - datetime.date.fromisoformat(old["_dt"])).days < a.max_age_days
        if not fresh:
            try:
                h = get(f"{BASE}/x--{r['id']}")
                d = next((x for x in records(h, "pin_town_url") if x["id"] == r["id"]), None)
                fetched += 1
                time.sleep(a.delay)
            except Exception as e:
                print(f"dc_tracker: detail {r['id']} failed ({e})", file=sys.stderr)
        if d:
            text = " ".join(str(d.get(k) or "") for k in ("editorial_summary", "capacity_quote", "grid_strain_notes"))
            det = {"src": d.get("source_url"), "srcn": d.get("verification_source_name"), "acres": d.get("land_use_acres"),
                   "invest": money(text), "incent": d.get("tax_incentives_value"), "power": d.get("power_source"),
                   "water": d.get("water_usage_mgd"), "jobs": d.get("jobs_estimate"), "opp": d.get("community_opposition_level"),
                   "rto": d.get("iso_rto"), "_dt": today}
        else:
            det = {k: old.get(k) for k in ("src", "srcn", "acres", "invest", "incent", "power", "water", "jobs", "opp", "rto", "_dt")}
        mw = r.get("capacity_mw") or None
        p = {"id": r["id"], "name": r["name"], "company": r.get("company"), "status": r.get("status"), "mw": mw,
             "county": r.get("county"), "state": r.get("state"), "town": r.get("pin_town"), "filed": r.get("date_filed"),
             "url": f"{BASE}/x--{r['id']}", **det, "first_seen": old.get("first_seen") or today, "last_seen": today}
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(r["lng"], 5), round(r["lat"], 5)]}, "properties": p})
    # hand-curated context + nearest >=115 kV substation (OSM layer) for power-competition matching
    enr = json.load(open(ENR))["projects"] if ENR.exists() else []
    subs = []
    if SUBS.exists():
        for f in json.load(open(SUBS))["features"]:
            kv = (f.get("properties") or {}).get("kv") or 0
            g = f.get("geometry") or {}
            if kv >= 115 and g.get("type") == "Point":
                subs.append((g["coordinates"][1], g["coordinates"][0], f["properties"].get("n") or "", kv))
    for f in feats:
        p = f["properties"]
        for e in enr:
            if re.search(e["match"], p["name"] + " " + (p.get("company") or ""), re.I):
                p.update({k: v for k, v in e.items() if k != "match"})
                if p.get("acres") is None and e.get("acres"): p["acres"] = e["acres"]
        lo, la = f["geometry"]["coordinates"]
        if subs:
            b = min(subs, key=lambda s: miles(la, lo, s[0], s[1]))
            p["sub"] = f"{b[2] or 'unnamed'} {b[3]:g} kV"
            p["sub_key"] = f"{b[0]:.4f},{b[1]:.4f}"
            p["sub_mi"] = round(miles(la, lo, b[0], b[1]), 1)
        p["loc_method"] = "tracker coordinates (no geocoding)"
    feats.sort(key=lambda f: -(f["properties"]["mw"] or 0))
    now = {f["properties"]["id"]: f["properties"] for f in feats}
    new = [now[i]["name"] for i in now if i not in prev]
    gone = [prev[i]["properties"]["name"] for i in prev if i not in now]
    changed = []
    for i in now:
        if i in prev:
            o = prev[i]["properties"]
            dd = {k: [o.get(k), now[i].get(k)] for k in TRACK if o.get(k) != now[i].get(k) and now[i].get(k) is not None}
            if dd:
                changed.append({"name": now[i]["name"], "changes": dd})
    gj = {"type": "FeatureCollection", "source": BASE + "?near=kansas", "attribution": "More Than Just Parks Data Center Tracker",
          "updated": today, "features": feats}
    OUT.write_text(json.dumps(gj, separators=(",", ":")))
    log = json.load(open(CHG)) if CHG.exists() else []
    if new or gone or changed or not log:
        log.insert(0, {"date": today, "count": len(feats), "new": new, "removed": gone, "changed": changed})
        CHG.write_text(json.dumps(log[:52], indent=1))
    print(f"dc_tracker: {len(feats)} projects ({fetched} detail pages fetched); new {len(new)}, changed {len(changed)}, removed {len(gone)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
