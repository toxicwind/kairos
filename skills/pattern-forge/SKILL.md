---
name: pattern-forge
description: Retrieve, race, and borrow. One tool for finding code in our own tree (AST-BM25 hybrid retrieval), proving which implementation is fastest (concurrent first-valid-wins racing with hedging and a persistent winner ledger), searching the outside world for prior art (7 academic and code sources in parallel), and inducting a call subgraph from a traceback. Use when you need to find code you half-remember, choose between competing approaches, benchmark candidate implementations in nanoseconds, mine papers or GitHub for prior art, or debug by narrowing a failing traceback to the files that matter. Pure Bun, zero npm dependencies.
---

# pattern-forge

Four legs that share one doctrine: **many readers, one writer; the first valid
answer wins; the slow path stays hot because we write down who won.**

Everything here is pure Bun. No npm dependencies — TypeScript and JavaScript
get a real AST from `Bun.Transpiler.scan()`; Python uses a lexical extractor.

Install: the repo-owned `scripts/forge` launcher resolves as a bare `forge`
(no install step; it finds the skill dir from its own location). Otherwise
`scripts/install-forge.sh` symlinks `forge` onto PATH. Both need `bun`.

```
forge retrieve --root <dir> --query "<q>"   # find code we half-remember
forge audit --root <dir> --claim "<claim>"  # VERIFY a claim against the AST
forge race --strategies s.json --hedge-ms N # race implementations, first valid wins
forge bench --candidates c.json             # nanosecond leaderboard
forge borrow "<query>"                      # mine papers + GitHub for prior art
forge mcts --candidates a,b,c --real        # pick a patch by running it
forge subgraph --root <dir> --trace tb.txt  # traceback -> the files that matter
forge doctor                                # self-check every leg
```

## Why this is one tool

Seven separate skills used to do this, each with its own copy of overlapping
code. Two of them (`code-racer-swe` and `dynamic-ast-probe`) shipped a
byte-identical `code_racer.py`. None of them referenced each other. The graph
was fragmented and one-directional, so knowledge leaked sideways instead of
compounding. Merging them makes the shared doctrine legible in one place:

| Leg | Absorbed from | What it does |
|---|---|---|
| `retrieve` | `ast-bm25-racer`, `ast_indexer.py` | Hybrid AST + BM25 over the estate |
| `audit` | ast-grep (GitHub merge, 2026-10-02) | Verify claims against the AST — file:line:node evidence |
| `race` | `hft-latency/bin/race.py` | Concurrent, hedged, first-valid-wins |
| `bench` | `code_racer.py` (×2 copies) | Nanosecond candidate leaderboard |
| `borrow` | `emergent-enrich/bin/route.py`, `race-borrow.ts` | 7 sources in parallel, ranked |
| `mcts` | `mcts_engine.py` | Pick a patch by verifying it |
| `subgraph` | `dynamic_subgraph_inducer.py` | Traceback -> relevant files |
| (shared) | `circuit_breaker.py` | Per-attempt deadline + rollback |

`hft-latency` remains the canonical prose doctrine; this tool is its engine.

## Leg 1 — retrieve

Find code you half-remember. Hybrid of BM25 over the path and symbol names, with
reweighting for exact symbol hits, async density, and import centrality.

```bash
forge retrieve --root /home/toxic/estate/ranch --query "stream broker subscribe topic route" --top 5
```

```
=== Retrieve: 25607 files / 261.9 MB in 5111ms (walked 11934 dirs, pruned 52) ===
=== query "stream broker subscribe topic route" in 4.81ms ===
 1. .../hermes-tool-gateway-broker-fixture.ts   109.56  bm25=68.47
    HERMES_BROKER_REDIRECT_BODY, HERMES_BROKER_REDIRECT_HEADER, handleHermesBrokerCoexistencePortal
```

**26× faster to build, 127× faster per query** than the Python original (98 s /
53,851 files, 531 ms per query). The original filtered excluded directories
*after* traversal, so pointing it at the estate crawled 400 GB of build
artifacts before dying. This one prunes at the directory level and never
silently truncates — `--max-files` sets a flag in the output instead.

## Leg 2 — race

Never find out which approach is fastest by trying them one at a time. Launch
them together, take the first *valid* one, cancel the rest.

```bash
forge race --strategies s.json --hedge-ms 300 --lead
```

```json
{"strategies":[
  {"name":"primary", "cmd":["bun","run","a.ts"], "match":"^OK"},
  {"name":"backup",  "cmd":["bun","run","b.ts"], "match":"^OK"}
]}
```

The rules that make it trustworthy:

- **Valid, not merely finished.** Output must match `match` *and* exit 0. A
  crash is not a win.
- **Hedging.** The primary launches alone. At `--hedge-ms` the backups launch
  if nobody has won. A fast primary means backups never run — zero waste.
- **The ledger.** Every race appends to the winner log. `--lead` reorders the
  next race by what has historically won. The slow path gets tried less, so it
  stays warm instead of rotting.
- **No orphans.** Losers are aborted on resolution, not left to run to
  completion.

## Leg 3 — bench

Nanosecond comparison of candidate implementations that are already code.

```bash
forge bench --candidates c.json
```

```
 1. includes        median 140.0ns  p95 4.39µs  mean 2.37µs
 2. array-index-of  median 270.0ns  p95 1.10µs  mean 2.43µs
```

A candidate that *throws* has no samples. It must rank last, not first — with a
naive sort its zero-sample median sorts to the top and the race reports no
winner at all.

## Leg 4 — borrow

Prior art, seven sources at once. Wall time is the slowest leg, not the sum.

```bash
forge borrow "self-evolving training arenas for LLM agents" --top 5
```

| Source | Cost | Notes |
|---|---|---|
| arXiv | free | Throttled to 1 req / 3.5 s, audit-logged |
| OpenAlex | free | Polite mailto, full metadata |
| Semantic Scholar | free | Anonymous tier is 100 req / 5 min — expect 429s |
| DBLP | free | **Serves a bot-check wall to our shared egress IP.** Parse failure is expected, not a bug |
| HuggingFace papers | free | |
| GitHub | free w/ token | 401 without `GITHUB_TOKEN`; degrades, does not fail the run |
| exa | **paid** | Runs automatically when a key resolves. Every call logged with its `costUsd` |

**exa is audited, not gated.** An earlier design required an `--exa-ok` opt-in
before it would look for a key, which meant a key sitting in the secretsmith
vault went unused. It now resolves the key from the flag, the environment, then
`$HOME/.secrets`, runs, and records the cost in the audit log. Crippling a good
source to avoid a bill is the wrong trade when the spend is observable.

## Leg 5 — mcts

Choose a patch by verifying candidates rather than reasoning about them.

```bash
forge mcts --candidates "bun test","pytest","cargo test" --real --timeout 120
```

Each rollout runs the candidate; passing returns +1, failing returns −1.
Without `--real` it exercises the tree mechanics with a toy reward.

## Leg 6 — subgraph

A traceback tells you where it broke; the import graph tells you why.

```bash
forge subgraph --root /home/toxic/estate/ranch/tau --trace tb.txt --depth 3
```

Marks traceback frames with `*`, walks imports to depth N, reports fan-in.

## Leg 7 — audit

Claims about code get verified against the AST — not curl, not ls. Merged
2026-10-02 from the global GitHub AST-audit search (winner: ast-grep).

```bash
forge audit --root /home/toxic/estate/tools/sovereign-router \
  --claim "sovereign router listens on port 25104"
# === audit: "..." [port-bind (port 25104)] -> VERIFIED (confidence: high) ===
#   router.ts:87:2-87:31  Bun.serve({ port: 25104, ... })
#     captures: $PORT="25104"
```

Claim shapes: port-bind ("X listens on port N"), call-edge ("X calls Y",
two-pass: find X's definition range, then Y() inside it), import-edge
("A imports B"), symbol-definition ("function|class X"). Anything else:
`--pattern '<ast-grep pattern>' --lang ts` or `--rule rules/foo.yml`.
Exit codes: 0 VERIFIED, 1 NOT-FOUND, 2 INCONCLUSIVE. Full workflow, recipes,
and pitfalls live in the `ast-audit` skill.

## Honest limits

- Python symbol extraction is lexical, not an AST. Bun has no built-in Python
  parser and adding tree-sitter would break the zero-dependency guarantee.
- The Python original indexed 53,851 files in 98 s; this indexes 25,607 in
  ~5 s but covers fewer directories, because pruning skips `target/` and
  friends entirely.
- DBLP and anonymous Semantic Scholar will fail from this host. That is the
  network, not the code. A dead source never fails the run and never looks
  like it did: `safeCall` wraps every leg, and EVERY per-route failure —
  expected network weather (429s, bot-wall HTML, DNS / connection errors)
  or an unexpected provider bug — emits `source_degraded` and renders as a
  quiet note. The `expected` flag on the event preserves the diagnostic
  classification. A route's failure is degradation, never an error; a true
  error is reserved for whole-run failure.