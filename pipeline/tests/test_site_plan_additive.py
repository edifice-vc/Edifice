"""Adding a deal to Site Plan must be purely additive (t236u): no stage/flag writes, no pipeline filtering, 'Add' wording."""
import os, re
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
T = open(os.path.join(HERE, "template.html"), encoding="utf-8").read()
U = open(os.path.join(HERE, "testfit_ui.js"), encoding="utf-8").read()

def _fn(src, name):
    m = re.search(r"function " + name + r"\(.*", src); assert m, name; return m.group(0)

def test_no_move_wording():
    assert "Move to Site Plan" not in T and "Move to Site Plan" not in U
    assert T.count(">Add to Site Plan</button>") == 2

def test_add_remove_touch_only_local_list():
    for n in ("tfAddDeal", "tfDelDeal", "tfSetList"):
        f = _fn(U, n)
        for bad in ("stage", "archived", "deleted", "hidden", "pOps", "psave", "BK.", "setDoc", "updateDoc"):
            assert bad not in f, (n, bad)

def test_pipeline_views_not_filtered_by_site_plan():
    # tfList/tfInList may only be used by Site Plan itself, dialogs and the badge, never by pipeline/map row filters
    for m in re.finditer(r"tfInList|tfList", T):
        line = T[T.rfind("\n", 0, m.start()) + 1:T.find("\n", m.start())]
        assert line.startswith(("function spDealSec", "function spInB")), line[:80]

def test_badge_in_both_tables():
    assert "spInB('land',s.id)" in T and "spInB('storage',r.id)" in T
