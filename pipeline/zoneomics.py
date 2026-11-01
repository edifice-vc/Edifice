"""Zoneomics zoning adapter for Site Planning (admin-only data).

LICENSING / HANDLING (Sahil): Zoneomics data is ADMIN-ONLY and must never be redistributed.
  * Real responses are written only to pipeline/private/zoning.json (gitignored) and Firestore zoning/{siteId}
    (rules: admin read, client write false). Never commit them, never add them to the member-read sitedata blob,
    never bulk-export them client-side (the app reads ONE doc per opened site and has no export path).
  * This repo is PUBLIC: only the interface and a FAKE fixture live here.

Interface: ZoningProvider.lookup(site) -> ZoningRecord dict with keys
  district, district_name, permitted_uses[], dc_use, storage_use, setbacks_ft{front,side,rear}, max_height_ft,
  max_lot_coverage_pct, max_far, parking{per_1000sf, per_building, text}, src, fetched, fixture(bool)
Each numeric field is {v, src} so the app can label every override with its source.

  python3 zoneomics.py build --provider mock         # FAKE values for wiring/tests (marked fixture: true)
  python3 zoneomics.py build --provider zoneomics    # needs ZONEOMICS_API_KEY (+ ZONEOMICS_BASE); private only
  python3 zoneomics.py push [--apply]                # dry-run unless --apply; --apply needs Sahil's approval
"""
import argparse, datetime, hashlib, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(HERE, "private", "sitedata.json")
OUT = os.path.join(HERE, "private", "zoning.json")
NUM = ("max_height_ft", "max_lot_coverage_pct", "max_far")

class ZoningProvider:
    name = "base"
    def lookup(self, site):  # site: sitedata site dict (id, view, geo.site, pin_county, ...)
        raise NotImplementedError

def _f(v, src):
    return None if v is None else {"v": float(v), "src": src}

class ZoneomicsClient(ZoningProvider):
    """Live client. Endpoint/field names follow Zoneomics' parcel-zoning API as documented to us; confirm against
    the contract on arrival and adjust _map() only (the rest of the stack depends on the ZoningRecord shape)."""
    name = "zoneomics"
    def __init__(self, key=None, base=None):
        self.key = key or os.environ.get("ZONEOMICS_API_KEY"); self.base = base or os.environ.get("ZONEOMICS_BASE", "https://api.zoneomics.com/v2")
        if not self.key: raise SystemExit("ZONEOMICS_API_KEY not set (data arrives this week; use --provider mock until then)")
    def lookup(self, site):
        import requests
        from shapely.geometry import shape
        c = shape(site["geo"]["site"]).centroid
        r = requests.get(f"{self.base}/zoneDetail", params={"api_key": self.key, "lat": c.y, "lng": c.x}, timeout=30); r.raise_for_status()
        return self._map(r.json())
    def _map(self, j):
        z = (j.get("data") or j); m = z.get("zone_details") or z.get("meta") or z; src = "Zoneomics " + str(z.get("zone_code") or z.get("district") or "")
        g = lambda *k: next((m.get(x) for x in k if m.get(x) not in (None, "")), None)
        return {"district": g("zone_code", "district"), "district_name": g("zone_name", "district_name"),
                "permitted_uses": list(z.get("permitted_uses") or [])[:60], "dc_use": None, "storage_use": None,
                "setbacks_ft": {k: _f(g(f"setback_{k}", f"min_{k}_setback"), src) for k in ("front", "side", "rear")},
                "max_height_ft": _f(g("max_building_height_ft", "max_height"), src), "max_lot_coverage_pct": _f(g("max_lot_coverage", "lot_coverage"), src),
                "max_far": _f(g("max_far", "far"), src), "parking": {"text": g("parking_requirements", "parking"), "per_1000sf": None, "per_building": None},
                "src": src, "fetched": datetime.date.today().isoformat(), "fixture": False}

class MockZoneomics(ZoningProvider):
    """FAKE FIXTURE. Deterministic made-up values so the UI/override path can be built before data arrives.
    NOT real zoning. Every value is labelled 'FAKE fixture' and the app shows a FIXTURE badge."""
    name = "mock"
    def lookup(self, site):
        h = int(hashlib.sha1(site["id"].encode()).hexdigest(), 16); st = site.get("view") == "storage"; src = "FAKE fixture (zoneomics mock)"
        d = ["I-1", "I-2", "BP", "M-1"][h % 4] if not st else ["C-2", "C-3", "I-1"][h % 3]
        return {"district": d, "district_name": "FAKE " + d, "permitted_uses": ["warehouse", "data center (conditional)"] if not st else ["self-storage (conditional)", "retail"],
                "dc_use": ["permitted", "conditional", "not listed"][h % 3], "storage_use": ["permitted", "conditional"][h % 2],
                "setbacks_ft": {"front": _f([25, 50, 75][h % 3], src), "side": _f([15, 25, 50][(h >> 3) % 3], src), "rear": _f([20, 30, 50][(h >> 5) % 3], src)},
                "max_height_ft": _f(([45, 60, 75, 100] if not st else [35, 45, 55])[(h >> 7) % (4 if not st else 3)], src),
                "max_lot_coverage_pct": _f([40, 50, 60, 70][(h >> 9) % 4], src), "max_far": _f([0.5, 0.75, 1.0, 1.5][(h >> 11) % 4], src),
                "parking": {"text": "FAKE: 1 per 1,000 sf office + 1 per 4 employees", "per_1000sf": 1.0, "per_building": 40.0 if not st else 6.0},
                "src": src, "fetched": "fixture", "fixture": True}

def build(a):
    P = MockZoneomics() if a.provider == "mock" else ZoneomicsClient()
    d = json.load(open(PUB)); out = {"meta": {"provider": P.name, "fixture": P.name == "mock", "built": datetime.datetime.now().isoformat(timespec="seconds"),
           "handling": "ADMIN-ONLY. Do not commit, share, or add to member-read blobs."}, "sites": {}}
    for o in d["sites"].values():
        if not o.get("geo", {}).get("site"): continue
        try: out["sites"][o["id"]] = P.lookup(o)
        except Exception as e: print("  zoning fail", o["name"][:40], e)
    os.makedirs(os.path.dirname(OUT), exist_ok=True); json.dump(out, open(OUT, "w"), separators=(",", ":"))
    print(f"[zoneomics] {P.name}: {len(out['sites'])} sites -> {os.path.relpath(OUT, HERE)}{' (FAKE FIXTURE)' if P.name == 'mock' else ''}")

def push(a):
    """One admin-only doc per site: zoning/{siteId} = {j: json, h: hash, fixture}. Change-hash skip -> writes only on change."""
    Z = json.load(open(OUT))
    if Z["meta"].get("fixture") and not a.allow_fixture: raise SystemExit("refusing to push FAKE fixture data (pass --allow-fixture for an emulator only)")
    import edks
    c = edks.db(); col = c.collection("zoning"); W = []
    for sid, rec in Z["sites"].items():
        j = json.dumps(rec, separators=(",", ":")); h = hashlib.sha1(j.encode()).hexdigest()[:16]
        old = col.document(sid).get()
        if old.exists and (old.to_dict() or {}).get("h") == h: continue
        W.append((sid, {"j": j, "h": h, "fixture": bool(rec.get("fixture")), "src": rec.get("src", "")}))
    print(f"[zoneomics] {len(Z['sites'])} reads, {len(W)} writes planned")
    if a.apply:
        for sid, v in W: col.document(sid).set(v)
        print("[zoneomics] pushed")
    else: print("[zoneomics] dry run; pass --apply to write (needs approval)")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); sp = ap.add_subparsers(dest="cmd", required=True)
    b = sp.add_parser("build"); b.add_argument("--provider", choices=["mock", "zoneomics"], default="mock")
    p = sp.add_parser("push"); p.add_argument("--apply", action="store_true"); p.add_argument("--allow-fixture", action="store_true")
    a = ap.parse_args(); {"build": build, "push": push}[a.cmd](a)
