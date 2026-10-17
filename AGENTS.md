# AGENTS.md — kairos component contract

> **Refines:** `/home/toxic/estate/AGENTS.md` (the estate control-plane). Asserts
> **"refines, never contradicts"** the estate contract above it.

## Mission

`kairos` (καιρός) enforces the estate's 2-second rule, first-class: every command
an agent runs gets a 2.0s hard deadline; a breach triggers racing a faster
alternative (never waiting). Region owns the deadline runner (`runner.ts`), the
command policy (`policy.ts`/`guard.ts`), and the generated bash shim
(`shim.sh`).

## Key files

| Path | Owns |
|---|---|
| `src/runner.ts` | pipeline splitter, truncation rewriter, live-persist sink, deadline enforcement |
| `src/policy.ts` | `SLOW_ROUTES`, `DEADLINE_BUMPS` (typecheck 180s, git status 20s), `deadlineFor` |
| `src/guard.ts` | command policy: cancel (exit 126) vs rewrite (full-output persist) |
| `src/cli.ts` | the `kairos`/`run-fast` multiplexer entry |
| `src/init.ts` | emits the generated `shim.sh` |
| `shim.sh` | generated static bash glue (zero bun spawns at runtime) |

## Rules

- **The 2s rule is the law.** A breach is a defect, not a result — race a faster
  alternative via ast-grep → bm25 → paper-finder → forge borrow → background, in
  that order. Never retry the same slow command.
- **Never truncate.** No `| head`/`tail`, no `2>&1` merge, no `/dev/null`.
  Persist full output to the run-fast session file; slice only in code.
- **Banned tools.** `find`→`fd`, `cat`→the read tool, `sed`→ast-grep, etc. are
  refused with the WHY + exact replacement (see `REPLACEMENTS` in `runner.ts`).
- **Deadline bumps are intentional.** `typecheck`/`tsgo`/`turbo` get 180s;
  `git status` gets 20s. Every other command stays at the 2.0s base.
- **Run-fast is required** for every command (estate doctrine). The estate
  `bin/run-fast` shim routes through `ranch/kairos/src/cli.ts`. Set `KAIROS_DIR`
  to point at a fork/checkout under iteration.

## Gate

```bash
bun test          # runner + policy + guard behavior
node ../agent-customization-style-guide/bin/validate.js   # R-502 convention gate
```

Follow the **vibe meta-todo** (estate AGENTS.md): race faster with borrow +
papers during the task; after research spawn the next 6 complex todos.