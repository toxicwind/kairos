#!/usr/bin/env python3
"""
Sovereign AST-BM25 Racer — LOCAL-HEAVY edition (Forge, 2026-09-29).

Adapted from the skill doc per Chris's direction: Dropbox sync REMOVED.
All artifacts stay local: ~/workspace/.tmpdir run dir + ~/workspace deliverables.
No network calls, no cloud mounts, no dropbox:create_file.

Pipeline:
  1. AST symbol index (stdlib `ast` for Python; regex for TS/JS)
  2. BM25 ranking over file documents
  3. Hybrid score: S_hybrid = (S_BM25 + eps) * (1 + a*sym + b*async + c*centrality)
  4. CodeRacer with perf_counter_ns + GC isolation, warmup passes
  5. Local artifact export (JSON) — never Dropbox.

Usage:
  python3 ast_bm25_racer.py --root /path/to/repo --query "gate retire agent-browser" --top-k 10
  python3 ast_bm25_racer.py --root /path/to/repo --race  # benchmark only
"""
import ast
import gc
import json
import math
import os
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

# ---- Step 1: AST symbol extraction (local, zero-dependency) ----

PY_EXTS = {".py"}
TS_EXTS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}

# TS/JS patterns: class X, function foo(, async function, const foo = ( / =>
TS_CLASS_RE = re.compile(r"^\s*(?:export\s+)?(?:default\s+)?class\s+(\w+)", re.M)
TS_FUNC_RE = re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)", re.M)
TS_ARROW_RE = re.compile(r"^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(", re.M)
TS_IMPORT_RE = re.compile(r"""^\s*import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]""", re.M)
TS_REQUIRE_RE = re.compile(r"""require\(\s*['"]([^'"]+)['"]\s*\)""")

TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def extract_py_symbols(path: Path):
    """Return (symbols, imports, async_count) via stdlib ast. Never raises."""
    try:
        src = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return [], [], 0
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return [], [], 0
    symbols, imports, async_count = [], [], 0
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            symbols.append(node.name)
        elif isinstance(node, ast.FunctionDef):
            symbols.append(node.name)
        elif isinstance(node, ast.AsyncFunctionDef):
            symbols.append(node.name)
            async_count += 1
        elif isinstance(node, ast.Import):
            for a in node.names:
                imports.append(a.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                imports.append(node.module.split(".")[0])
    return symbols, imports, async_count


def extract_ts_symbols(path: Path):
    try:
        src = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return [], [], 0
    symbols = TS_CLASS_RE.findall(src) + TS_FUNC_RE.findall(src) + TS_ARROW_RE.findall(src)
    imports = TS_IMPORT_RE.findall(src) + TS_REQUIRE_RE.findall(src)
    async_count = len(re.findall(r"\basync\s+(?:function|def|\(|const|\w+\s*\()", src))
    return symbols, imports, async_count


def tokenize(text: str):
    # split camelCase / snake_case into sub-tokens for better recall
    toks = []
    for raw in TOKEN_RE.findall(text):
        toks.append(raw.lower())
        parts = re.split(r"(?=[A-Z])", raw)
        for p in parts:
            p = p.strip("_").lower()
            if p and p != raw.lower():
                toks.append(p)
        for p in raw.split("_"):
            p = p.lower()
            if p and p != raw.lower():
                toks.append(p)
    return toks


class RepoIndex:
    def __init__(self, root: Path):
        self.root = root
        self.docs = []          # list of dicts
        self.doc_terms = []     # list of Counter
        self.df = Counter()
        self.n = 0
        self.avgdl = 0.0
        self.import_graph = defaultdict(set)  # file -> imported modules
        self.incoming = Counter()             # module -> incoming degree

    def build(self, max_files=60000):
        files = []
        for ext in PY_EXTS | TS_EXTS:
            files.extend(self.root.rglob(f"*{ext}"))
        # skip noise dirs
        skip = {"node_modules", ".git", "__pycache__", ".venv", "dist", "build"}
        files = [f for f in files if not any(s in f.parts for s in skip)]
        files = files[:max_files]
        total_len = 0
        for f in files:
            rel = str(f.relative_to(self.root))
            if f.suffix in PY_EXTS:
                symbols, imports, acount = extract_py_symbols(f)
            else:
                symbols, imports, acount = extract_ts_symbols(f)
            try:
                text = f.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                text = ""
            # document = path tokens + symbol tokens + body tokens (capped)
            terms = tokenize(rel) + tokenize(" ".join(symbols)) * 3 + tokenize(text[:20000])
            tf = Counter(terms)
            self.docs.append({
                "path": rel, "symbols": symbols, "imports": imports,
                "async_count": acount, "dl": sum(tf.values()),
            })
            self.doc_terms.append(tf)
            for t in tf:
                self.df[t] += 1
            self.import_graph[rel] = set(imports)
            total_len += sum(tf.values())
        self.n = len(self.docs)
        self.avgdl = (total_len / self.n) if self.n else 0.0
        # incoming centrality: count how many files import a module name
        mod_to_files = defaultdict(list)
        for d in self.docs:
            stem = Path(d["path"]).stem.lower()
            mod_to_files[stem].append(d["path"])
        for d in self.docs:
            for imp in d["imports"]:
                self.incoming[imp.lower()] += 1
        # per-doc centrality = max incoming over its own stem + symbol count norm
        for d in self.docs:
            stem = Path(d["path"]).stem.lower()
            d["centrality"] = self.incoming.get(stem, 0)

    # ---- Step 2: BM25 ----
    def bm25(self, query_terms, k1=1.2, b=0.75):
        scores = [0.0] * self.n
        for t in set(query_terms):
            df = self.df.get(t, 0)
            if not df:
                continue
            idf = math.log(1 + (self.n - df + 0.5) / (df + 0.5))
            for i, tf in enumerate(self.doc_terms):
                f = tf.get(t, 0)
                if not f:
                    continue
                dl = self.docs[i]["dl"] or 1
                denom = f + k1 * (1 - b + b * dl / (self.avgdl or 1))
                scores[i] += idf * f * (k1 + 1) / denom
        return scores

    # ---- Step 3: hybrid retrieval ----
    def hybrid_search(self, query, top_k=10, alpha=0.6, beta=0.4, gamma=0.15, eps=1e-6):
        qterms = tokenize(query)
        qset = set(qterms)
        base = self.bm25(qterms)
        max_cent = max((d["centrality"] for d in self.docs), default=1) or 1
        ranked = []
        for i, d in enumerate(self.docs):
            sym_match = sum(1 for s in d["symbols"] if s.lower() in qset or any(q in s.lower() for q in qset))
            sym_norm = min(sym_match / 5.0, 1.0)
            async_norm = min(d["async_count"] / 3.0, 1.0) if any(
                q in ("async", "coroutine", "await") for q in qset) else 0.0
            cent_norm = d["centrality"] / max_cent
            s_hybrid = (base[i] + eps) * (1 + alpha * sym_norm + beta * async_norm + gamma * cent_norm)
            ranked.append((s_hybrid, base[i], d))
        ranked.sort(key=lambda r: r[0], reverse=True)
        return [
            {"path": d["path"], "hybrid": h, "bm25": b,
             "symbols": d["symbols"][:12], "async_count": d["async_count"],
             "centrality": d["centrality"]}
            for h, b, d in ranked[:top_k]
        ]


# ---- Step 4: nanosecond CodeRacer (GC-isolated, warmups) ----
class CodeRacer:
    def __init__(self, warmups=5, runs=50):
        self.warmups = warmups
        self.runs = runs

    def race(self, candidates: dict):
        """candidates: name -> callable. Returns {name: {min_ns, median_ns, avg_ns}}."""
        results = {}
        for name, fn in candidates.items():
            for _ in range(self.warmups):
                fn()
            lat = []
            for _ in range(self.runs):
                gc.collect()
                gc.disable()
                try:
                    t0 = time.perf_counter_ns()
                    fn()
                    t1 = time.perf_counter_ns()
                finally:
                    gc.enable()
                lat.append(t1 - t0)
            lat.sort()
            results[name] = {
                "min_ns": lat[0],
                "median_ns": lat[len(lat) // 2],
                "avg_ns": sum(lat) // len(lat),
                "runs": self.runs,
            }
        return results


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--query", default="")
    ap.add_argument("--top-k", type=int, default=10)
    ap.add_argument("--race", action="store_true")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    root = Path(args.root)
    idx = RepoIndex(root)
    t0 = time.perf_counter_ns()
    idx.build()
    build_ms = (time.perf_counter_ns() - t0) / 1e6
    print("Indexed %d files in %.1f ms (avgdl=%.1f)" % (idx.n, build_ms, idx.avgdl))

    payload = {"indexed_files": idx.n, "build_ms": build_ms, "local_only": True,
               "dropbox": "disabled-per-chris-direction"}

    if args.query:
        t0 = time.perf_counter_ns()
        hits = idx.hybrid_search(args.query, top_k=args.top_k)
        q_ms = (time.perf_counter_ns() - t0) / 1e6
        print("Query '%s' -> %d hits in %.3f ms" % (args.query, len(hits), q_ms))
        for h in hits:
            print("  %.3f  %s  (bm25=%.2f sym=%d async=%d cent=%d)" % (
                h["hybrid"], h["path"], h["bm25"], len(h["symbols"]),
                h["async_count"], h["centrality"]))
        payload["query"] = args.query
        payload["query_ms"] = q_ms
        payload["hits"] = hits

    if args.race and args.query:
        racer = CodeRacer()
        qterms = tokenize(args.query)
        cands = {
            "bm25_only": lambda: idx.bm25(qterms),
            "hybrid_full": lambda: idx.hybrid_search(args.query, top_k=args.top_k),
        }
        res = racer.race(cands)
        for name, r in res.items():
            print("RACE %-12s min=%d ns median=%d ns avg=%d ns (%d runs)" % (
                name, r["min_ns"], r["median_ns"], r["avg_ns"], r["runs"]))
        payload["race"] = res

    if args.out:
        Path(args.out).write_text(json.dumps(payload, indent=2))
        print("Wrote %s" % args.out)


if __name__ == "__main__":
    main()