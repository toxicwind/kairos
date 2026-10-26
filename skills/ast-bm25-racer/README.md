![GitHub Repo Stars](https://img.shields.io/github/stars/toxicwind/ast-bm25-racer?style=for-the-badge)
![GitHub License](https://img.shields.io/github/license/toxicwind/ast-bm25-racer?style=for-the-badge)
![GitHub Last Commit](https://img.shields.io/github/last-commit/toxicwind/ast-bm25-racer?style=for-the-badge)

# ast-bm25-racer
Sovereign AST-BM25 Racer, local-heavy edition: hybrid code retrieval plus nanosecond candidate racing

## What it does
Hybrid code retrieval system that combines AST symbol indexing with BM25 ranking and nanosecond-precision candidate racing for ultra-fast, accurate code search.

## Why it matters
Provides local-first, Dropbox-free code retrieval with nanosecond timing precision, enabling developers to find relevant code instantly without network dependencies.

## Who it's for
Developers working on large codebases who need fast, accurate code search with local execution and detailed performance metrics.

## Features
- **AST Symbol Index** - Extracts Python classes/functions (including async) and TS/JS symbols with async-aware handling
- **BM25 Ranking** - Scores documents using path + symbol + body tokens with k1=1.2, b=0.75
- **Hybrid Scoring** - Combines BM25 with symbol match, async intent, and import-graph centrality boosts
- **Nanosecond Racing** - Measures candidate evaluation with perf_counter_ns, GC isolation, 5 warmups + 50 runs
- **Local Export** - Outputs JSON artifacts to workspace/run dirs, never uses cloud mounts or Dropbox

## Quick Start
```bash
# Basic search
python3 ast_bm25_racer.py --root /home/toxic/estate --query "gate retire agent-browser" --top-k 10

# Scoped search with racing
python3 ast_bm25_racer.py --root /home/toxic/estate/projects/yote --query "funnel map serve" --top-k 8 --race

# Full repo indexing (batch job)
python3 ast_bm25_racer.py --root /home/toxic/estate --top-k 5
```

## Configuration
The tool operates with hardcoded parameters optimized for the sovereign estate:
- BM25: k1=1.2, b=0.75
- Hybrid scoring: sym_match, async_intent, and centrality weights
- Race configuration: 5 warmups, 50 measured runs, GC-isolated timing

## Development
This is a local-heavy edition skill with no external dependencies beyond Python stdlib. Contributions should maintain the local-first, Dropbox-free philosophy.

## License
Internal tool - refer to sovereign estate licensing

## Security
No network calls, no cloud mounts, all processing stays local to the executing machine.