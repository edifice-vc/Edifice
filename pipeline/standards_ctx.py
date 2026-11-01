"""Per-site jurisdiction limits for Site Planning, parsed from the dc-references standards index.

Reads dc-references/standards/site_planning_context.json (text values with source + page), pulls numbers out of
them, maps each sitedata site to a jurisdiction by county, and writes sites[id].std into pipeline/private/sitedata.json
(gitignored, shipped in the member-read sitedata meta blob: 0 extra Firestore reads).
Every value keeps {v, text, src, page, label}. No match -> engine defaults, flagged "no jurisdiction match".
  python3 standards_ctx.py            # augment private/sitedata.json
  python3 standards_ctx.py --show ID  # print one site's limits
"""
import argparse, json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(HERE, "private", "sitedata.json")
CTX = os.environ.get("EDKS_STD_CTX", "/workspace/edifice-sites/dc-references/standards/site_planning_context.json")
# county (KS unless noted) -> jurisdiction key in site_planning_context.json. Screening match only: a county
# match is not a zoning determination (unincorporated land follows the county code, not the city's).
COUNTY_JUR = {"Johnson": "De Soto", "Wyandotte": "KCK/WyCo UG", "Lyon": "Emporia", "Sedgwick": "Sedgwick (draft)",
              "Crawford": "Pittsburg KS (Wildcat)", "Jackson MO": "KCMO", "Clay MO": "KCMO", "Platte MO": "KCMO"}
FT = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s*(?:'|’|ft\b|feet)")

def _num(rx, t):
    return [float(x.replace(",", "")) for x in rx.findall(t or "")]

def _pick(entries, how):
    """Return the governing parsed value from a list of {value_text,...} entries."""
    best = None
    for e in entries or []:
        t = e.get("value_text", "")
        v = how(t)
        if v is None: continue
        if best is None or v < best[0] if how.__name__ == "mn" else best is None or v > best[0]:
            best = (v, e)
    if not best: return None
    v, e = best
    return {"v": v, "text": e.get("value_text", "")[:240], "src": e.get("source", ""), "page": e.get("page", ""), "label": e.get("label", ""), "from": "standards index"}

def mn(t):  # smallest ft figure = perimeter baseline setback (road-specific/residential setbacks stay in the text)
    n = _num(FT, t); return min(n) if n else None
def first(t):
    n = _num(FT, t); return n[0] if n else None
def parking(t):
    m = re.search(r"(\d+)\s*spaces?\s*per\s*(?:DC\s*)?building", t or "", re.I); return float(m.group(1)) if m else None
def pct(t):
    m = re.search(r"(\d+(?:\.\d+)?)\s*%", t or ""); return float(m.group(1)) if m else None
def far(t):
    m = re.search(r"FAR[^0-9]{0,12}(\d+(?:\.\d+)?)", t or "", re.I); return float(m.group(1)) if m else None
first.__name__ = "mx"; parking.__name__ = "mx"; pct.__name__ = "mx"; far.__name__ = "mx"

FIELDS = {"setback_ft": ("setback_building_ft", mn), "buffer_ft": ("buffer_width_ft", first), "max_h_ft": ("max_height_ft", first),
          "parking_per_bldg": ("parking_per_building", parking), "cov_pct": ("lot_coverage", pct), "far": ("far", far)}

def limits(J):
    out = {}
    for k, (f, how) in FIELDS.items():
        r = _pick(J.get(f), how)
        if r: out[k] = r
    return out

def jur_for(o):
    c = (o.get("pin_county") or o.get("listed_county") or "").strip()
    return COUNTY_JUR.get(c) or COUNTY_JUR.get(c + " " + (o.get("state") or "KS"))

def build(ctx_path=CTX, pub=PUB):
    C = json.load(open(ctx_path)); d = json.load(open(pub)); n = 0
    for o in d["sites"].values():
        j = jur_for(o)
        if o.get("view") == "storage":  # the index is data-center precedent; it does not govern self-storage
            o["std"] = {"jur": None, "match": "standards index covers data centers only; self-storage uses engine defaults + Zoneomics", "limits": {}}; continue
        if j and j in C["jurisdictions"]:
            o["std"] = {"jur": j, "match": "county proxy (screening, not a zoning determination): " + (o.get("pin_county") or o.get("listed_county")), "limits": limits(C["jurisdictions"][j])}; n += 1
        else:
            o["std"] = {"jur": None, "match": "no jurisdiction match in standards index (engine defaults)", "limits": {}}
    d.setdefault("meta", {})["std"] = {"src": "dc-references/standards/site_planning_context.json", "generated_from": C.get("generated_from", ""), "gaps": C.get("gaps", [])[:20]}
    json.dump(d, open(pub, "w"), separators=(",", ":"))
    print(f"[standards_ctx] {n}/{len(d['sites'])} sites matched a jurisdiction")
    return d

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--show")
    a = ap.parse_args()
    if a.show: print(json.dumps(json.load(open(PUB))["sites"][a.show].get("std"), indent=1))
    else: build()
