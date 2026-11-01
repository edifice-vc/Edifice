#!/usr/bin/env python3
"""Everstow reference site-plans index (OSI dataset everstow.site_plans).

Sources (private, never committed): records in $SITE_PLANS_PRIVATE (default
/workspace/edifice-sites/private/site_plans/records.json) and page chunks from
$SITE_PLAN_INDEX (default /workspace/site-plan-index/chunks.jsonl).

Firestore design (cost): one doc per plan in `site_plans`; plan + chunk
embeddings stored as compact float16 base64 in the same doc (1 read per plan for
search, no subcollection fan-out); chunk TEXT is not stored, only file/page refs.
Embedding fields are exempt from indexing (firebase/firestore.indexes.json).
Sync = content hash diff against a local state file, writes only changed docs in
one batch, zero reads, no listeners.

  python3 pipeline/site_plans.py build
  python3 pipeline/site_plans.py search "climate two story RV" --min-acres 2 --zoning M-2
  python3 pipeline/site_plans.py sync --dry-run
"""
import argparse, base64, hashlib, json, os, re, sys, math
import numpy as np

PRIV = os.environ.get("SITE_PLANS_PRIVATE", "/workspace/edifice-sites/private/site_plans")
IDX = os.environ.get("SITE_PLAN_INDEX", "/workspace/site-plan-index")
BUILT = os.path.join(PRIV, "built.json")
STATE = os.path.join(PRIV, "sync_state.json")
MODEL = "sentence-transformers/all-MiniLM-L6-v2"
DOC_LIMIT = 900_000  # stay under Firestore 1 MiB doc cap
PLAN_OF = [(re.compile(r"contractor|cg8|olathe", re.I), "cg8-olathe"),
           (re.compile(r"industrial|plaza|topeka|ipe", re.I), "ipe-topeka")]

_m = None
def embed(texts):
    global _m
    try:
        from sentence_transformers import SentenceTransformer
        _m = _m or SentenceTransformer(MODEL)
        return _m.encode(texts, normalize_embeddings=True).astype(np.float32), MODEL, 384
    except ImportError:  # fallback: hashed bag-of-words, 512-d
        out = np.zeros((len(texts), 512), np.float32)
        for i, t in enumerate(texts):
            for w in re.findall(r"[a-z0-9]+", t.lower()):
                out[i, int(hashlib.md5(w.encode()).hexdigest(), 16) % 512] += 1
            n = np.linalg.norm(out[i]); out[i] /= n or 1
        return out, "hashed-bow-512", 512

pack = lambda v: base64.b64encode(np.asarray(v, np.float16).tobytes()).decode()
unpack = lambda s, d: np.frombuffer(base64.b64decode(s), np.float16).reshape(-1, d).astype(np.float32)

def plan_for(path):
    for rx, pid in PLAN_OF:
        if rx.search(path): return pid

def load_chunks():
    p = os.path.join(IDX, "chunks.jsonl")
    if not os.path.exists(p): return []
    return [json.loads(l) for l in open(p) if l.strip()]

def build():
    recs = json.load(open(os.path.join(PRIV, "records.json")))
    chunks = load_chunks()
    docs = {}
    for r in recs:
        spec = " ".join(f"{k}: {r.get(k)}" for k in ("project","location","type","zoning","bay_unit_sizes","doors","parking","setbacks","coverage") if r.get(k))
        mine = [c for c in chunks if plan_for(str(c.get("file", c.get("source", "")))) == r["plan_id"]]
        texts = [r["summary"] + " " + spec] + [c.get("text", "") for c in mine]
        vecs, model, dim = embed(texts)
        d = {k: v for k, v in r.items()}
        d.update(emb_model=model, emb_dim=dim, emb=pack(vecs[0]),
                 chunk_emb=pack(vecs[1:]) if mine else None,
                 chunk_refs=[[c.get("file", c.get("source")), c.get("page")] for c in mine],
                 chunk_count=len(mine))
        d["hash"] = hashlib.sha256(json.dumps(d, sort_keys=True).encode()).hexdigest()[:16]
        docs[r["plan_id"]] = d
    json.dump(docs, open(BUILT, "w"))
    return docs

def search(q, a):
    docs = json.load(open(BUILT)) if os.path.exists(BUILT) else build()
    texts = {}
    for c in load_chunks(): texts[(c.get("file", c.get("source")), c.get("page"))] = c.get("text", "")
    res = []
    for d in docs.values():
        if a.min_acres and (d["acreage"] or 0) < a.min_acres: continue
        if a.max_acres and (d["acreage"] or 1e9) > a.max_acres: continue
        if a.min_sf and (d["building_sf"] or 0) < a.min_sf: continue
        if a.zoning and a.zoning.lower() not in (d["zoning"] or "").lower(): continue
        qv, _, _ = embed([q]) if d["emb_model"] == MODEL or "hashed" in d["emb_model"] else (None,)*3
        best, hit = float(unpack(d["emb"], d["emb_dim"])[0] @ qv[0]), None
        if d.get("chunk_emb"):
            s = unpack(d["chunk_emb"], d["emb_dim"]) @ qv[0]; i = int(s.argmax())
            if s[i] > best: best, hit = float(s[i]), d["chunk_refs"][i]
        res.append((best, d, hit))
    for s, d, hit in sorted(res, key=lambda x: -x[0])[: a.k]:
        print(f"{s:.3f}  {d['project']} | {d['acreage']} ac | {d['building_sf']} SF | {d['zoning']}")
        if hit: print(f"       best page: {hit[0]} p{hit[1]}: {texts.get(tuple(hit), '')[:160]!r}")

def sync(dry):
    docs = build()
    state = json.load(open(STATE)) if os.path.exists(STATE) else {}
    changed = {k: d for k, d in docs.items() if state.get(k) != d["hash"]}
    sizes = {k: len(json.dumps(d)) for k, d in docs.items()}
    for k, s in sizes.items():
        if s > DOC_LIMIT: sys.exit(f"{k} doc {s} B exceeds cap; shard chunk_emb")
    print(json.dumps({"collection": "site_plans", "docs": len(docs), "writes": len(changed),
                      "reads": 0, "batches": 1 if changed else 0, "doc_bytes": sizes,
                      "emb_model": next(iter(docs.values()))["emb_model"]}, indent=1))
    if dry: return
    import firebase_admin; from firebase_admin import firestore
    firebase_admin.initialize_app(options={"projectId": "dms-edvc"})
    db = firestore.client(); b = db.batch()
    for k, d in changed.items(): b.set(db.collection("site_plans").document(k), d)
    b.commit()
    state.update({k: d["hash"] for k, d in changed.items()}); json.dump(state, open(STATE, "w"))

if __name__ == "__main__":
    p = argparse.ArgumentParser(); sp = p.add_subparsers(dest="cmd", required=True)
    sp.add_parser("build")
    s = sp.add_parser("search"); s.add_argument("q"); s.add_argument("-k", type=int, default=5)
    for f in ("min_acres", "max_acres", "min_sf"): s.add_argument("--" + f.replace("_", "-"), type=float)
    s.add_argument("--zoning")
    y = sp.add_parser("sync"); y.add_argument("--dry-run", action="store_true")
    a = p.parse_args()
    if a.cmd == "build": print(len(build()), "docs")
    elif a.cmd == "search": search(a.q, a)
    else: sync(a.dry_run)
