"""Map search must not silently drop deals hidden by saved filters (Salina Water Well Rd, Nov 2026)."""
from pathlib import Path
T = (Path(__file__).resolve().parents[1] / "template.html").read_text()

def test_hidden_name_matches_listed():
    assert "function kmaHiddenMatches(" in T
    assert "Hidden by your filters" in T

def test_picked_deal_forced_onto_map():
    assert "kmxAdd(P);const C=mColors(P)" in T
    assert "KMX.add(v+'|'+id);kmQueue()" in T
    assert "function kmaClear(){KMX.clear();" in T

def test_count_reports_filter_hidden():
    assert "hidden by filters" in T
