# code-racer-swe {badges}

<!-- badges: start -->
<a href="https://github.com/toxicwind/sovereign-projects">
  <img src="https://img.shields.io/badge/github-toxicwind/sovereign--projects-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub repo">
</a>
<a href="https://bun.sh">
  <img src="https://img.shields.io/badge/bun-js_runtime-7f5af0?style=for-the-badge&logo=bun&logoColor=white" alt="Bun">
</a>
<!-- badges: end -->

## Universal Code Racer and Dynamic AST Engine for autonomous software engineering agents.

**What**: Integrates the `universal-code-racer` benchmarking paradigm directly into the autonomous agent loop. Dynamically benchmarks competing retrieval routes and candidate patch fixes under strict garbage collection isolation and nanosecond timing.

**Why**: Enables empirical multi-route symbol indexing and candidate patch benchmarking — critical for evaluating the performance and correctness of code modifications in autonomous agents.

**Who**: Provides high-precision timing and candidate ranking for software engineering tasks involving retrieval and patch generation.

## Feature bullets

- **Code Racer**: `scripts/code_racer.py` — High-precision monotonic timing and candidate ranking engine
- **AST Indexer**: `scripts/ast_indexer.py` — Dual-pass regex/AST scanner for instant sync and async symbol indexing
- **Circuit Breaker**: `scripts/circuit_breaker.py` — Task budget manager and automated git rollback controller
- **Resources**: `resources/code_racing_protocol.md` — Step-by-step instructions for candidate patch racing inside `/workspace`
- **Garbage collection isolation**: Strict isolation for reliable benchmarking
- **Nanosecond timing**: High-precision monotonic timing for candidate evaluation
- **Multi-route benchmarking**: Competing retrieval routes benchmarked concurrently
- **Candidate patch fixing**: Benchmarks different approaches to patch generation

## Quick start

```bash
# High-precision timing and candidate ranking
python scripts/code_racer.py --help

# Dual-pass regex/AST symbol indexing
python scripts/ast_indexer.py --help

# Task budget management and git rollback
python scripts/circuit_breaker.py --help

# Code racing protocol (step-by-step instructions)
cat resources/code_racing_protocol.md
```

## Config / optional services

- **Garbage collection isolation**: Strict GC isolation for reliable benchmarking results
- **Nanosecond timing**: Monotonic timing engine for nanosecond precision
- **Dual-pass AST indexing**: Instant sync and async symbol indexing via regex/AST scanning
- **Task budget management**: Prevents runaway execution times with automated rollback
- **Code racing protocol**: `resources/code_racing_protocol.md` for operational guidance

## Dev / contributing

- **Universal-code-racer paradigm**: Integrated directly into the autonomous agent loop
- **Strict garbage collection isolation**: Ensures reliable, reproducible benchmarking
- **Nanosecond timing**: High-precision monotonic timing for candidate evaluation
- **Multi-route symbol indexing**: Empirical evaluation of competing retrieval approaches
- **Candidate patch benchmarking**: Objective comparison of different fix strategies
- **Automated git rollback**: Circuit breaker prevents repository corruption from bad patches
- **No artificial sleeps, polling loops, or timeouts-as-delays**: Event-driven where applicable

## License + security

- **License**: Open Claw source (see `skill.toml`)
- **Security**: Strict garbage collection isolation prevents side effects between benchmarks. Automated git rollback protects repository state. Nanosecond timing is monotonic and isolated — no shared state between runs.