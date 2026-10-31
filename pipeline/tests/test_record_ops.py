import argparse, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import email_sync, edks

def _x(e): return {"emails": {e}, "names": set(), "subjects": set(), "phrases": set()}

def test_fold_merged_child_into_parent():
    idx = {"p": _x("p@a.com"), "c": _x("c@a.com"), "legacy": _x("l@a.com"), "gone": _x("g@a.com")}
    deals = {"c": {"merged_into": "p", "merged_by": "sahil"}, "legacy": {"merged_into": "p"}, "gone": {"deleted": True}}
    out = email_sync.fold_records(idx, deals)
    assert set(out) == {"p", "legacy"}
    assert out["p"]["emails"] == {"p@a.com", "c@a.com"}

def test_merge_chain_and_cycle():
    deals = {"a": {"merged_into": "b", "merged_by": "x"}, "b": {"merged_into": "c", "merged_by": "x"}, "c": {}}
    assert email_sync.merge_root("a", deals) == "c"
    cyc = {"a": {"merged_into": "b", "merged_by": "x"}, "b": {"merged_into": "a", "merged_by": "x"}}
    assert email_sync.merge_root("a", cyc) in ("a", "b")

def test_bulk_fields():
    a = argparse.Namespace(owner="Sahil", contact=None, add_tags="x, y", remove_tags="old", score_override=None, clear_score_override=True)
    assert edks.bulk_fields({"tags": ["old", "x"], "score_override": 5}, a) == {"assignee": "Sahil", "tags": ["x", "y"]}

def test_plan_merge():
    r = lambda i: {"id": i, "name": i.upper(), "view": "land", "d": {"stage": "New"}}
    ops = edks.plan_merge(r("p"), [r("c1"), r("c2")], "sahil", "t")
    assert ops[0][2]["type"] == "merge" and ops[0][2]["children"] == ["c1", "c2"]
    assert all(u == {"merged_into": "p", "merged_by": "sahil", "merged_at": "t"} for _, u, _ in ops[1:])

import unittest
class RecordOps(unittest.TestCase):
    def test_all(self):
        test_fold_merged_child_into_parent(); test_merge_chain_and_cycle(); test_bulk_fields(); test_plan_merge()
