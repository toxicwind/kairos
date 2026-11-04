# KHSR — Kairos-Hephaistos Speculative Race (design, expanded)

**Architect seed (2026-11-04, verbatim intent):** `--deadline 90` means
hephaistos has 90 seconds to find faster code, invoked only if the command
passes `--max-time 10`. At 10s: save the session id, background it, hand the
id to hephaistos, which uses code race + pattern borrow + paper finder to
return a faster command — or the original id finishes before 90s and wins.

## Research grounding (arxiv, Oct–Nov 2026)

| Paper | Date | Borrowed mechanism |
|---|---|---|
| **Conjugate Compilation: Self-Improving Agentic Co-Compilation for Speculative Decoding** | 2026-10-20 | The speculation improves itself: every race outcome feeds a ledger that conditions future rewrites (Tier 4). |
| **Weights That Stay: On-Chip Megakernels for Serial Heads in Speculative Decoding** | 2026-11-01 | Cheap serial-head verify BEFORE committing a speculative candidate (Tier 2 verify gate). |
| **From Reactive to Agentic Resilience: Multi-Timescale AI-RAN Orchestration Under Signaling Storm** | 2026-11-02 | Multi-timescale orchestration: reflex lane (10s) vs deliberative lane (90s) with explicit escalation contract (Tier 0→1). |
| **MetaPOCS: Meta-Learned Multi-Exit Unfolding for Budget-Aware…** | 2026-11-03 | Budget-aware multi-exit: exit at the cheapest lane that meets the quality bar (Tier 3 arbitration). |

## Tiers

**Tier 0 — reflex (0–10s).** `run-fast --max-time 10 <cmd>`. Normal path:
most commands finish here; zero overhead beyond the timer.

**Tier 1 — detach (at 10s breach).** Kairos saves the session id
(`run-fast detach` semantics), backgrounds the original, and invokes
hephaistos with the id + the command shape. The original keeps running —
it is never killed by the speculation.

**Tier 2 — speculation (10–90s).** Hephaistos runs three lanes in parallel:
1. **code race** — `ffs`/blackbird the estate for faster implementations of
   the command's shape (same I/O contract, faster path).
2. **pattern borrow** — azurite code-patterns for proven faster patterns.
3. **paper finder** — arxiv/alphaxiv for technique papers (the table above
   is the standing seed set).

Every candidate passes a **megakernel-style cheap verify** before it may
enter the race: benchmark on a small sample (e.g. 1 file / 1 query), same
output shape, strictly faster on the sample. A candidate that fails verify
is discarded — never raced.

**Tier 3 — arbitration (bounded by 90s).** First-to-correct wins:
- Original id exits (exit 0) before 90s → original wins, candidates dropped.
- A verified candidate exists and the original hasn't finished → race the
  candidate; first correct output wins (MetaPOCS multi-exit: cheapest lane
  that meets the quality bar).
- 90s hit with no correct output from either → re-attach to the original,
  extend deadline, log a speculation failure.

**Tier 4 — learning (post-hoc, conjugate-compilation).** Every race writes
a ledger row: `{command_shape, winner, candidate, sample_speedup, full_speedup,
verify_cost}`. Hephaistos conditions future rewrites on the ledger —
command shapes that repeatedly beat speculation get a `no-speculate` mark
(stop wasting the 10s trigger on them); shapes with reliable candidate wins
get pre-compiled rewrites (the speculation cache).

## Contract

```
run-fast --max-time 10 --deadline 90 <cmd>
  t=10  breach → detach original, invoke hephaistos(id, shape)
  t∈(10,90)  hephaistos: 3 lanes → candidates → cheap verify → race
  t≤90  first correct output wins (original or verified candidate)
  t=90  no winner → re-attach original, log speculation failure
  post  ledger row → conditions future speculation (self-improving)
```

## Non-goals

- Never kill the original to force a candidate (the original is the
  fallback of last resort).
- Never race a candidate that failed cheap verify.
- Never speculate on interactive/stateful commands (stdin, TUI) — shape
  classifier excludes them at Tier 1.
