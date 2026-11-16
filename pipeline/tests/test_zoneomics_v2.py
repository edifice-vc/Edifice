"""Synthetic Zoneomics v2 client. Fixtures are made up. No live calls, no real responses."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import zoneomics as Z

KEY = "synthetic-key-not-a-secret"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ZONE = {"data": {
    "meta": {"city_name": "Sample County", "last_updated": "2026-01-01"},
    "zone_details": {"zone_code": "I-2", "zone_name": "Synthetic Industrial"},
    "permitted_land_uses": {"as_of_right": ["warehouse"], "conditional_uses": ["data center"], "prohibited": []},
    "controls": {
        "front_setback_standard": {"standard": {"min_front_yard_ft": "40"}},
        "side_setback_standard": {"standard": {"min_side_yard_ft": "20"}},
        "rear_setback_standard": {"standard": {"min_rear_yard_ft": "15"}},
        "building_height_standard": {"standard": {"max_building_height_ft": "60"}},
        "coverage_standard": {"standard": {"max_coverage": "55"}},
        "far_standard": {"standard": {"max_far": "0.8"}}},
    "parcels": {"apn": "SYNTH-APN-1", "owner_info": {"name": "SYNTH OWNER"}},
    "geom": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}}}

DOC_FIELDS = {
    "zoneDetail": "plu,plu-tags,controls,geom,parcels",
    "flumDetails": "flum,flum_plu,flum_controls,flum_parcel,flum_geom",
}


def _client(tmp, transport, sleep=None):
    return Z.ZoneomicsClient(key=KEY, base="https://example.invalid/v2", transport=transport,
                             cache_dir=str(tmp), sleep=sleep or (lambda _s: None))


def _transport(calls, fail_tiles=False):
    def transport(method, url, params, json_body, timeout):
        params = params or {}
        calls.append({"method": method, "url": url, "fields": params.get("output_fields"), "timeout": timeout,
                      "query_has_key": "api_key" in params})
        assert timeout == 30
        if fail_tiles and url.rstrip("/").endswith("/tiles"):
            raise TimeoutError("timed out " + KEY)
        if params.get("output_fields") == "all":
            return 400, {"content-type": "application/json"}, b'{"error":"bad fields"}'
        if url.endswith("/zoneDetail"):
            body = dict(ZONE, echo=params.get("api_key"))
            return 200, {"content-type": "application/json"}, json.dumps(body).encode()
        if url.endswith("/strDetail"):
            return 502, {"content-type": "application/json"}, json.dumps({"error": "down", "echo": params.get("api_key")}).encode()
        if url.endswith("/zoneScreenshot"):
            return 500, {"content-type": "application/json"}, b'{"error":"no image"}'
        if method == "POST":
            assert "api_key" not in params
            return 200, {"content-type": "application/json"}, json.dumps(
                {"data": {"chat-response": "synthetic answer", "echo": (json_body or {}).get("api_key")}}).encode()
        if url.endswith("/tiles") or url.endswith("/flum/tiles"):
            return 200, {"content-type": "application/vnd.mapbox-vector-tile"}, b"not-geometry-text"
        return 200, {"content-type": "application/json"}, json.dumps(
            {"data": {"synthetic": True, "echo": params.get("api_key")}}).encode()
    return transport


def _site(sid, lat):
    return {"id": sid, "lat": lat, "lng": -95.0}


def test_catalog_lists_documented_gets_and_skips_the_write():
    names = [row[0] for row in Z.V2_CALLS]
    assert names[0] == "zoneDetail"
    assert "request" not in names and "prospect" not in names
    assert len(names) == len(set(names)) == 12
    for _name, _path, slug, _attempts, _kind, _zone in Z.V2_CALLS:
        assert slug
        assert (Z.DOCS + "/" + slug).startswith("https://www.zoneomics.com/api-documentation/")
    rules = open(os.path.join(ROOT, "firebase", "firestore.rules"), encoding="utf-8").read()
    assert "match /raw/{endpoint}" in rules
    assert "NOT deployed" in rules


def test_output_fields_fallback_partial_failure_coverage_and_cache(tmp_path):
    calls = []
    c = _client(tmp_path, _transport(calls))
    rec = c.pull(_site("site-a", 39.0))
    by = {row["endpoint"]: row for row in rec["coverage"]}
    assert set(by) == {row[0] for row in Z.V2_CALLS}
    assert by["zoneDetail"]["status"] == 200 and by["zoneDetail"]["fields"] == DOC_FIELDS["zoneDetail"]
    assert by["flumDetails"]["status"] == 200 and by["flumDetails"]["fields"] == DOC_FIELDS["flumDetails"]
    assert by["conditionalControls"]["status"] == 200 and by["conditionalControls"]["fields"] == ""
    assert by["strDetail"]["status"] == 502
    assert by["zoneScreenshot"]["status"] == 500
    assert by["jurisdictions"]["status"] == 0
    assert rec["district"] == "I-2"
    assert rec["setbacks_ft"]["front"]["v"] == 40
    assert rec["max_height_ft"]["v"] == 60 and rec["max_lot_coverage_pct"]["v"] == 55 and rec["max_far"]["v"] == 0.8
    assert rec["overlays"] is None and rec["screenshot_ok"] is False and rec["geom_ok"] is True
    dumped = json.dumps(rec)
    assert KEY not in dumped and "SYNTH OWNER" not in dumped and "SYNTH-APN-1" not in dumped
    assert "coordinates" not in dumped
    detail = [row for row in calls if row["url"].endswith("/zoneDetail")]
    assert [row["fields"] for row in detail] == ["all", DOC_FIELDS["zoneDetail"]]
    assert all(row["timeout"] == 30 for row in calls)
    assert not any(row["url"].endswith("/jurisdictions") for row in calls)
    ask = [row for row in calls if row["url"].endswith("/ask")]
    assert ask and ask[0]["method"] == "POST" and ask[0]["query_has_key"] is False
    n = len(calls)
    again = c.pull(_site("site-a", 39.0))
    assert len(calls) == n
    assert again["district"] == "I-2" and again["coverage"] == rec["coverage"]
    # A second parcel in the same zone reuses zone-scoped successes and does not re-bill them.
    c.pull(_site("site-b", 39.01))
    parked = [row for row in calls if row["url"].endswith("/parkingDetail")]
    controls = [row for row in calls if row["url"].endswith("/conditionalControls")]
    assert len(parked) == 1
    assert len(controls) == 2  # output_fields=all 400, then the omitted retry, then the zone cache
    blob = ""
    for dirpath, _dirs, files in os.walk(tmp_path):
        for fn in files:
            blob += open(os.path.join(dirpath, fn), encoding="utf-8").read()
    assert KEY not in blob
    assert "not-geometry-text" not in blob


def test_rate_limit_backoff(tmp_path):
    calls, sleeps = [], []
    state = {"n": 0}

    def transport(method, url, params, json_body, timeout):
        state["n"] += 1
        calls.append(url)
        if state["n"] == 1:
            return 429, {"content-type": "application/json", "retry-after": "1.5"}, b"{}"
        return _transport([])(method, url, params, json_body, timeout)

    c = _client(tmp_path, transport, sleep=lambda s: sleeps.append(s))
    rec = c.pull(_site("site-c", 39.2))
    assert sleeps == [1.5]
    assert {row["endpoint"]: row["status"] for row in rec["coverage"]}["zoneDetail"] == 200


def test_transport_error_is_redacted_and_not_cached(tmp_path):
    calls = []
    c = _client(tmp_path, _transport(calls, fail_tiles=True))
    rec = c.pull(_site("site-d", 39.3))
    by = {row["endpoint"]: row for row in rec["coverage"]}
    assert by["tiles"]["status"] == 0 and by["zoneDetail"]["status"] == 200
    assert KEY not in json.dumps(rec)
    n = len(calls)
    c.pull(_site("site-d", 39.3))
    extra = calls[n:]
    assert extra and all(row["url"].rstrip("/").endswith("/tiles") for row in extra)


def test_rules_comment_says_raw_is_not_deployed():
    text = open(os.path.join(ROOT, "firebase", "firestore.rules"), encoding="utf-8").read()
    assert "match /zoning/{id}" in text and "match /raw/{endpoint}" in text
    assert "Sahil" in text
