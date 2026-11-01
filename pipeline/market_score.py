"""Python mirror of the client-side Terrafice 'Market & power competition' component (template.html MC calc).
Used for the impact report; the app computes the same thing in the browser from layers/dc_tracker.geojson."""
import json, math, re
from pathlib import Path
CFG = json.load(open(Path(__file__).with_name("market_score.json")))

def mi(a, b, c, d):
    r = math.pi / 180
    x = math.sin((c - a) * r / 2) ** 2 + math.cos(a * r) * math.cos(c * r) * math.sin((d - b) * r / 2) ** 2
    return 2 * 3958.8 * math.asin(math.sqrt(x))

def cnty(s):
    return re.sub(r"\s+county$", "", str(s or "").strip(), flags=re.I).lower()

def market(site, projects, sub_key=None, C=CFG):
    """projects: list of geojson features. Returns {score, parts:[(label, pts, why)], near:[...]}"""
    la, lo = site.get("lat"), site.get("lon")
    if la is None or lo is None:
        return None
    P, parts, near = C["power"], [], []
    pw, same, prec_c, prec_n, opp, stop, law, land = 0.0, [], [], [], [], [], [], []
    for f in projects:
        p = f["properties"]; x, y = f["geometry"]["coordinates"]; d = mi(la, lo, y, x); st = p.get("status")
        samec = p.get("state") == "KS" and cnty(p.get("county")) == cnty(site.get("county"))
        if d <= 30: near.append((round(d, 1), p))
        if st in C["active_status"] and d <= P["radius_mi"]:
            w = P["w_near"] if d <= P["near_mi"] else P["w_mid"] if d <= P["mid_mi"] else P["w_far"]
            ss = sub_key and p.get("sub_key") == sub_key
            if ss: w *= P["same_sub_mult"]; same.append(p["name"])
            pw += w * (p.get("mw") or C["unknown_mw"])
        if st in C["precedent"]["statuses"]:
            if samec: prec_c.append(p["name"])
            elif d <= C["precedent"]["within_mi"]: prec_n.append(p["name"])
        if st == "moratorium" and samec: opp.append(p["name"])
        if st in C["stopped_status"] and (samec or d <= C["opposition"]["stopped_mi"]): stop.append(p["name"])
        if p.get("lawsuit") and d <= C["opposition"]["lawsuit_mi"]: law.append(p["name"])
        if st in C["active_status"] and d <= C["land"]["radius_mi"] and (p.get("acres") or 0) >= C["land"]["acres_min"] and re.search(C["land"]["hyperscalers"], (p.get("company") or "") + " " + (p.get("end_user") or ""), re.I):
            land.append(p["name"])
    pp = -min(P["max_pts"], pw / P["mw_per_point"])
    parts.append(("Power competition", round(pp, 1), f"{pw:.0f} distance-weighted MW of active projects within {P['radius_mi']} mi (unknown MW counted as {C['unknown_mw']}, ESTIMATE)" + (f"; same nearest substation as {', '.join(same)}" if same else "")))
    pr = (C["precedent"]["same_county_pts"] if prec_c else 0) + (C["precedent"]["near_pts"] if prec_n else 0)
    parts.append(("Zoning precedent", pr, ("Approved/built DC in same county: " + ", ".join(prec_c[:3]) if prec_c else "No approved DC in county") + ("; within 15 mi: " + ", ".join(prec_n[:3]) if prec_n else "")))
    o = (C["opposition"]["moratorium_county_pts"] if opp else 0) + max(C["opposition"]["stopped_max"], C["opposition"]["stopped_pts"] * len(stop)) + (C["opposition"]["lawsuit_pts"] if law else 0)
    parts.append(("Opposition / moratoria", o, "; ".join(filter(None, ["Moratorium: " + ", ".join(opp) if opp else "", "Stopped nearby: " + ", ".join(stop[:3]) if stop else "", "Lawsuit nearby: " + ", ".join(law) if law else ""])) or "None found nearby"))
    lp = C["land"]["pts"] if land else 0
    parts.append(("Land competition", lp, "Hyperscaler campus ≥250 ac within 10 mi: " + ", ".join(land) if land else "No large hyperscaler campus within 10 mi"))
    sc = max(0, min(100, round(50 + sum(x[1] for x in parts))))
    return {"score": sc, "parts": parts, "near": sorted(near, key=lambda t: t[0])}

def blend(site, m, C=CFG):
    b = site.get("overall")
    if m is None or not isinstance(b, (int, float)): return b
    v = max(0, min(100, b + round(C["max_adj"] * (m["score"] - 50) / 50)))
    fpp = (site.get("floodplain") or {}).get("pct") if isinstance(site.get("floodplain"), dict) else None
    if fpp is not None and fpp > 50: v = min(v, 30)
    return v
