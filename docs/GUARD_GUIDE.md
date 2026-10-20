# kairos / run-fast guard — architecture and how to tame it

Mapped 2026-10-20 while maximalizing for autonomous LLM use.

## Two implementations on PATH

`run-fast` is bound more than once; the one the shell picks depends on PATH
order. They are different tools with different behavior:

| Path                              | What it is                                   | Deadline                             | Behavior                                                                                                                     |
| --------------------------------- | -------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `/home/toxic/estate/bin/run-fast` | bash shim → `bun run $KAIROS_DIR/src/cli.ts` | `RF_DEADLINE` env (shim default 2.0) | kairos TS: pipeline splitter, truncation rewrite (persist-full + slice), per-command bumps, `[kairos BREACH — URGENT]` scold |
| `/home/toxic/bin/run-fast`        | static Python (author mandate 2026-10-13)    | `--deadline` flag, default 2.0       | kills the child process group, `[run-fast] BREACH`, exit 75                                                                  |

`/usr/local/bin/run-fast` is a symlink → `/home/toxic/bin/run-fast` (the
Python one). `type -a run-fast` shows `estate/bin/run-fast` first for an
interactive shell, but the harness / other callers may resolve either.

## kairos (`ranch/kairos`, formerly `ranch/two-sec`)

Key files (`AGENTS.md` is the component contract):

| File                    | Owns                                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/runner.ts`         | pipeline splitter, truncation rewriter, **`HARD_DEADLINE = 2.0`**, the `[kairos BREACH]` scold, `urgentBreach`                                                                   |
| `src/policy.ts`         | `BANNED` rules, `DEADLINE_BUMPS` (typecheck 180s, git status 20s, ffs glob/find 10s), `deadlineFor`                                                                              |
| `src/guard.ts`          | cancel (exit 126) vs rewrite (full-output persist)                                                                                                                               |
| `src/project-policy.ts` | per-project `.two-sec/policy.json` + `.two-sec/ignore` + `.two-sec/verdicts.jsonl`                                                                                               |
| `shim.sh`               | generated bash glue; sets `export RF_DEADLINE="${RF_DEADLINE:-2.0}"`, has an approved-slow allowlist (`_2s_slow`: git push/pull/fetch, bun/npm install/test, tsgo, ffs index, …) |
| `src/cli.ts`            | the `kairos`/`run-fast` multiplexer entry                                                                                                                                        |

### Policy surface (the supported knob — no source hacking)

`.two-sec/policy.json` (walked up from cwd, 12 levels):

```json
{
  "deadlineS": 60,
  "disableBans": ["reason substrings..."],
  "extraBans": [
    {
      "test": "regex",
      "action": "cancel|rewrite",
      "reason": "...",
      "fix": "..."
    }
  ]
}
```

`.two-sec/ignore` — one regex per line; matches never fire.

### Gotcha found on 2026-10-20

The **breach verdict** in `runner.ts` was computed from
`process.env.RF_DEADLINE ?? HARD_DEADLINE` (2.0), **not** from the project
policy's `deadlineS`. So a `.two-sec/policy.json {"deadlineS": 60}` widened
the kill timer but still triggered a `[kairos BREACH ... > 2.0s]` scold on
anything past 2s. And `shim.sh` forces `RF_DEADLINE=2.0` even if you export a
wider one unless you override it BEFORE the shim imports.

Fix committed to `src/runner.ts`: the verdict now uses
`Number(process.env.RF_DEADLINE ?? effectiveDeadline(p.cwd, HARD_DEADLINE))`
so a project deadline and the verdict agree. Note: the BREACH _message_ still
hardcodes `HARD_DEADLINE.toFixed(1)` ("2.0s"); that is cosmetic.

## Maximalize recipe for autonomous LLM use

1. Put a policy somewhere every cwd walks up to — `/home/toxic/.two-sec/policy.json`
   is the broad net for anything under `/home/toxic` (works from `/home/toxic/tmp`).
   `estate/.two-sec/policy.json` also works for estate-rooted cwds but NOT from
   `/home/toxic/tmp` (findUp only walks parents, not sideways).
2. Raise the deadline + drop the friction bans:

   ```json
   {
     "deadlineS": 60,
     "disableBans": [
       "pipeline truncation (head/tail/wc)",
       "'2>&1' merges stderr into stdout",
       "output discarded to /dev/null",
       "byte/slice truncation in output",
       "blocking sleep"
     ]
   }
   ```

   Keep `"| true" swallows the exit code` disabled — that one is a real
   safety property.

3. `RF_DEADLINE` env, if you need it per-call: `run-fast --deadline 10 <cmd>`.

## Resulting behavior after maximalize

- `ls | wc -l` → runs (truncation rewrite persists full output + prints a
  note), no URGENT cancel.
- `2>&1`, `/dev/null`, short `sleep` → allowed.
- `| true` → still refused (exit-code swallowing).
- Long-but-expected commands (`git push`, `bun install`, `typecheck`) stay in
  the approved-slow allowlist.
