---
name: code-racer-swe
description: Universal Code Racer and Dynamic AST Engine for autonomous software engineering agents. Enables empirical multi-route symbol indexing and candidate patch benchmarking.
---
# Code Racer SWE Engine

## Summary
Integrates the `universal-code-racer` benchmarking paradigm directly into the autonomous agent loop. Dynamically benchmarks competing retrieval routes and candidate patch fixes under strict garbage collection isolation and nanosecond timing.

## Scripts
- `scripts/code_racer.py`: High-precision monotonic timing and candidate ranking engine.
- `scripts/ast_indexer.py`: Dual-pass regex/AST scanner for instant sync and async symbol indexing.
- `scripts/circuit_breaker.py`: Task budget manager and automated git rollback controller.

## Resources
- `resources/code_racing_protocol.md`: Step-by-step instructions for candidate patch racing inside `/workspace`.
