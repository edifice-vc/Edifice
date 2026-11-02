#!/usr/bin/env python3
"""Admin-only Gmail -> deal email log (dealEmails/{siteId}/items). Headers + a short excerpt only, never bodies.

The box/routine has no Gmail API credentials of its own; it reads mail through the two Gmail connectors and
saves their raw tool output into a private directory (never the repo). This script turns that into deal links.

  1. python3 email_sync.py queries [--backfill-days 90]      -> JSON list of {account, query} Gmail searches
     Run each query with the matching connector's search_emails (all pages) and save every result as
        DIR/<account>__search__<n>.txt
  2. python3 email_sync.py plan --dir DIR                       -> JSON {account: [message ids]} that matched a deal
     For each id: read_email(messageId, messageFormat=RAW, maxChars=20000) on that account's connector, saved as
        DIR/<account>__raw__<id>.txt     (only the headers are parsed: Message-ID, Cc, Date)
  3. python3 email_sync.py ingest --dir DIR [--dry-run]         -> writes items + per-deal summaries, moves the
     cursor, refits the learned weights. Prints counts per deal only.

Dedupe key: <threadId>_<messageId> (same id an in-app send uses, so a later sync merges in the Message-ID).
Sender accounts come from Firestore config/senders (admin-only); no addresses live in this file.
"""
import argparse, datetime as dt, glob, json, os, re, sys
from collections import defaultdict
from email.parser import HeaderParser
from email.utils import getaddresses, parseaddr

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import edks  # noqa: E402

EMAIL_RE = re.compile(r"[\w.+'-]+@[\w-]+(?:\.[\w-]+)+")
QUOTE_RE = re.compile(r"[\"“]([^\"“”\n]{10,120})[\"”]|(?<![A-Za-z])'([^'\n]{10,120})'(?![A-Za-z])")
# Data-center / deal vocabulary for weak (generic-contact) matches.
DC_RE = re.compile(r"data[ -]?cent|hyperscal|\bMW\b|megawatt|substation|transmission|large[- ]load|edifice|"
                   r"industrial|acre|parcel|site|land|property|\bLOI\b|letter of intent|annex|zoning|storage|listing|tract", re.I)
NOISE_RE = re.compile(r"no-?reply|notifications?@|docusign|verification code|password|unsubscribe|newsletter|webinar|calendar-notification", re.I)
FREEMAIL = {"gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "comcast.net", "sbcglobal.net", "att.net", "live.com", "msn.com"}
GENERIC_SITES = 3          # an address seen on >= this many sites is generic (state/utility contacts)
EXCERPT = 240
HINT_GLOB = "/workspace/edifice-stage-moves/*.json"

def utc(s):
    if isinstance(s, dt.datetime):
        return s if s.tzinfo else s.replace(tzinfo=dt.timezone.utc)
    s = str(s or "").replace("Z", "+00:00")
    try:
        d = dt.datetime.fromisoformat(s)
    except ValueError:
        from email.utils import parsedate_to_datetime
        d = parsedate_to_datetime(s)
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)

def senders(client):
    s = client.collection("config").document("senders").get()
    em = [e.lower() for e in ((s.to_dict() or {}).get("emails") or [])] if s.exists else []
    if not em:
        edks.die("config/senders is empty: run `edks.py senders --emails a,b` first")
    return em

def _walk(o, fn):
    if isinstance(o, dict):
        fn(o)
        for v in o.values():
            _walk(v, fn)
    elif isinstance(o, list):
        for v in o:
            _walk(v, fn)

def _strings(o):
    out = []
    def rec(x):
        if isinstance(x, dict):
            for v in x.values(): rec(v)
        elif isinstance(x, list):
            for v in x: rec(v)
        elif isinstance(x, str):
            out.append(x)
    rec(o)
    return out

def _phrases(name, address):
    out = set()
    name = re.sub(r"\s+", " ", name or "")
    for part in re.split(r"[()–\-,]| - ", name):
        p = part.strip().lower()
        if len(p) >= 8 and len(p.split()) >= 2 and not re.fullmatch(r"(industrial|business|commerce) (park|center)", p):
            out.add(p)
    m = re.search(r"\b(\d{2,6})?\s*([A-Za-z0-9 .]{3,40}?\b(?:rd|road|st|street|ave|avenue|hwy|highway|blvd|dr|drive|ln|pkwy))\b", address or "", re.I)
    if m:
        st = m.group(2).strip().lower()
        if len(st) >= 6:
            out.add(st)
    return out

def merge_root(sid, deals):
    """Follow merged_into (only merges made by a person/tool, i.e. with merged_by) to the surviving record."""
    seen = set()
    while sid in deals and deals[sid].get("merged_into") and deals[sid].get("merged_by") and sid not in seen:
        seen.add(sid); sid = deals[sid]["merged_into"]
    return sid

def fold_records(idx, deals):
    """Pure: mail that matches a merged child lands on its parent; deleted/archived records stop matching."""
    out = {sid: x for sid, x in idx.items() if merge_root(sid, deals) == sid}
    for sid, x in idx.items():
        root = merge_root(sid, deals)
        if root != sid and root in out:
            p = out[root]
            for k in ("emails", "names", "subjects", "phrases"):
                p[k] = set(p[k]) | set(x[k])
    return {sid: x for sid, x in out.items() if not (deals.get(sid) or {}).get("deleted") and not (deals.get(sid) or {}).get("archived")}

def deal_index(client):
    """Per deal: contact emails, contact names, subject hints, name/address phrases."""
    mine = set(senders(client))
    deals = {}
    for col, restricted in (("deals", False), ("rdeals", True)):
        for d in client.collection(col).select(["stage", "merged_into", "merged_by", "deleted", "archived"]).stream():
            x = d.to_dict() or {}
            deals[d.id] = {"restricted": restricted, "stage": x.get("stage", "New"), "merged_into": x.get("merged_into"),
                           "merged_by": x.get("merged_by"), "deleted": x.get("deleted"), "archived": x.get("archived")}
    # One collection-group query per event kind (~65 reads) instead of one query per deal (>=215 reads), and
    # one batched get for the site docs instead of 216 sequential gets.
    ev_text = defaultdict(list)
    for grp in ("events", "revents"):
        for e in client.collection_group(grp).select(["text"]).stream():
            ev_text[(grp, e.reference.parent.parent.id)].append((e.to_dict() or {}).get("text") or "")
    refs = [client.collection("rsites" if m["restricted"] else "sites").document(sid) for sid, m in deals.items()]
    site_docs = {}
    for i in range(0, len(refs), 100):
        for s in client.get_all(refs[i:i + 100]):
            site_docs[s.id] = s
    hints = defaultdict(list)
    for f in glob.glob(HINT_GLOB):
        try:
            for e in json.load(open(f)).get("events", []):
                hints[e.get("site_id")].append(e.get("text") or "")
        except Exception:
            pass
    idx = {}
    for sid, meta in deals.items():
        restricted = meta["restricted"]
        s = site_docs.get(sid)
        if s is None or not s.exists:
            continue
        sd = s.to_dict() or {}
        j = sd.get("j") or {}
        if isinstance(j, str):
            try: j = json.loads(j)
            except Exception: j = {}
        emails, names = set(), set()
        def grab(o):
            em = o.get("email")
            if isinstance(em, str) and EMAIL_RE.fullmatch(em.strip()):
                emails.add(em.strip().lower())
                nm = o.get("name")
                if isinstance(nm, str) and 2 <= len(nm.split()) <= 4 and not EMAIL_RE.search(nm):
                    names.add(nm.strip().lower())
        _walk(j, grab)
        for t in _strings(j):
            emails.update(m.lower() for m in EMAIL_RE.findall(t))
        texts = list(hints.get(sid, []))
        texts += ev_text.get(("revents" if restricted else "events", sid), [])
        subj = set()
        if any(t.lstrip().lower().startswith("reverted") for t in texts):
            texts = []   # a reverted mis-match: its event texts describe another deal's mail
        for t in texts:
            emails.update(m.lower() for m in EMAIL_RE.findall(t))
            for q in QUOTE_RE.findall(t):
                q = (q[0] or q[1]).strip().lower()
                if not EMAIL_RE.search(q) and len(q.split()) >= 2:
                    subj.add(q)
        emails = {e for e in emails if e not in mine and not e.endswith(("@example.com", "noreply.com"))}
        idx[sid] = {"name": sd.get("name") or j.get("name") or sid, "city": str(j.get("city") or "").lower().strip(), "view": sd.get("view") or "land", "restricted": restricted,
                    "emails": emails, "names": names, "subjects": subj,
                    "phrases": {ph for ph in _phrases(sd.get("name") or j.get("name"), j.get("address"))
                                if len(ph) >= 8 and ph != str(j.get("city") or "").lower()}}
    idx = fold_records(idx, deals)
    freq = defaultdict(int)
    for x in idx.values():
        for e in x["emails"]:
            freq[e] += 1
    for sid, x in idx.items():
        x["generic"] = {e for e in x["emails"] if freq[e] >= GENERIC_SITES}
        x["active"] = deals[sid]["stage"] not in ("New", "Under Consideration")
    # A New-stage record's local contacts (city utility, EDC) usually write about the active deal in the same city.
    for x in idx.values():
        x["city_contacts"] = set()
        if x["active"] and x["city"]:
            for y in idx.values():
                if y is not x and not y["active"] and y["city"] == x["city"]:
                    x["city_contacts"] |= (y["emails"] - y["generic"])
    for x in idx.values():
        if not x["active"] and any(y["active"] and y["city"] == x["city"] for y in idx.values()):
            x["emails"] -= {e for y in idx.values() if y["active"] for e in y["city_contacts"]}
    return idx

IDX_CACHE = "_deal_index.json"
IDX_MAX_AGE = 3 * 3600

def deal_index_cached(client, d=None):
    """deal_index once per run: queries/plan/ingest of one run share it via DIR/_deal_index.json (<3 h old)."""
    path = os.path.join(d, IDX_CACHE) if d else None
    if path and os.path.exists(path) and (dt.datetime.now().timestamp() - os.path.getmtime(path)) < IDX_MAX_AGE:
        raw = json.load(open(path))
        return {sid: {k: set(v) if isinstance(v, list) else v for k, v in x.items()} for sid, x in raw.items()}
    idx = deal_index(client)
    if path and os.path.isdir(d):
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump({sid: {k: sorted(v) if isinstance(v, set) else v for k, v in x.items()} for sid, x in idx.items()}, f)
        os.chmod(tmp, 0o600); os.replace(tmp, path)
    return idx

def cursor(client):
    s = client.collection("config").document("email_sync").get()
    return (s.to_dict() or {}) if s.exists else {}

def cmd_queries(a):
    client = edks.db()
    idx = deal_index_cached(client, a.dir)
    cur = (cursor(client).get("accounts") or {})
    emails = sorted({e for x in idx.values() for e in x["emails"] - x["generic"]})
    subs = sorted({s for x in idx.values() for s in x["subjects"] | x["phrases"]})
    out = []
    for acct in senders(client):
        last = cur.get(acct, {}).get("last_date")
        since = (utc(last) - dt.timedelta(days=2)) if last and not a.backfill_days else \
                dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=a.backfill_days or 90)
        after = f"after:{int(since.timestamp())}"
        for i in range(0, len(emails), 12):
            ch = emails[i:i + 12]
            out.append({"account": acct, "query": after + " {" + " ".join(f"from:{e} to:{e} cc:{e}" for e in ch) + "}"})
        for i in range(0, len(subs), 6):
            out.append({"account": acct, "query": after + " {" + " ".join(f'subject:"{s}"' for s in subs[i:i + 6]) + "}"})
    print(json.dumps(out, indent=1))

def _load(path):
    t = open(path, encoding="utf-8", errors="replace").read()
    i, k = t.find("{"), t.rfind("}")
    return json.loads(t[i:k + 1]) if i >= 0 else {}

def read_dir(d):
    """{account: {message id: envelope}} merged with RAW headers where present."""
    msgs = defaultdict(dict)
    raws = {}
    for f in sorted(glob.glob(os.path.join(d, "*__*__*.txt"))):
        acct, kind, _ = os.path.basename(f).split("__", 2)
        j = _load(f)
        if kind == "search":
            for m in j.get("messages", []):
                msgs[acct][m["id"]] = dict(m)
        elif kind == "raw" and j.get("raw"):
            head = j["raw"].split("\r\n\r\n", 1)[0].split("\n\n", 1)[0]
            h = HeaderParser().parsestr(head + "\r\n\r\n")
            fn = [f.strip().strip('"') for f in re.findall(r'filename\*?=(?:utf-8\'\')?("[^"]+"|[^;\s]+)', j["raw"], re.I)]
            raws[(acct, j["id"])] = {"files": fn, "rfc_id": (h.get("Message-ID") or h.get("Message-Id") or "").strip(),
                                    "cc": h.get("Cc") or "", "from_h": h.get("From") or "", "to_h": h.get("To") or "",
                                    "subject_h": h.get("Subject") or "", "threadId": j.get("threadId")}
    for (acct, mid), r in raws.items():
        m = msgs[acct].setdefault(mid, {"id": mid, "threadId": r["threadId"]})
        m["rfc_id"] = r["rfc_id"]; m["files"] = r["files"]; m["cc"] = m.get("cc") or r["cc"]
        m.setdefault("from", r["from_h"]); m.setdefault("to", r["to_h"]); m.setdefault("subject", r["subject_h"])
    return msgs

def _addrs(*fields):
    return {e.lower() for _, e in getaddresses([f or "" for f in fields]) if e and "@" in e}

def match(idx, mine, msgs):
    """Assign threads to deals. Returns {(acct, threadId): (sid, matched_by)} plus ambiguity count."""
    by_thread = defaultdict(list)
    for acct, ms in msgs.items():
        for m in ms.values():
            by_thread[(acct, m.get("threadId") or m["id"])].append(m)
    out, amb = {}, 0
    for key, ms in by_thread.items():
        best = {}
        ms = [m for m in ms if not NOISE_RE.search((m.get("from") or "") + " " + (m.get("subject") or ""))]
        if not ms:
            continue
        for sid, x in idx.items():
            sig = {}
            spec_dom = {e.split("@")[1] for e in x["emails"] - x["generic"]} - FREEMAIL
            for m in ms:
                ppl = _addrs(m.get("from"), m.get("to"), m.get("cc")) - set(mine)
                subj = (m.get("subject") or "").lower()
                text = subj + " " + (m.get("snippet") or "").lower()
                if ppl & (x["emails"] - x["generic"]): sig["contact"] = 3
                elif {e.split("@")[1] for e in ppl} & spec_dom: sig.setdefault("contact_domain", 2)
                elif ppl & x["city_contacts"]: sig.setdefault("contact_city", 3)
                if ppl & x["generic"] and DC_RE.search(text): sig.setdefault("contact_generic", 1)
                fromname = parseaddr(m.get("from") or "")[0].lower().strip('"\' ')
                if fromname and fromname in x["names"]: sig["name"] = 2
                if any(h in subj for h in x["subjects"]): sig["subject"] = 4
                if any(p in subj for p in x["phrases"]):
                    sig["address"] = 2
                    # Sahil's own mail naming the deal (name/address) in the subject next to deal vocabulary
                    # ("LOI - Industrial Plaza East Lot") is a strong signal even to a broker not yet on file.
                    if parseaddr(m.get("from") or "")[1].lower() in mine and DC_RE.search(subj):
                        sig["sent_subject"] = 1
                elif any(p in text for p in x["phrases"]): sig.setdefault("address", 1)
                if x["city"] and re.search(r"\b" + re.escape(x["city"]) + r"\b", subj): sig["city"] = 1
            score = sum(sig.values())
            weak = not (set(sig) - {"city", "address", "contact_generic", "sent_subject"})
            if weak and not (sig.get("address") == 2 and any(DC_RE.search((m.get("subject") or "")) for m in ms)):
                continue
            if score >= 3:
                best[sid] = (score, set(k.split("_")[0] if k not in ("address", "sent_subject") else k for k in sig))
        if not best:
            continue
        ranked = sorted(best.items(), key=lambda kv: (-idx[kv[0]]["active"], -kv[1][0]))
        if len(ranked) > 1 and (idx[ranked[0][0]]["active"], ranked[0][1][0]) == (idx[ranked[1][0]]["active"], ranked[1][1][0]):
            amb += 1
            continue
        sid, (sc, why) = ranked[0]
        out[key] = (sid, sorted(why))
    return out, amb

def cmd_plan(a):
    client = edks.db()
    idx, mine = deal_index_cached(client, a.dir), senders(client)
    msgs = read_dir(a.dir)
    m, amb = match(idx, mine, msgs)
    need = defaultdict(list)
    for (acct, tid), _ in m.items():
        for mm in msgs[acct].values():
            if (mm.get("threadId") or mm["id"]) == tid and not mm.get("rfc_id"):
                need[acct].append(mm["id"])
    print(json.dumps({"need_raw": need, "threads_matched": len(m), "ambiguous_skipped": amb}, indent=1))

def cmd_ingest(a):
    client = edks.db()
    idx, mine = deal_index_cached(client, a.dir), senders(client)
    msgs = read_dir(a.dir)
    m, amb = match(idx, mine, msgs)
    now = dt.datetime.now(dt.timezone.utc)
    per = defaultdict(lambda: {"new": 0, "seen": 0, "no_rfc": 0})
    todo = []   # (sid, ref, item)
    for (acct, tid), (sid, why) in sorted(m.items()):
        col = client.collection("dealEmails").document(sid).collection("items")
        for mm in msgs[acct].values():
            if (mm.get("threadId") or mm["id"]) != tid:
                continue
            frm = parseaddr(mm.get("from") or "")[1].lower()
            item = {"site_id": sid, "date": utc(mm.get("date")).isoformat(), "account": acct, "from": mm.get("from") or "",
                    "to": mm.get("to") or "", "cc": mm.get("cc") or "", "subject": (mm.get("subject") or "")[:300],
                    "excerpt": re.sub(r"\s+", " ", mm.get("snippet") or "")[:EXCERPT],
                    "link": f"https://mail.google.com/mail/u/?authuser={acct}#all/{tid}", "thread_id": tid,
                    "message_id": mm["id"], "rfc_id": (mm.get("rfc_id") or "")[:300], "dir": "out" if frm in mine else "in",
                    "source": "sync", "matched_by": why}
            todo.append((sid, col.document(f"{tid}_{mm['id']}"), item))
    # One batched existence check (get_all) and one batched commit instead of a get + set per message.
    have = {}
    refs = [r for _, r, _ in todo]
    for k in range(0, len(refs), 100):
        for snap in client.get_all(refs[k:k + 100]):
            have[snap.reference.path] = snap
    writes, changed = [], set()
    for sid, ref, item in todo:
        if not item["rfc_id"]:
            per[sid]["no_rfc"] += 1
        ex = have.get(ref.path)
        if ex is not None and ex.exists:
            per[sid]["seen"] += 1
            old = ex.to_dict() or {}
            patch = {k: v for k, v in item.items() if k in ("rfc_id", "cc", "excerpt", "matched_by") and v and not old.get(k)}
            if patch:
                writes.append((ref, patch, True)); changed.add(sid)
        else:
            per[sid]["new"] += 1
            writes.append((ref, dict(item, created=now), False)); changed.add(sid)
    if not a.dry_run:
        for k in range(0, len(writes), 400):
            b = client.batch()
            for ref, data, merge in writes[k:k + 400]:
                b.set(ref, data, merge=merge)
            b.commit()
        for sid in changed:      # unchanged deals keep their summary: no re-read of their items
            summarize(client, sid, now)
        # Cursor: advance each searched account to the newest message this run saw in its search results
        # (matched or not), so the next run's after: window starts here. It used to move only on matched mail,
        # which left it days behind when nothing new matched.
        seen = {}
        for acct, ms in msgs.items():
            for mm in ms.values():
                try:
                    d = utc(mm.get("date"))
                except Exception:
                    continue
                if d <= now and (acct not in seen or d > seen[acct]):
                    seen[acct] = d
        cur = cursor(client).get("accounts") or {}
        for acct in mine:
            prev = cur.get(acct, {}).get("last_date")
            best = max([x for x in (seen.get(acct), utc(prev) if prev else None) if x], default=None)
            cur[acct] = {"last_date": best.isoformat() if best else (prev or ""), "last_run": now.isoformat(),
                         "last_dir": os.path.basename(os.path.normpath(a.dir))}
        client.collection("config").document("email_sync").set({"accounts": cur, "updated": now})
        if changed:              # weights depend on deal emails only through new items; skip the refit otherwise
            try:
                import learnings
                learnings.recompute(client, quiet=True)
            except Exception as ex:
                print(f"[email_sync] WARNING: weights not refit ({type(ex).__name__})")
    if not a.no_stages:
        run_stage_moves(client, idx, mine, msgs, m, a.dry_run)
    tot = {k: sum(v[k] for v in per.values()) for k in ("new", "seen", "no_rfc")}
    print(f"[email_sync] {'DRY RUN ' if a.dry_run else ''}threads={len(m)} ambiguous_skipped={amb} "
          f"new={tot['new']} already={tot['seen']} missing_message_id={tot['no_rfc']}")
    for sid in sorted(per):
        print(f"[email_sync]   {sid}\tnew={per[sid]['new']}\talready={per[sid]['seen']}")
    if not a.dry_run:
        print("[email_sync] cursor " + ", ".join(f"{k}={v['last_date']}" for k, v in sorted(cur.items())))

# ------------------------------------------------------------------ automatic stage moves from Sahil's sent mail
# Evidence = a message FROM one of the sender accounts (config/senders) to someone else, in a thread the matcher
# tied to the deal. Forward-only: New / Under Consideration / Reviewing -> Contacted, or -> LOI Submitted when the
# message carries an LOI (attachment name) or says one is attached/enclosed/submitted. Never past LOI Submitted,
# never Passed/On Hold, never backwards, and never over a stage event dated after the evidence email.
AUTO_FROM = ("New", "Under Consideration", "Reviewing", "", None)
AUTO_SOURCE = "email-auto"
LOI_WORD = r"(?:\bLOI\b|\bletter of intent\b)"
LOI_FILE_RE = re.compile(r"\bLOI\b|letter[ _-]?of[ _-]?intent", re.I)
LOI_SAYS_RE = re.compile(r"(?:attached|attaching|enclosed|please find|here is|submitted|submitting|sending)[^.?!]{0,80}?" + LOI_WORD
                         + r"|" + LOI_WORD + r"[^.?!]{0,40}?\b(?:is |are )?(?:attached|enclosed|submitted)", re.I)
LOI_NOT_RE = re.compile(r"coming shortly|will (?:send|submit)|draft|recall|counter", re.I)

def loi_evidence(m):
    """'attachment' / 'text' when this sent message carries or announces an LOI, else ''."""
    if any(LOI_FILE_RE.search(f or "") for f in m.get("files") or []):
        return "attachment"
    text = re.sub(r"&#39;", "'", (m.get("subject") or "") + ". " + (m.get("snippet") or ""))
    body = re.split(r"\bOn (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,", m.get("snippet") or "")[0]   # drop quoted reply
    said = LOI_SAYS_RE.search(re.sub(r"&#39;", "'", body))
    if said and not LOI_NOT_RE.search(said.group(0)):
        return "text"
    return ""

def stage_candidates(idx, mine, msgs, matched):
    """{sid: best move} from matched threads; one move per deal (the furthest target, earliest email reaching it)."""
    best = {}
    for (acct, tid), (sid, why) in matched.items():
        for mm in msgs[acct].values():
            if (mm.get("threadId") or mm["id"]) != tid:
                continue
            frm = parseaddr(mm.get("from") or "")[1].lower()
            if frm not in mine:
                continue                                     # inbound mail alone never moves a deal
            if not (_addrs(mm.get("to"), mm.get("cc")) - set(mine)):
                continue                                     # note-to-self
            try:
                when = utc(mm.get("date"))
            except Exception:
                continue
            ev = loi_evidence(mm)
            to = "LOI Submitted" if ev else "Contacted"
            c = {"site_id": sid, "to_stage": to, "date": when, "account": acct, "gmail_id": mm["id"], "thread_id": tid,
                 "subject": (mm.get("subject") or "")[:200], "evidence": ev or "sent", "matched_by": why}
            o = best.get(sid)
            if o is None or edks.STAGES.index(to) > edks.STAGES.index(o["to_stage"]) or \
               (to == o["to_stage"] and when < o["date"]):
                best[sid] = c
    return best

def plan_stage_moves(client, idx, cands):
    """Check each candidate against the live deal doc and its latest stage event (reads: 1 + stage events per
    candidate deal, batched). Returns (moves, skips)."""
    moves, skips = [], []
    refs = {sid: client.collection("rdeals" if idx[sid]["restricted"] else "deals").document(sid) for sid in cands}
    snaps = {}
    lst = list(refs.values())
    for k in range(0, len(lst), 100):
        for s in client.get_all(lst[k:k + 100]):
            snaps[s.reference.parent.id + "/" + s.id] = s
    for sid, c in sorted(cands.items()):
        x = idx[sid]; ref = refs[sid]; ecol = "revents" if x["restricted"] else "events"
        snap = snaps.get(ref.parent.id + "/" + sid)
        cur = ((snap.to_dict() or {}).get("stage") if snap is not None and snap.exists else None) or "New"
        row = dict(c, name=x["name"], view=x["view"], restricted=x["restricted"], from_stage=cur)
        if cur not in AUTO_FROM and edks.STAGES.index(cur) >= edks.STAGES.index(c["to_stage"]):
            skips.append(dict(row, why=f"already at {cur}")); continue
        evs = [e.to_dict() or {} for e in ref.collection(ecol).where("type", "==", "stage").stream()]
        if any(e.get("event_id") == "ea" + c["gmail_id"] or e.get("gmail_id") == c["gmail_id"] for e in evs):
            skips.append(dict(row, why="already recorded")); continue
        later = [e for e in evs if str(e.get("ts") or "") > c["date"].isoformat()]
        if later:
            skips.append(dict(row, why=f"stage set later by {later[-1].get('by') or '?'} ({str(later[-1].get('ts'))[:10]})")); continue
        moves.append(row)
    return moves, skips

def apply_stage_moves(client, moves):
    """One batch: deal doc stage + stage event (same shape as an app move) + reviewQueue item already answered."""
    now = dt.datetime.now(dt.timezone.utc)
    b = client.batch(); n = 0
    for mv in moves:
        r = mv["restricted"]; dref = client.collection("rdeals" if r else "deals").document(mv["site_id"])
        eid = "ea" + mv["gmail_id"]; ts = mv["date"].isoformat().replace("+00:00", "Z")
        text = (f"Auto from email ({mv['date'].date().isoformat()}): “{mv['subject'][:120]}”"
                + (" · LOI " + mv["evidence"] if mv["to_stage"] == "LOI Submitted" else ""))
        e = {"event_id": eid, "site_id": mv["site_id"], "view": mv["view"], "name": mv["name"], "type": "stage", "ts": ts,
             "from_stage": mv["from_stage"], "to_stage": mv["to_stage"], "reasons": [], "text": text, "by": AUTO_SOURCE,
             "source": AUTO_SOURCE, "gmail_id": mv["gmail_id"], "thread_id": mv["thread_id"], "account": mv["account"],
             "email_date": ts, "evidence": mv["evidence"]}
        b.set(dref, {"site_id": mv["site_id"], "view": mv["view"], "name": mv["name"], "stage": mv["to_stage"],
                     "updated": now, "updated_by": AUTO_SOURCE}, merge=True)
        b.set(dref.collection("revents" if r else "events").document(eid), e)
        b.set(client.collection("reviewQueue").document(eid), {
            "event_id": eid, "site_id": mv["site_id"], "view": mv["view"], "name": mv["name"],
            "track": edks.track_of(mv["view"]), "from_stage": mv["from_stage"], "to_stage": mv["to_stage"], "who": AUTO_SOURCE,
            "reasons": [], "text": text, "ts": ts, "status": "answered", "answer": "email evidence", "answer_reasons": [],
            "answered_by": AUTO_SOURCE, "source": AUTO_SOURCE, "gmail_id": mv["gmail_id"], "restricted": bool(r),
            "created": now, "answered_at": now})
        n += 3
        if n >= 450:
            b.commit(); b = client.batch(); n = 0
    if n:
        b.commit()

def report_stage_moves(moves, skips, dry):
    tag = "DRY RUN " if dry else ""
    for mv in moves:
        print(f"[email_sync] {tag}stage {mv['site_id']}\t{mv['name']}\t{mv['from_stage']} -> {mv['to_stage']}\t"
              f"{mv['date'].date().isoformat()}\t{mv['evidence']}\t“{mv['subject'][:90]}”{' (admin-only)' if mv['restricted'] else ''}")
    for s in skips:
        print(f"[email_sync] {tag}skip  {s['site_id']}\t{s['name']}\t{s['from_stage']} -/-> {s['to_stage']}\t{s['date'].date().isoformat()}\t{s['why']}\t“{s['subject'][:90]}”")
    print(f"[email_sync] {tag}stage moves={len(moves)} skipped={len(skips)}")

def run_stage_moves(client, idx, mine, msgs, matched, dry):
    moves, skips = plan_stage_moves(client, idx, stage_candidates(idx, mine, msgs, matched))
    if not dry and moves:
        apply_stage_moves(client, moves)
        if any(not mv["restricted"] for mv in moves):
            try:
                import learnings
                learnings.recompute(client, quiet=True)
            except Exception as ex:
                print(f"[email_sync] WARNING: weights not refit ({type(ex).__name__})")
    report_stage_moves(moves, skips, dry)
    return moves, skips

def cmd_stages(a):
    """Backfill: scan every private run dir (or --dir ones) and apply the same stage rules. Dry run unless --apply."""
    client = edks.db(); mine = senders(client)
    dirs = a.dir or sorted(glob.glob(os.path.join(a.root, "*/")))
    idx = deal_index(client)       # one fresh index; older run dirs' caches may predate merges
    msgs = defaultdict(dict)
    for d in dirs:
        for acct, ms in read_dir(d).items():
            for mid, m in ms.items():
                o = msgs[acct].get(mid) or {}
                msgs[acct][mid] = dict(o, **{k: v for k, v in m.items() if v})
    matched, amb = match(idx, mine, msgs)
    print(f"[email_sync] scanned {len(dirs)} run dir(s), threads matched={len(matched)} ambiguous_skipped={amb}")
    run_stage_moves(client, idx, mine, msgs, matched, not a.apply)

def summarize(client, sid, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    items = [d.to_dict() or {} for d in client.collection("dealEmails").document(sid).collection("items").stream()]
    if not items:
        return
    items.sort(key=lambda x: str(x.get("date")))
    ins = [x for x in items if x.get("dir") == "in"]; outs = [x for x in items if x.get("dir") == "out"]
    threads = {x.get("thread_id") for x in items}
    last = items[-1]
    lt = utc(last["date"]); quiet = (now - lt).days
    awaiting = last.get("dir") == "in"
    acc = defaultdict(int)
    for x in items:
        acc[x.get("account", "")] += 1
    text = (f"{len(items)} emails in {len(threads)} thread(s): {len(ins)} received, {len(outs)} sent. "
            f"Last contact {lt.date().isoformat()} ({quiet} days ago, {'from them - awaiting your reply' if awaiting else 'from you'}). "
            f"Latest: “{(last.get('subject') or '')[:90]}”.")
    ref = client.collection("dealEmails").document(sid)
    ref.set({"site_id": sid, "last_touch": lt, "last_out": utc(outs[-1]["date"]) if outs else None,
             "last_account": last.get("account", ""), "updated_by": "email_sync", "threads": len(threads),
             "counts": {"in": len(ins), "out": len(outs), "total": len(items), "by_account": dict(acc)},
             "summary": {"text": text, "last_in": ins[-1]["date"] if ins else "", "days_quiet": quiet,
                         "awaiting_reply": awaiting, "last_subject": (last.get("subject") or "")[:200]},
             "updated": now}, merge=True)

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = p.add_subparsers(dest="cmd", required=True)
    q = sp.add_parser("queries"); q.add_argument("--backfill-days", type=int, default=0); q.add_argument("--dir", help="run dir: caches the deal index for plan/ingest")
    pl = sp.add_parser("plan"); pl.add_argument("--dir", required=True)
    i = sp.add_parser("ingest"); i.add_argument("--dir", required=True); i.add_argument("--dry-run", action="store_true")
    i.add_argument("--no-stages", action="store_true", help="skip the automatic stage moves from sent mail")
    st = sp.add_parser("stages", help="backfill stage moves from saved run dirs (dry run unless --apply)")
    st.add_argument("--dir", action="append", help="run dir (repeatable); default: every dir under --root")
    st.add_argument("--root", default="/workspace/edifice-sites/private/email_sync"); st.add_argument("--apply", action="store_true")
    s = sp.add_parser("summarize"); s.add_argument("site_ids", nargs="*")
    a = p.parse_args()
    if a.cmd == "summarize":
        c = edks.db()
        for sid in a.site_ids or [d.id for d in c.collection("dealEmails").stream()]:
            summarize(c, sid)
        print("[email_sync] summaries refreshed"); return
    {"queries": cmd_queries, "plan": cmd_plan, "ingest": cmd_ingest, "stages": cmd_stages}[a.cmd](a)

if __name__ == "__main__":
    main()
