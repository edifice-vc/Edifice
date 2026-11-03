import os, sys; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import zoning_lookup as Z

def raw(asr=(), cond=(), pro=(), ctl=None):
    return {"status": 200, "fetched": "2026-11-03", "body": {"data": {"meta": {"city_name": "Test Co", "last_updated": "2026-11-01"},
        "zone_details": {"zone_code": "I-2", "zone_name": "Heavy Industrial"},
        "permitted_land_uses": {"as_of_right": list(asr), "conditional_uses": list(cond), "prohibited": list(pro), "industrial_uses_permitted": True},
        "controls": ctl or {"front_setback_standard": {"standard": {"min_front_yard_ft": "50"}}, "side_setback_standard": {"standard": {"min_side_yard_ft": "NA"}, "non-standard": {"minimum_side_yard_ft": "25"}},
                            "rear_setback_standard": {"standard": {"min_rear_yard_ft": "STF"}}, "building_height_standard": {"standard": {"max_building_height_ft": "35"}},
                            "lot_standard": {"non-standard": {"minimum_lot_area_sq_ft": "5 acres"}}}}}}

def test_shape_and_setbacks():
    r = Z.normalize(raw(), 1, 2)
    assert r["status"] == "ok" and r["district"] == "I-2" and r["fixture"] is False
    assert r["setbacks_ft"]["front"]["v"] == 50 and r["setbacks_ft"]["side"]["v"] == 25 and r["setbacks_ft"]["rear"] is None
    assert r["max_height_ft"]["v"] == 35 and r["min_lot_area_sf"]["v"] == 5 * 43560
    assert "Test Co" in r["setbacks_ft"]["front"]["src"]

def test_treatment():
    r = Z.normalize(raw(asr=["Warehousing"], cond=["Data processing centers"], pro=["Mini storage facilities", "Manufactured homes"]))
    assert r["dc_use"] == "conditional" and r["storage_use"] == "prohibited"
    assert r["treatment"]["industrial"]["matches"] == ["Warehousing"]
    r = Z.normalize(raw(asr=["Multiple wide manufactured homes", "Mini warehouses"]))
    assert r["treatment"]["industrial"]["status"] == "not listed" and r["storage_use"] == "permitted"

def test_no_coverage_and_error():
    assert Z.normalize({"status": 200, "body": {"data": {}, "message": ["We don't have coverage at this place"]}})["status"] == "no_coverage"
    assert Z.normalize({"status": 401, "body": {}})["status"] == "error"

def test_cache_no_refetch(tmp_path, monkeypatch):
    monkeypatch.setattr(Z, "CACHE", str(tmp_path)); import json
    (tmp_path / (Z._key(1.0, 2.0) + ".json")).write_text(json.dumps(raw()))
    monkeypatch.delenv("ZONEOMICS_API_KEY", raising=False)
    assert Z.lookup(1.0, 2.0)["district"] == "I-2"          # served from cache with no key, no network
    assert Z.lookup(3.0, 4.0, offline=True) is None
