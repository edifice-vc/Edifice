"""parcels.py pure helpers on synthetic geometry (no network, no real parcel data)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import parcels as P

LAT, LON = 38.0, -97.0
def sq(cx, cy, h):  # square of half-size h metres centred at (cx, cy) metres from the pin, as GeoJSON lon/lat
    from shapely.geometry import box
    return P.to_ll(box(cx - h, cy - h, cx + h, cy + h), LAT, LON)

def feat(g, apn, owner=None):
    return {"type": "Feature", "geometry": g, "properties": {"PID": apn, "OWN": owner}}

FM = {"apn": ["PID"], "owner": ["OWN"], "acres": []}

def test_deal_is_smallest_containing_and_neighbours_capped_by_radius():
    feats = [feat(sq(0, 0, 500), "BIG"), feat(sq(0, 0, 50), "DEAL", "Acme"), feat(sq(200, 0, 40), "N1"), feat(sq(2000, 0, 40), "FAR")]
    r = P.assemble(LAT, LON, feats, FM, "county:Test", 402, 150)
    assert r["deal"]["apn"] == "DEAL" and r["deal"]["owner"] == "Acme"
    nb = [n["apn"] for n in r["neighbors"]]
    assert "N1" in nb and "BIG" in nb and "FAR" not in nb and "DEAL" not in nb
    assert abs(r["deal"]["acres"] - 10000 / 4046.86) < 0.1   # computed area fallback

def test_snap_to_nearest_and_miss():
    assert P.assemble(LAT, LON, [feat(sq(80, 0, 40), "NEAR")], FM, "s", 402, 150)["deal"]["apn"] == "NEAR"
    assert P.assemble(LAT, LON, [feat(sq(900, 0, 40), "X")], FM, "s", 402, 150) is None

def test_max_neighbors_nearest_first():
    feats = [feat(sq(0, 0, 10), "D")] + [feat(sq(30 * i, 100, 10), f"n{i}") for i in range(1, 9)]
    r = P.assemble(LAT, LON, feats, FM, "s", 402, 3)
    assert [n["apn"] for n in r["neighbors"]] == ["n1", "n2", "n3"]

def test_doc_hash_stable():
    rec = {"src": "s", "deal": {"apn": "1"}, "neighbors": [], "radius_m": 402, "county": "T", "extra": 1}
    assert P.doc_of(rec) == P.doc_of(dict(rec, extra=2))


def test_wyandotte_geary_sources_registered():
    import parcels
    assert "wycokck.org" in parcels.COUNTY["Wyandotte"]["url"]
    assert parcels.COUNTY["Geary"]["owner"] == ["OWNERNAME"]
