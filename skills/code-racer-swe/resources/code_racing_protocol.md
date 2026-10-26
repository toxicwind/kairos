# Code Racing Protocol for Autonomous SWE Agents

## 1. Concept & Theory
Instead of generating a single speculative fix, the agent generates 2-3 candidate patches with varying risk/complexity profiles:
- Candidate A: Minimal AST-targeted surgical edit.
- Candidate B: Structural refactor or exception handling guard.
- Candidate C: Alternative data structure (e.g. set/dict vs list traversal).

## 2. In-Sandbox Execution via `CodeRacer`
1. The agent applies each candidate patch into temporary scratch files or in-memory modules.
2. Invokes `python3 skills/code_racer_swe/scripts/code_racer.py` against the targeted unit test or reproduced failure.
3. The engine executes:
   - 5 to 10 warmup iterations.
   - Automatic garbage collection disablement (`gc.disable()`).
   - Monotonic nanosecond measurement via `time.perf_counter_ns()`.
   - Summary ranking by median latency.
4. The winning candidate is selected for final integration and submitted via `submit_patch()`.
