# Changelog

Auto-backfilled from git history 2026-11-02 (real commits only).

## 2026-11-02
- chore: fold forward WIP (dirty-tree sweep 2026-11-02) (148865c)

## 2026-10-30
- chore(eidos): apply bun-scaffold bunfig + infra drop-in env (qdrant/hindsight/kafka/redis) — eidos is the pare (2567e64)

## 2026-10-27
- fix(runner): lossless argv quoting in every bash -c path (b9f6746)

## 2026-10-26
- Merge pull request #1 from toxicwind/kappa-kairos-delend-chain-fix (6d835af)
- fix(kairos): stop shim from hijacking interactive bash — no exported wrappers, idle-by-default (bd18b7c)
- test(kairos): agonistic delend-chain suite uses bounded chain surface, not slow grep -r pens (4ae5a80)
- test(kairos): TDD chain survives delendai→hephaistos reorg (7872e59)
- fix(shim): escape backticks in git credential-helper comment — init.ts was unparseable (f379a13)
- fix(kairos): enforce RUN_FAST_ACTIVE re-entry guard in shim — stops fork storm (09a49d7)

## 2026-10-25
- fix(kairos): add wc doctrine wrapper — cancel cmd|wc -l pipelines (ccb46c2)
- fix(kairos): head/tail doctrine wrappers cancel pipes + route files to ffs; regenerate shim (4467a14)
- fix(kairos): shim + runner — timeout kept/quiet, corrupt-json tolerant (root-fix run-fast lag) (fc02588)
- fix(kairos): tolerate empty pipe-group upstream — deadlineFor(undefined args) crashed the runner; head/tail/wc (de21d2e)

## 2026-10-24
- ci: add GHA workflow (pure Bun, ubuntu-hosted, compilable) (ad2810b)
- fix(kairos): point shim runner at canonical pens/barn/estate-ops paths (TDD) (42b5e0e)

## 2026-10-22
- feat(kairos): auto-follow detached sessions — streaming delivery to the agent (4b590d5)
- feat(kairos): first-class --deadline=N (strict), harden verb dispatch, declarative bun shim (2a93e48)
- feat(kairos): 4s deadline default and auto-trigger delend-code-race on breach (ad62089)

## 2026-10-20
- kairos: auto-detach slow ops, secret redaction, real git deadline windows (047de41)

## 2026-10-19
- policy: gh deadline bump (120s) so gh repo/pr/api don't get killed by the 2s cap (fb6551e)
- docs(readme): add maximalize-for-autonomous section + GUARD_GUIDE link (f9c23e9)
- docs(GUARD_GUIDE); fix: breach verdict honors effectiveDeadline not just RF_DEADLINE/HARD_DEADLINE (21c819e)

## 2026-10-16
- docs(kairos): deeplink prior-art — AgentRewind recovery, guardrail-bypass resilience, hybrid static+dynamic an (248028a)
- docs(AGENTS): component contract per agent guide (R-101 refines, R-102 owns rules, R-503 local refs) (49d8757)
- regenerate: kairos shim with updated paths/branding (7c934e4)
- brand(kairos): banners/shim header -> kairos; regenerate shim.sh (0dff601)
- docs(kairos): rebrand README to kairos, update pipeline/rewrite policy + paths (41e10a8)
- rename(kairos): package.json name two-sec -> kairos (0863e65)
- feat(run-fast): deadline bumps for typecheck(180s), git status(20s); effectiveSub resolves subcmd past -C flag (91f1a4f)
- feat(run-fast): synchronous live-persist sink — every chunk flushes to stdout + session file, async execution  (85fb51a)
- feat(run-fast): pipe splitter + truncation rewriter — head/tail/wc persist full output and show window (dcb6518)
- harden run-fast: detect pipeline truncation and chained banned tools, exempt fast-tool subcommands, fix EPIPE (2c9f6df)
- harden(run-fast): banned tools blocked with WHY + exact replacement + contract, on stderr (419c285)
- refactor(run-fast): banned tools now BLOCKED with a terse command, not a lecture — no ask, just redirect (415a6f0)
- feat(run-fast): corrective scolding names fd/rg/ast-grep; add bash-compatible -lc shell mode for kilo (ca43fb2)
- fix(shim): export _2s_wrap so turbo-spawned subprocesses can route bun/git/npm (f59f7f6)
- fix(run-fast): ast-grep run -p syntax in breach + README (e876f03)
- fix(run-fast): correct AST tools — ast-grep not sg, add bm25 to README (8469260)
- feat(run-fast): reference ast-grep/bm25/ffs as first-class AST tools in breach guidance (be8d3f2)
- feat(run-fast): verbose scolding on banned cmds, remove --deadline flag, enforce 2s law (0d76b65)
