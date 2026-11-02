#!/usr/bin/env python3
"""Planned / NTC-issued / under-construction substations across SPP (Terrafice map layer "spp_subs").

Real downloaded documents only; nothing is invented:
  * SPP Quarterly Project Tracking (QPT) Appendix 1 (+ Appendix 2 construction status), latest quarter,
    discovered from spp.org's QPT document folder. Every approved ITP / GI / zonal / TSR upgrade with an NTC.
  * SPP ITP Assessment report (latest posted draft/final PDF): recommended (pre-NTC) new substations,
    switching stations, transformers and the 765 kV overlay terminals, with PDF page numbers.
Geocoding (location accuracy is always stored, a guessed point is never "exact"):
  osm    unique same-state name match to an OpenStreetMap power=substation (ODbL)        -> solid marker
  mid    tap / interconnection substation between two OSM-matched ends: midpoint          -> hollow
  town   name matches a Census Gazetteer place in the state: place centroid               -> hollow
  county name is "<X> County/Co.": county centroid (Census Gazetteer)                     -> hollow
  none   unlocated: listed in the popup-less side list, never plotted
Usage (cache in /workspace/spp_cache or $SPP_CACHE; re-runnable, downloads only what is missing):
  python3 pipeline/spp_subs.py build              -> pipeline/private/spp_subs.json (staged, local only)
  python3 pipeline/spp_subs.py push [--apply]     -> Firestore meta/spp_subs (dry run unless --apply; needs Sahil's OK)
The refresh workflow never calls push.
"""
import argparse, collections, datetime as dt, glob, html, io, json, math, os, re, subprocess, sys, time, urllib.parse, urllib.request, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(HERE, "private", "spp_subs.json")
CACHE = os.environ.get("SPP_CACHE", "/workspace/spp_cache")
UA = {"User-Agent": "Mozilla/5.0 (edifice-sites-map/1.0)"}
SPP = "https://www.spp.org"
QPT_FOLDER = SPP + "/spp-documents-filings/?id=18641"
ITP_URLS = [("2026 ITP & CPP Transition Assessment Report (draft v0.1, published 09/24/2026)",
             "https://www.rtoinsider.com/wp-content/uploads/2026/10/2026-ITP-Study-Draft.pdf")]
GAZ = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_{}_national.zip"
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
SPP_STATES = ["KS", "OK", "NE", "MO", "TX", "NM", "SD", "ND", "AR", "LA", "IA", "MT", "WY", "MN"]
KS_BORDER = {"KS", "OK", "NE", "MO"}  # Kansas + bordering SPP states (CO is outside SPP's RTO footprint)
STATE_NAMES = {"Kansas": "KS", "Oklahoma": "OK", "Nebraska": "NE", "Missouri": "MO", "Texas": "TX", "New Mexico": "NM"}

# ---------- fetch with cache ----------
def _get(url, data=None, timeout=300, tries=4):
    last = None
    for i in range(tries):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, data=data, headers=UA), timeout=timeout).read()
        except Exception as e:
            last = e; time.sleep(5 * (i + 1))
    raise RuntimeError(f"{url}: {last}")

def cached(name, url, data=None):
    p = os.path.join(CACHE, name)
    if not os.path.exists(p) or os.path.getsize(p) < 200:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        b = _get(url, data); open(p, "wb").write(b)
    return p

def latest_qpt():
    """(label, date, url, local zip) of the newest QPT Appendix 1&2 zip in SPP's QPT folder."""
    page = open(cached("qpt_folder.html", QPT_FOLDER), encoding="utf-8", errors="ignore").read()
    m = re.findall(r'href="(/Documents/(\d+)/([^"]*Quarterly Project Tracking Report Appendix[^"]*\.zip))"[^>]*>.*?</a>\s*(?:&nbsp;|\s)*[\d.]+\s*[KM]B\s*(?:&nbsp;|\s)*([A-Z][a-z]+ \d{1,2} \d{4})?', page, re.S)
    if not m:
        m = [(h, i, t, "") for h, i, t in re.findall(r'href="(/Documents/(\d+)/([^"]*Quarterly Project Tracking Report Appendix[^"]*\.zip))"', page)]
    href, did, title, date = max(m, key=lambda x: int(x[1]))
    url = SPP + urllib.parse.quote(html.unescape(href))
    return html.unescape(title).rsplit(".", 1)[0], date, url, cached(f"qpt_{did}.zip", url)

# ---------- parsing ----------
KV_STD = {34.5, 46, 69, 115, 138, 161, 230, 345, 500, 765}

def kv_list(v):
    out = set()
    for x in re.findall(r"\d{2,3}(?:\.\d)?", str(v or "")):
        f = float(x)
        if f in KV_STD: out.add(int(f) if f.is_integer() else f)
    return sorted(out, reverse=True)

def norm(name):
    s = str(name or "").lower()
    s = re.sub(r"\(.*?\)", " ", s)
    s = re.sub(r"\b\d{2,3}(\.\d)?\s*/?\s*(\d{2,3}\s*)?k?v\b", " ", s)
    s = re.sub(r"\b(substation|sub|switching station|switchyard|station|interconnection|new|ring bus|tap|kv|ckt|circuit|\d+)\b", " ", s)
    s = s.replace("co.", "county ").replace(" co ", " county ")
    s = re.sub(r"[^a-z ]", " ", s)
    s = re.sub(r"\bcounty\b", "county", s)
    return re.sub(r"\s+", " ", s).strip()

def iso(d):
    if isinstance(d, (dt.datetime, dt.date)): return d.strftime("%Y-%m-%d")
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", str(d or ""))
    return f"{m[3]}-{int(m[1]):02d}-{int(m[2]):02d}" if m else None

def num(v):
    try: return float(v) if v not in (None, "") else None
    except (TypeError, ValueError): return None

DONE = re.compile(r"^(complete|in service|closed out|withdrawn)$", re.I)
PLANNED = re.compile(r"^(identified|pending ntc)", re.I)
UNDER = re.compile(r"under construction|construction (has )?(begun|began|started|commenced|is underway|underway|in progress)|currently (being )?construct", re.I)
NEW_SUB = re.compile(r"\b(build|construct|install|establish|create)\w*\s+(a\s+|the\s+)?new\b[^.;]{0,80}?\b(substation|switching station|switchyard|switch station|ring[- ]bus|interconnection (sub)?station|ehv substation|station)\b|\bnew\b[^.;]{0,40}\b(substation|switching station)\b", re.I)
EXPAND = re.compile(r"transformer|autotransformer|xfmr|\bxfr\b|expan|new\s+\d{2,3}\s*kv\s+(bus|yard|bay)|voltage conversion|convert|ring bus|breaker[- ]and[- ]a[- ]half|new\s+(line\s+)?terminal|substation", re.I)
MINOR = re.compile(r"capacitor|cap bank|reactor|statcom|svc\b|breaker replacement|replace\w*\s+(the\s+)?breaker|relay|wave ?trap|switch replacement|\bct\b|jumper|scada|motor operated|meter", re.I)
LINE_WORD = re.compile(r"\bckt\b|\bline\b|rebuild|reconductor|circuit|tap line|double[- ]circuit", re.I)

def status_of(qs, comment, construction):
    if PLANNED.search(qs): return "planned"
    if str(construction or "").lower().startswith("in progress") or UNDER.search(comment or ""): return "under_construction"
    return "ntc_issued"

def read_qpt(zpath):
    import openpyxl
    z = zipfile.ZipFile(zpath)
    a1 = next(n for n in z.namelist() if re.search(r"Appendix 1\.xls", n))
    a2 = next((n for n in z.namelist() if re.search(r"Appendix 2\.xls", n)), None)
    cons = {}
    if a2:
        ws = openpyxl.load_workbook(io.BytesIO(z.read(a2)), read_only=True, data_only=True).worksheets[0]
        rows = list(ws.iter_rows(values_only=True)); h = [str(x or "").replace("\n", " ").strip() for x in rows[1]]
        iu, ic = h.index("Upgrade ID"), h.index("Construction Status")
        for r in rows[2:]:
            if r[iu]: cons[str(r[iu]).strip()] = re.sub(r"\s+", " ", str(r[ic] or "")).strip()
    ws = openpyxl.load_workbook(io.BytesIO(z.read(a1)), read_only=True, data_only=True).worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    hi = next(i for i, r in enumerate(rows) if r and r[0] == "NTC ID")
    H = [str(x or "").replace("\n", " ").strip() for x in rows[hi]]
    out = []
    for n, r in enumerate(rows[hi + 1:], start=hi + 2):
        if not r or not r[2]: continue
        d = dict(zip(H, r)); d["_row"] = n; d["_cons"] = cons.get(str(d["UID"]).strip())
        d["Project Status"] = re.sub(r"\s+", " ", str(d.get("Project Status") or "")).strip()
        out.append(d)
    return out, os.path.basename(a1)

def classify(u):
    """('new'|'expansion'|None, is_line) for one QPT upgrade row."""
    name, desc = str(u.get("Upgrade Name") or ""), str(u.get("Project Description/ Comments") or "")
    fb, tb = norm(u.get("From Bus Name")), norm(u.get("To Bus Name"))
    sub_word = re.search(r"substation|switching station|switchyard|interconnection|ring bus|transformer|xfmr|\bxfr\b|autotransformer", name, re.I)
    is_line = bool(tb and tb != fb and not sub_word) or bool(LINE_WORD.search(name) and not sub_word) or bool(re.search(r"\w\s+[-–]\s+\w", name) and not sub_word)
    if is_line: return None, True
    if NEW_SUB.search(name + ". " + desc) and not re.search(r"new\s+\d+\s*mvar|new\s+(capacitor|reactor)", name, re.I): return "new", False
    if MINOR.search(name) and not re.search(r"transformer|xfmr|substation", name, re.I): return None, False
    if EXPAND.search(name) or re.search(r"transformer|new\s+\d{2,3}\s*kv", desc, re.I): return "expansion", False
    return None, False

def tidy(n):
    """Turn sentence-style upgrade names into a substation name."""
    n = re.sub(r"^(build|install|replace|upgrade|add|construct|rebuild|expand|convert)\w*\s+(the\s+|a\s+|an\s+)?(second|third|new|2nd|3rd)?\s*", "", n.strip(), flags=re.I)
    m = re.search(r"\bat\s+([A-Z][\w .'-]+?)(\s+(sub|substation)\b|$)", n, re.I)
    if m: n = m[1]
    m = re.match(r"([A-Za-z .'-]+?)\s*\d*\s+to\s+([A-Za-z .'-]+?)\s*\d*\b", n)
    if m and norm(re.sub(r"\d+$", "", m[1].strip()))[:3] == norm(re.sub(r"\d+$", "", m[2].strip()))[:3]:
        n = min((re.sub(r"\d+$", "", x.strip()) for x in (m[1], m[2])), key=len)
    n = re.sub(r"\s*\b\d{2,3}\s*[-/]\s*\d{2,3}\s*kv\b.*$|\s*\b\d+\s*mva\b.*$|\s+(tx|xfmr|transformer)\b.*$", "", n, flags=re.I).strip(" -–,")
    n = re.sub(r"^(xfr|xfmr|tx)\s*[-–]\s*", "", n, flags=re.I)
    if not re.match(r"(gen-|sub\s+)\d", n, re.I): n = re.sub(r"\d+$", "", n).strip()
    return n.title() if n.isupper() else n

def sub_name(u):
    fbn = str(u.get("From Bus Name") or "").strip()
    nm = str(u.get("Upgrade Name") or "")
    base = re.split(r"\s+\d{2,3}(?:\.\d)?\s*(?:/\s*\d{2,3}\s*)?kv\b", nm, flags=re.I)[0]
    base = re.sub(r"\b(new|substation|interconnection|switching station|transformer|xfmr|auto)\b.*$", "", base, flags=re.I).strip(" -–,")
    n = tidy(re.sub(r"\s*\d{2,3}(\.\d)?\s*kv.*$", "", fbn, flags=re.I).strip() or base or nm)
    junk = lambda x: len(x) < 3 or x.lower() in ("sub", "xfr", "xfmr", "tx", "substation", "transformer")
    if junk(n): n = tidy(nm)
    if junk(n): n = tidy(str(u.get("Project Name") or ""))
    return re.split(r"\s+[-–]\s+", n)[0].strip()

def first_state(s):
    m = re.match(r"\s*([A-Z]{2})", str(s or "").upper())
    return m[1] if m and m[1] != "NA" else None

def build_qpt(rows, src):
    subs, lines = {}, []
    for u in rows:
        qs = u["Project Status"]
        if DONE.match(qs): continue
        kind, is_line = classify(u)
        st = first_state(u.get("State(s)"))
        rec = {"ntc": str(u.get("NTC ID") or "") or None, "pid": str(u.get("PID") or ""), "uid": str(u.get("UID") or ""),
               "p": re.sub(r"\s+", " ", str(u.get("Project Name") or "")).strip(), "u": re.sub(r"\s+", " ", str(u.get("Upgrade Name") or "")).strip(),
               "t": re.sub(r"\s+", " ", str(u.get("Project Type") or "")).strip(), "study": str(u.get("Source Study") or "").replace("\n", " ").strip(),
               "isd": iso(u.get("Project Owner Indicated In-Service Date")), "ntcd": iso(u.get("Letter of Notification to Construct Issue Date")),
               "cost": num(u.get("Current Cost Estimate")) or num(u.get("Baseline Cost Estimate")), "qs": qs,
               "s": status_of(qs, u.get("Project Description/ Comments"), u.get("_cons")), "row": u["_row"]}
        if is_line:
            lines.append((norm(u.get("From Bus Name")), norm(u.get("To Bus Name")), st, rec, u)); continue
        if not kind: continue
        nm = sub_name(u); key = (st, norm(nm) or nm.lower())
        s = subs.setdefault(key, {"n": nm, "st": st, "o": set(), "kind": kind, "kv": set(), "pj": [], "src": src, "desc": []})
        if kind == "new": s["kind"] = "new"
        s["o"].add(str(u.get("ProjectOwner") or "").strip()); s["kv"].update(kv_list(u.get("Voltages (kV)")) + kv_list(u.get("Upgrade Name")))
        s["pj"].append(rec); s["desc"].append(str(u.get("Project Description/ Comments") or "")[:300])
        s["_ends"] = s.get("_ends") or tap_ends(nm)
    # link line upgrades to the substations at either end
    for (st, k), s in subs.items():
        s["ln"] = sorted({f'{r["u"]} ({r["s"].replace("_", " ")}{", ISD " + r["isd"] if r["isd"] else ""})' for a, b, lst, r, _ in lines if k and k in (a, b)})[:10]
        pids = {p["pid"] for p in s["pj"]}
        s["ln"] = sorted(set(s["ln"]) | {f'{r["u"]} ({r["s"].replace("_", " ")})' for a, b, lst, r, _ in lines if r["pid"] in pids})[:12]
    return subs, lines

def tap_ends(nm):
    m = re.match(r"(.+?)\s+[-–]\s+(.+?)(?:\s+tap)?$", nm.strip(), re.I)
    return [norm(m[1]), norm(m[2])] if m else None

def itp_entries(label, url, path):
    """Pre-NTC substation items from an ITP report: table rows (with page numbers) + 765 kV overlay terminals."""
    pages = int(re.search(r"Pages:\s+(\d+)", subprocess.run(["pdfinfo", path], capture_output=True, text=True).stdout)[1])
    out = {}
    def add(name, st, kind, kv, isd, owner, page, what, ntc_rec):
        key = (st, norm(name))
        e = out.setdefault(key, {"n": name, "st": st, "o": set(), "kind": kind, "kv": set(), "pj": [], "ln": [], "desc": [],
                                 "src": [{"t": label, "u": url, "p": page}]})
        if kind == "new": e["kind"] = "new"
        e["kv"].update(kv); owner and e["o"].add(owner)
        e["pj"].append({"ntc": None, "pid": None, "uid": None, "p": what, "u": what, "t": "ITP recommended" + (" (NTC recommended)" if ntc_rec else " (no NTC yet)"),
                        "study": label.split(" (")[0], "isd": isd, "cost": None, "qs": "ITP recommended", "s": "planned", "row": None, "page": page})
        if not any(x["p"] == page for x in e["src"]): e["src"].append({"t": label, "u": url, "p": page})
    for p in range(1, pages + 1):
        t = subprocess.run(["pdftotext", "-layout", "-f", str(p), "-l", str(p), path, "-"], capture_output=True, text=True).stdout
        for m in re.finditer(r"^\s*(.+?)\s(\d{2,3}(?:/\d{2,3})?)\s*kV\s*(New Substation|Switching Station|New Transformer)\s+(\d{1,2}/\d{1,2}/\d{4})?\s*([A-Z][A-Za-z/&]+)?\s*$", t, re.M):
            nm, kv, what, isd, own = m.groups()
            add(nm.strip(), None, "expansion" if what == "New Transformer" else "new", kv_list(kv), iso(isd), own, p, f"{nm.strip()} {kv} kV {what}", True)
        for m in re.finditer(r"^\s*(.+?)\s765 kV\s*New(?: Line)?[, ]*.*?\s(Yes|No)\b", t, re.M):
            for nm in re.split(r"\s+[–-]\s+", m[1].strip()):
                nm = nm.strip()
                if not nm or len(nm) > 40: continue
                add(nm, None, "expansion", [765], None, None, p, f"{m[1].strip()} 765 kV new line terminal", m[2] == "Yes")
        if "tentatively named Southern" in t or ("Southern Paradise" in t and "new substation" in t):
            add("Southern Paradise", None, "new", [765, 345], None, None, p, "Southern Paradise 765 kV new substation (Kansas City Metro, tentative name; site not published)", True)
    for e in out.values():
        if e["n"] == "Southern Paradise": e["kind"] = "new"
    return out

# ---------- geocoding ----------
def osm_state(st):
    p = os.path.join(CACHE, "osm", f"{st}.json")
    if not (os.path.exists(p) and os.path.getsize(p) > 2000) and not os.environ.get("SPP_OSM_OFFLINE"):
        q = f'[out:json][timeout:170];area["ISO3166-2"="US-{st}"]->.a;nwr["power"="substation"]["name"](area.a);out center tags;'
        for u in OVERPASS:
            try:
                b = _get(u, urllib.parse.urlencode({"data": q}).encode(), 180, 2); json.loads(b)
                os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "wb").write(b); break
            except Exception as e:
                print(f"  [osm] {st} {u}: {str(e)[:80]}", file=sys.stderr); time.sleep(20)
    if not (os.path.exists(p) and os.path.getsize(p) > 2000): return []
    out = []
    for el in json.load(open(p)).get("elements", []):
        t = el.get("tags", {}); lat = el.get("lat") or (el.get("center") or {}).get("lat"); lon = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat is None: continue
        for nm in {t.get("name"), t.get("alt_name"), t.get("official_name")} - {None}:
            out.append((norm(nm), lat, lon, t.get("name"), f"https://www.openstreetmap.org/{el['type']}/{el['id']}", t.get("operator")))
    return out

def gaz(kind):
    z = zipfile.ZipFile(cached(f"gaz_{kind}.zip", GAZ.format(kind)))
    lines = z.read(z.namelist()[0]).decode("latin-1").splitlines()
    h = [x.strip() for x in lines[0].split("\t")]; out = collections.defaultdict(list)
    for ln in lines[1:]:
        d = dict(zip(h, [x.strip() for x in ln.split("\t")]))
        n = re.sub(r"\s+(city|town|village|CDP|borough|municipality)$", "", d["NAME"], flags=re.I) if kind == "place" else re.sub(r"\s+(County|Parish)$", "", d["NAME"])
        out[(d["USPS"], n.lower())].append((float(d["INTPTLAT"]), float(d["INTPTLONG"])))
    return out

def geocode(e, osm, places, counties):
    st, k = e["st"], norm(e["n"])
    states = [st] if st else SPP_STATES
    hits = [(s, h) for s in states for h in osm.get(s, {}).get(k, [])] if k else []
    if hits:
        pts = {(round(h[1], 2), round(h[2], 2)) for _, h in hits}
        if len(pts) == 1:
            s, h = hits[0]; e["st"] = e["st"] or s
            return {"loc": "osm", "lat": round(h[1], 4), "lon": round(h[2], 4), "osm": h[4], "note": f'Matched by name to OpenStreetMap substation "{h[3]}"'}
    ends = e.get("_ends")
    if ends and st:
        a = osm.get(st, {}).get(ends[0], []); b = osm.get(st, {}).get(ends[1], [])
        if len(a) == 1 and len(b) == 1 and hav(a[0][1], a[0][2], b[0][1], b[0][2]) < 150:
            return {"loc": "mid", "lat": round((a[0][1] + b[0][1]) / 2, 3), "lon": round((a[0][2] + b[0][2]) / 2, 3),
                    "note": f"Approximate: midpoint of {a[0][3]} and {b[0][3]} (tap point on that line not published)"}
    m = re.match(r"(.+?)\s+county$", k)
    if m:
        for s in states:
            c = counties.get((s, m[1]))
            if c and len(c) == 1:
                e["st"] = e["st"] or s
                return {"loc": "county", "lat": round(c[0][0], 3), "lon": round(c[0][1], 3), "note": f"Approximate: {m[1].title()} County centroid (Census Gazetteer); exact site not published"}
    if st and k:
        c = places.get((st, k))
        if c and len(c) == 1:
            return {"loc": "town", "lat": round(c[0][0], 3), "lon": round(c[0][1], 3), "note": f"Approximate: {k.title()} town centroid (Census Gazetteer); substation site not published"}
    return {"loc": "none", "lat": None, "lon": None, "note": "Unlocated: no unique OpenStreetMap, town or county match"}

def hav(a, b, c, d):
    r = math.radians; x = math.sin(r(c - a) / 2) ** 2 + math.cos(r(a)) * math.cos(r(c)) * math.sin(r(d - b) / 2) ** 2
    return 3959 * 2 * math.asin(math.sqrt(x))

RANK = {"under_construction": 3, "ntc_issued": 2, "planned": 1}

def finalize(e, gc):
    pj = sorted(e["pj"], key=lambda p: (p["isd"] or "9999"))
    s = max((p["s"] for p in pj), key=lambda x: RANK[x])
    costs = [p["cost"] for p in pj if p["cost"]]
    isds = [p["isd"] for p in pj if p["isd"]]
    r = {"n": e["n"], "st": e["st"], "o": ", ".join(sorted(x for x in e["o"] if x)) or None, "kind": e["kind"],
         "kv": sorted(e["kv"], reverse=True), "s": s, "isd": max(isds) if isds else None, "isd0": min(isds) if isds else None,
         "cost": round(sum(costs)) if costs else None,
         "pj": [{k: v for k, v in p.items() if v not in (None, "")} for p in pj[:12]], "npj": len(pj),
         "ln": e.get("ln", []), "src": e["src"] if isinstance(e["src"], list) else [e["src"]], **gc}
    r["id"] = re.sub(r"[^a-z0-9]+", "-", f'{r["st"] or "spp"}-{r["n"]}'.lower()).strip("-")
    return r

def build(a):
    label, date, url, zpath = latest_qpt()
    rows, a1 = read_qpt(zpath)
    qsrc = {"t": f"SPP {label} ({a1})", "u": url, "date": date, "p": "Appendix 1"}
    subs, lines = build_qpt(rows, None)
    for s in subs.values():
        rws = sorted(p["row"] for p in s["pj"] if p.get("row"))
        s["src"] = [dict(qsrc, p="Appendix 1, row " + ", ".join(map(str, rws[:6])) + ("…" if len(rws) > 6 else ""))]
    itp = {}
    for lab, u in ITP_URLS:
        try: itp.update(itp_entries(lab, u, cached("itp_" + os.path.basename(u), u)))
        except Exception as e: print("[spp_subs] ITP", u, e, file=sys.stderr)
    # ITP items that already carry an NTC in the QPT: attach the ITP mention as a source, keep QPT status
    byname = collections.defaultdict(list)
    for k, s in subs.items(): byname[k[1]].append(s)
    merged = dict(subs)
    for (st, k), e in itp.items():
        if k in byname and len(byname[k]) == 1:
            s = byname[k][0]; s["pj"] += e["pj"]; s["kv"] |= e["kv"]; s["src"] += e["src"]
        else: merged[(st, k)] = e
    osm = {}
    for st in SPP_STATES:
        idx = collections.defaultdict(list)
        for h in osm_state(st):
            if h[0]: idx[h[0]].append(h)
        osm[st] = idx
    places, counties = gaz("place"), gaz("counties")
    out = [finalize(e, geocode(e, osm, places, counties)) for e in merged.values()]
    out.sort(key=lambda r: (r["st"] != "KS", r["st"] or "zz", r["n"]))
    seen = collections.Counter()
    for r in out:
        seen[r["id"]] += 1
        if seen[r["id"]] > 1: r["id"] += f"-{seen[r['id']]}"
    doc = {"built": dt.date.today().isoformat(), "spec": 1,
           "sources": [qsrc] + [{"t": l, "u": u} for l, u in ITP_URLS] + [
               {"t": "OpenStreetMap power=substation via Overpass (ODbL)", "u": "https://www.openstreetmap.org/copyright"},
               {"t": "US Census 2024 Gazetteer places and counties", "u": "https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html"}],
           "osm_states": [s for s in SPP_STATES if osm[s]], "subs": out}
    os.makedirs(os.path.dirname(PUB), exist_ok=True)
    json.dump(doc, open(PUB, "w"), separators=(",", ":"), default=list)
    print(f"[spp_subs] {len(out)} substations -> {PUB} ({os.path.getsize(PUB)//1024} KB)")
    print(json.dumps(stats(doc), indent=1))

def stats(doc):
    S = doc["subs"]; C = collections.Counter
    return {"total": len(S), "by_status": C(r["s"] for r in S), "by_kind": C(r["kind"] for r in S), "by_state": C(r["st"] or "?" for r in S),
            "by_loc": C(r["loc"] for r in S), "kansas": sum(r["st"] == "KS" for r in S), "ks_border": sum(r["st"] in KS_BORDER for r in S),
            "with_cost": sum(bool(r["cost"]) for r in S), "with_isd": sum(bool(r["isd"]) for r in S)}

def push(a):
    """Upload pipeline/private/spp_subs.json as meta/spp_subs (chunked only if > MAX_DOC, hash skip). Dry run unless --apply."""
    import edks
    text = open(PUB).read(); client = edks.db(); writes = []
    old = client.collection("meta").document("spp_subs").get()
    if old.exists and (old.to_dict() or {}).get("h") == edks._h(text):
        print("[spp_subs] unchanged: 1 read, 0 writes"); return
    edks._put_blob(client, "spp_subs", text, writes)
    print(f"[spp_subs] {len(writes)} writes planned ({len(text)//1024} KB): " + ", ".join(f"{op} meta/{r.id}" for op, r, _ in writes))
    if a.apply: edks._commit(client, writes); print("[spp_subs] pushed")
    else: print("[spp_subs] dry run; pass --apply to write")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("build"); pu = sp.add_parser("push"); pu.add_argument("--apply", action="store_true")
    sp.add_parser("stats")
    a = ap.parse_args()
    {"build": build, "push": push, "stats": lambda a: print(json.dumps(stats(json.load(open(PUB))), indent=1))}[a.cmd](a)
