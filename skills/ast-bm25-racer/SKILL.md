---
name: ast-bm25-racer
description: >
  Sovereign AST-BM25 Racer, local-heavy edition: hybrid code retrieval plus nanosecond candidate racing. Triggers on: code retrieval, candidate racing, AST search.
---

# Sovereign AST-BM25 Racer — LOCAL-HEAVY edition

Hybrid code retrieval + nanosecond candidate racing. Adapted 2026-09-29 by Forge
per Chris's direction: **Dropbox sync removed entirely**. Everything runs and
lands locally — /tmp run dirs on the box doing the work, deliverables in the
workspace. No cloud mounts, no `dropbox:create_file`, no network calls.

## What it does

1. **AST symbol index** — stdlib `ast` for Python (classes, functions,
   `async def` counted separately so naive BM25 never drops async coroutines);
   regex extractors for TS/JS (class, function, arrow consts, imports).
2. **BM25 ranking** over file documents (path + symbol + body tokens, k1=1.2, b=0.75).
3. **Hybrid score** —
   `S_hybrid = (S_BM25 + eps) * (1 + a*sym_match + b*async_intent + c*centrality)`
   with import-graph incoming-degree centrality.
4. **CodeRacer** — `perf_counter_ns`, GC isolation, 5 warmup passes, 50 measured
   runs; reports min/median/avg nanoseconds per candidate.
5. **Local export** — JSON artifacts to the run dir / workspace. Never Dropbox.

## Usage

```bash
python3 ast_bm25_racer.py --root /home/toxic/estate --query "gate retire agent-browser" --top-k 10
python3 ast_bm25_racer.py --root /home/toxic/estate/projects/yote --query "funnel map serve" --top-k 8 --race
```

## Measured (yote, 2026-09-29)

- Full repo: 53,851 files indexed in ~98 s; query in ~531 ms.
- Scoped (projects/yote, 35 files): query in **0.395 ms**.
- Nanosecond race (50 runs, GC-isolated, 5 warmups):
  - `bm25_only`: min 27,290 ns / median 60,139 ns / avg 59,558 ns
  - `hybrid_full`: min 245,566 ns / median 300,425 ns / avg 309,265 ns

## Gotchas (from the field)

- Naive BM25 drops `async def` when queries use plain nouns — the extractor
  flags async coroutines separately and the hybrid scorer boosts them only when
  the query carries async intent.
- Always run 3–5 warmup passes before measuring; JIT/GC skew medians otherwise.
- The yote repo has 53k+ files; scope `--root` to the lane you're working for
  interactive speeds. Full-corpus indexing is a batch job (~100 s).
- Skill-doc paths like `/working_dir/...` and Dropbox namespace mounts are
  sandbox fiction — this edition targets the real boxes (hatch cell, yote).