# pattern-forge — HANDOFF (Anvil, 2026-10-03, cell-side)

Status: cell-side repair complete. Skill is green on the cell. Remaining work
is yote-side (packaging / move / PATH install) once the bridge stabilizes.

## What was found

The stale `/home/hatch/estate` hardcode the prior `forge doctor` failure
reported was already repaired in `src/paths.ts` before this pass (a prior
worker left it behind, or the fix landed in-tree): `forge doctor` passed
7/7 and the full test suite 32/32 on first run. This pass:

1. Hardened the last literal host path outside the estate candidate probe
   list: `src/audit.ts` `resolveAstGrep()` still had the literal
   `"/home/toxic/.local/share/mise/shims/ast-grep"`. Now
   `join(homedir(), ".local", "share", "mise", "shims", "ast-grep")` — the
   same probe order ($AST_GREP_BIN → $HOME/.local/bin → yote mise shims →
   PATH) with no literal host path.
2. Re-ran tests + doctor after the edit: still 32/32 and 7/7.

## Files changed (cell-side, ~/workspace/skills/pattern-forge/)

- `src/audit.ts` — one-line fix: yote mise-shims ast-grep probe now built from
  `homedir()` instead of a literal `/home/toxic/...` path.
- `HANDOFF.md` — this file.

Pre-existing (not touched by this pass, already correct):

- `src/paths.ts` — dynamic estate resolution, no `/home/hatch` hardcode in
  code. Chain: `$ESTATE` env override → discovery from the skill's own
  location (`config/ports.env` marker two levels above the skill dir) →
  probe `/home/toxic/estate` and `$HOME/estate` with `existsSync` →
  honest empty-string miss (never blesses a stale dir). `/home/toxic/estate`
  appears only as a *probe candidate* (probed, never assumed) and once in a
  comment naming the anti-pattern.

## Doctor results

Cell, `bun bin/forge.ts doctor` → EXIT 0, 7/7 PASS:

```
PASS  scan skill dir    16 code files under /home/hatch/workspace/skills/pattern-forge
PASS  retrieve          16 indexed, top=src/concurrent.ts
PASS  bench             winner=noop rows=2
PASS  subgraph parse    frames=1 pyFiles=16
PASS  mcts              7814-8765 iters best=a
PASS  paths             no estate checkout on this host — resolver reported the miss honestly
PASS  audit (ast-grep)  /home/hatch/.local/bin/ast-grep
```

`bun bin/forge.ts paths` reports the honest miss on cell (both candidates
missing) and `ESTATE=/tmp` override is honored.

Test suite: `bun test tests/pattern-forge.test.ts` → **32 pass / 0 fail**.

Network smoke: `forge borrow "<q>" --per-source 1 --skip exa` → 3/5 free
sources ok in ~9.4s; Semantic Scholar 429 (expected on anonymous tier),
DBLP bot-wall (expected, in SKILL.md honest limits); github skipped cleanly
with the no-token note; 0 credits spent. EXIT 0 — degrades, does not fail.

## 401 / Exa findings (code-read, no credentials touched)

GitHub 401 — NOT a code bug. Exact mechanism:

- `src/providers.ts` `resolveGithubToken()`: order = `GITHUB_TOKEN` env →
  regex `GITHUB_TOKEN\s*=\s*...` in `$HOME/.secrets` (secretsmith vault).
  No token → the borrow orchestrator (`src/borrow.ts:142`) skips the github
  leg outright with a note; it never fires an unauthenticated call.
- With a token: `GET https://api.github.com/search/code?q=...&per_page=N`
  with headers `Authorization: Bearer <token>`,
  `X-GitHub-Api-Version: 2022-11-28`, `Accept: application/vnd.github+json`.
  `fetchJson` throws on `!res.ok` (HTTP 401 becomes an error, not a crash).
- Why the yote run 401s: GitHub credentials DIED AGAIN (standing memory
  2026-10-02 ~22:20 MDT — PAT invalidated, cause unknown). The token the
  vault holds is dead, so GitHub returns 401. Fix = Chris re-mints the PAT;
  the code needs nothing. Note: this fine-grained PAT also 403s on blob
  creation (see TOOLS.md cell push footgun) — check scopes include code
  search (`repo` read) when re-minting. Nobody mints except Chris.

Exa key — code expects it via `src/borrow.ts` `resolveExaKey(explicit)`:

- Order: `--exa-key <K>` flag → `EXA_API_KEY` env → regex
  `EXA_API_KEY\s*=\s*...` in `$HOME/.secrets`.
- Sent as header `x-api-key: <key>` in `POST https://api.exa.ai/search`
  (body: `{query, type: "auto", numResults}`); every call logged locally
  with `costUsd` because Exa exposes no usage endpoint.
- No key → leg is built disabled; audit log records "credits spent: 0".

## AST-audit verdict (dogfooded `forge audit` against the skill itself)

Claim: "path resolution probes candidates and honors the env override; no
hardcoded /home/hatch estate path in code."

- `discoverEstate calls pickFirstExisting` → **VERIFIED**
  (`src/paths.ts:52` `return pickFirstExisting(estateCandidates(), "");`)
- `pickFirstExisting calls existsSync` → **VERIFIED**
  (`src/paths.ts:35` `if (existsSync(c)) return c;`)
- literal string `"/home/hatch/estate"` in `src/` → **NOT-FOUND**
  (0 AST hits; the one textual mention is a comment naming the anti-pattern)
- `process.env.ESTATE` override read → **VERIFIED** (`src/paths.ts:73`)

**Verdict: VERIFIED (high confidence).** The resolver is probe-and-override;
nothing in code assumes a host path.

## Yote resume runbook

Blockers right now: yote exec-bridge is DOWN (502) and GitHub creds are dead.

1. Bridge: `~/workspace/bin/yote-conn` health — fix/restart per bridge owner
   (memory: WS lane down, HTTPS fallback works).
2. Trace ownership/move history on yote (ffs + git log under /home/toxic —
   check whether pattern-forge already has a repo home, e.g. under
   /home/toxic/estate/tools/, and whether this cell copy is ahead or behind
   the yote copy; two prior workers died to restart drains, so diff the trees
   before moving anything — never lose code in the merge).
3. Merge these changes (only `src/audit.ts` + this `HANDOFF.md`) into the
   owning repo's copy: diff first, apply with hashline or careful merge —
   never blind copy, never `git reset`.
4. Fix installation/PATH packaging: `scripts/forge` resolves from its own
   location (no install step); `scripts/install-forge.sh` symlinks `forge`
   onto PATH; both need `bun`. Verify fresh-shell invocation with NO shim
   (temp shim was /home/hatch/workspace/bin/forge — do not depend on it).
5. Run on yote: `bun bin/forge.ts doctor` (expect paths PASS with
   ESTATE=/home/toxic/estate selected from the probe list), `bun test
   tests/pattern-forge.test.ts` (32/32), and `forge borrow --skip exa`
   (github leg will still 401-skip until Chris re-mints the PAT — code is
   fine, creds are not).
6. Commit in the owning repo, push with --force-with-lease only if needed
   (fetch first; GitHub creds dead → push will block until re-auth; keep the
   commit safe locally in /home/toxic), verify remote ref.

## Open questions

- Owning-repo location of pattern-forge on yote is unknown from the cell —
  yote recon (ffs + git log) decides where this merge lands.
- GitHub PAT re-mint is Chris-only; the borrow github leg stays skipped until
  then. No code action required.
