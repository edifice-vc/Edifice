import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import email_sync as es

ME = ["me@a.com"]
def msg(i, frm, subj, snip="", to="broker@b.com", files=None, date="2026-11-01T21:41:36Z"):
    return {"id": i, "threadId": "t", "from": frm, "to": to, "subject": subj, "snippet": snip, "date": date, "files": files or []}

class T(unittest.TestCase):
  def test_loi_evidence(self):
    assert es.loi_evidence(msg("1", "me@a.com", "LOI - Lot", "Hi Mark, Attached is a letter of intent for the lot")) == "text"
    assert es.loi_evidence(msg("1", "me@a.com", "Offer", "see file", files=["Lot LOI.pdf"])) == "attachment"
    assert es.loi_evidence(msg("1", "me@a.com", "Re: [EXTERNAL] LOI Coming Shortly", "Amazing! Let's get this done!")) == ""
    assert es.loi_evidence(msg("1", "me@a.com", "Re: Dodge City Business Park LOI", "Done On Wed, Oct 28, 2026 Attached is the LOI")) == ""
    assert es.loi_evidence(msg("1", "me@a.com", "LOI", "The LOI will send shortly, draft attached")) == ""

  def test_candidates_outbound_only_and_furthest(self):
    idx = {"s1": {"restricted": False}}
    msgs = {"me@a.com": {"1": msg("1", "Broker <broker@b.com>", "LOI attached", "Attached is the LOI", to="me@a.com"),
                          "2": msg("2", "Me <me@a.com>", "Question", "Hi", date="2026-10-20T00:00:00Z"),
                          "3": msg("3", "Me <me@a.com>", "LOI - Lot", "Attached is our LOI", date="2026-10-25T00:00:00Z"),
                          "4": msg("4", "Me <me@a.com>", "note", "Attached is our LOI", to="me@a.com")}}
    c = es.stage_candidates(idx, ME, msgs, {("me@a.com", "t"): ("s1", ["address"])})
    assert c["s1"]["to_stage"] == "LOI Submitted" and c["s1"]["gmail_id"] == "3"

  def test_contacted_only(self):
    msgs = {"me@a.com": {"2": msg("2", "Me <me@a.com>", "Question", "Hi")}}
    c = es.stage_candidates({"s1": {"restricted": False}}, ME, msgs, {("me@a.com", "t"): ("s1", ["contact"])})
    assert c["s1"]["to_stage"] == "Contacted"
