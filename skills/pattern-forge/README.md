# pattern-forge \| retrieve • race • bench • borrow • mcts • subgraph

[![for-the-badge](https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=white)](https://bun.sh) [![for-the-badge](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![for-the-badge](https://img.shields.io/badge/AST--BM25-Retrieval-FF6F61?style=for-the-badge)](https://github.com/toxic/internals)

## pattern-forge

Retrieve, race, and borrow. One tool for finding code in our own tree (AST-BM25 hybrid retrieval), proving which implementation is fastest (concurrent first-valid-wins racing with hedging and a persistent winner ledger), searching the outside world for prior art (7 academic and code sources in parallel), and inducting a call subgraph from a traceback. Use when you need to find code you half-remember, choose between competing approaches, benchmark candidate implementations in nanoseconds, mine papers or GitHub for prior art, or debug by narrowing a failing traceback to the files that matter. Pure Bun, zero npm dependencies.

### Legs of the doctrine

| Leg | Absorbed from | What it does |
|---|---|---|
| `retrieve` | `ast-bm25-racer`, `ast_indexer.py` | Hybrid AST + BM25 over the estate |
| `race` | `hft-latency/bin/race.py` | Concurrent, hedged, first-valid-wins |
| `bench` | `code_racer.py` (×2 copies) | Nanosecond candidate leaderboard |
| `borrow` | `emergent-enrich/bin/route.py`, `race-borrow.ts` | 7 sources in parallel, ranked |
| `mcts` | `mcts_engine.py` | Pick a patch by verifying it |
| `subgraph` | `dynamic_subgraph_inducer.py` | Traceback → relevant files |
| (shared) | `circuit_breaker.py` | Per-attempt deadline + rollback |

### Feature bullets

- **retrieve** — Hybrid AST + BM25 over the estate; 26× faster to build, 127× faster per query than Python original; prunes at directory level, never silently truncates
- **race** — First valid-wins racing with hedging; valid (output matches `match` AND exit 0), not merely finished; hedging launches backups at `--hedge-ms` if nobody has won; ledger tracks historical winners; no orphans — losers aborted on resolution
- **bench** — Nanosecond comparison of candidate implementations; throws have no samples, rank last; median/p95/mean leaderboard
- **borrow** — Seven sources in parallel (arXiv, OpenAlex, Semantic Scholar, DBLP, HuggingFace papers, GitHub, exa); wall time is slowest leg, not sum; cost/audit logged per source
- **mcts** — Choose a patch by verifying candidates; passing returns +1, failing returns −1; `--real` exercises tree mechanics, without it uses toy reward
- **subgraph** — Traceback tells where it broke; import graph tells why; marks traceback frames with `*`, walks imports to depth N, reports fan-in
- **doctor** — Self-check every leg

### Install

No install step is needed where the skill system is active: every skill's
`scripts/` directory is on PATH, so the repo-owned `scripts/forge` launcher
resolves as a bare `forge` from any checkout (it finds the skill dir from its
own location — no hardcoded host paths). Elsewhere:

```bash
skills/pattern-forge/scripts/install-forge.sh                 # symlinks `forge` onto PATH
skills/pattern-forge/scripts/install-forge.sh --prefix ~/.local/bin
```

The installer links `<prefix>/forge` at `bin/forge.ts` (the package.json
`bin` target). Both need `bun` on PATH.

### Quick start (3 commands max)

```bash
# Retrieve code you half-remember
forge retrieve --root /home/toxic/estate/ranch --query "stream broker subscribe topic route" --top 5

# Race implementations, first valid wins
forge race --strategies '{"strategies":[{"name":"primary","cmd":["bun","run","a.ts"],"match":"^OK"},{"name":"backup","cmd":["bun","run","b.ts"],"match":"^OK"}]} --hedge-ms 300 --lead

# Bench candidates
forge bench --candidates '{"candidates":[{"name":"includes"},{"name":"array-index-of"}]}'
```

### Architecture

Seven legs sharing one doctrine: many readers, one writer; the first valid answer wins; the slow path stays hot because we write down who won. Pure Bun. No npm dependencies — TypeScript and JavaScript get a real AST from `Bun.Transpiler.scan()`; Python uses a lexical extractor. Seven separate skills used to do this, each with its own copy of overlapping code. Merging them makes the shared doctrine legible in one place.

### Config / optional services

- `--root <dir>` — root directory to search (required for `retrieve`)
- `--strategies <json>` — strategy configuration for `race` (JSON with name, cmd, match fields)
- `--hedge-ms <ms>` — milliseconds before backup strategies launch in `race`
- `--candidates <json>` — candidate configuration for `bench` (name, cmd fields)
- `--top <n>` — number of results to return (default varies by leg)
- `--timeout <s>` — timeout for `mcts` rolls (default 120s)

### Dev / contributing

- Clone the estate repo; ensure Bun is installed (`bun install` or `bun i`)
- All code is pure TypeScript/JavaScript, zero npm dependencies
- Legs are in `src/`; each leg has its own `forge-*.ts` file
- To add a new leg: implement the CLI command, the racing logic, and the ledger append
- Run `forge doctor` for self-check every leg
- Contributions merge into the shared winner ledger; no orphans allowed

### License

Open Claw — see `skill.toml` for details.

### Security

- Do NOT use for private/internal repos that will never be public
- This skill maximalizes legitimate retrieval — the code and presentation earn trust, nothing else
- DBLP and anonymous Semantic Scholar will fail from this host. That is the network, not the code.