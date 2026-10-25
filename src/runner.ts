/**
 * runner.ts — run-fast: the 2s deadline wrapper. VERBOSE, SCOLDS the agent.
 *
 * Subcommands:
 *   run <cmd…>          the ONLY way commands should run. 2.0s cap, no override.
 *   attach <id>         attach to live/historic session
 *   logs [id]           session output
 *   list                list sessions
 *   purge [pattern]     remove sessions
 *   cancel <id>         kill session
 *
 * The 2.0s deadline is FIXED. There is NO --deadline flag. If you think a
 * command needs more than 2s, you are WRONG — you must race a faster
 * alternative or background it. Never wait longer. This is the LAW.
 *
 * Inline syntax in run args:
 *   FOO=bar              → env var
 *   --cwd /path          → working directory
 *   --id name            → session name
 */
import { spawn } from "bun";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { effectiveDeadline, logVerdict } from "./project-policy.ts";
import { deadlineFor, shouldDetach } from "./policy.ts";

const SESSION_DIR = join(process.env.HOME || "/tmp", ".run-fast");
const HARD_DEADLINE = 4.0; // seconds (4s shim doctrine). NON-NEGOTIABLE.
const DELEND_CODE_RACE =
  process.env.DELEND_CODE_RACE ||
  "/home/toxic/pens/barn/estate-ops/delend-code-race";

export interface RunResult {
  verdict: "ok" | "breach" | "fail" | "spawn-fail";
  elapsedMs: number;
  exitCode: number;
}

const scold = (msg: string) => {
  process.stderr.write(
    `\n  ╔══════════════════════════════════════════════════════════════╗\n  ║                 ⚠ RUN-FAST RULE VIOLATION ⚠                    ║\n  ╚══════════════════════════════════════════════════════════════╝\n  ${msg}\n\n`,
  );
};

/** Redact obvious secrets from a command line before it reaches a notice/log. */
const REDACT = "*****";

/**
 * Losslessly quote an argv array back into a single re-runnable shell line.
 *
 * Unlike `redactCmd` (a flattened, truncated, secret-masked DIAGNOSTIC string),
 * this preserves every argument boundary so a fragmented `-c` program, inline
 * `FOO=bar` env assignment, glob, or quoted substring survives a `bash -c`
 * round-trip. run-fast hands THIS to delend-code-race so the auto-racer races
 * the real failing command, not a phantom.
 */
export function shellQuoteCmd(args: string[]): string {
  return args
    .map((a) =>
      /^[A-Za-z0-9_./:=-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`,
    )
    .join(" ");
}

export function redactCmd(args: string[]): string {
  return (
    args
      .map((a) => {
        // KEY=value or api_key=value / token=… / secret=… / password=… / _key=…
        const kv =
          /^([A-Za-z_][A-Za-z0-9_-]*(?:api[_k]ey|token|secret|password|_key)=)(.+)$/i.exec(
            a,
          );
        if (kv) return `${kv[1]}${REDACT}`;
        // Header-style: Authorization: Bearer … / X-API-Key: … / x-api-key: …
        const hdr =
          /^(Authorization|Bearer|X-API-Key|x-api-key)\s*:\s*\S.+$/i.exec(a);
        if (hdr)
          return a.replace(/^(.*?)(:|Bearer)\s*\S.+$/i, `$1$2 ${REDACT}`);
        // Bare atr_/sk- style key tokens (Atria, OpenAI, etc.)
        if (/^(atr|sk|ghp|gho|gsk|key)_[A-Za-z0-9]+$/.test(a)) return REDACT;
        return a;
      })
      .slice(0, 8)
      .join(" ")
      // Sweep any leftovers anywhere in the joined line.
      .replace(/Bearer\s+\S+/gi, `Bearer ${REDACT}`)
      .replace(
        /(api_key|apiKey|token|secret|password)=[^\s"']+/gi,
        `$1=${REDACT}`,
      )
  );
}

const urgentBreach = (
  cmd: string[],
  elapsedS: number,
  cwd: string = process.cwd(),
) => {
  const redacted = redactCmd(cmd);
  process.stdout.write(
    `\n════ [kairos 4s BREACH — URGENT, AUTO-RACING VIA delend-code-race] ════\n` +
      `  '${redacted}' took ${elapsedS.toFixed(3)}s > ${HARD_DEADLINE.toFixed(1)}s deadline. FAILED + CANCELLED.\n` +
      `  YOU VIOLATED THE 4-SECOND RULE. Auto-triggering delend-code-race...\n` +
      `═══════════════════════════════════════\n`,
  );
  if (
    existsSync(DELEND_CODE_RACE) &&
    process.env.DELEND_CODE_RACE_ACTIVE !== "1"
  ) {
    try {
      // Pass the LOSSESS shell-quoted real command to code-race so it can
      // reproduce the actual breach (quoting/`-c` programs/env/globs survive).
      // `redacted` stays for the on-screen notice only — never for execution.
      const r = Bun.spawnSync(
        ["bun", DELEND_CODE_RACE, "--", shellQuoteCmd(cmd)],
        {
          cwd,
          env: {
            ...process.env,
            DELEND_CODE_RACE_ACTIVE: "1",
            RUN_FAST_ACTIVE: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const out = new TextDecoder().decode(r.stdout).trim();
      if (out) process.stdout.write(`${out}\n`);
    } catch {}
  }
};

const scoldNotRunFast = (extra: string) => {
  scold(
    `You are NOT using run-fast for every command. This is the 2-second rule.\n` +
      `  EVERY command MUST go through run-fast:  run-fast <cmd…>\n` +
      `  ${extra}\n` +
      `  If you used a bare tool (bash/read/grep/glob/write) without run-fast, that is a\n` +
      `  violation. The ONLY exempt commands are git push/commit (explicit request) and\n` +
      `  ffs read (budget-aware code reading), and even those should prefer run-fast.\n` +
      `  Rerun this through:  run-fast <the same command>`,
  );
};

// ── Session store ──

function metaPath(id: string) {
  return join(SESSION_DIR, `${id}.json`);
}
function outPath(id: string) {
  return join(SESSION_DIR, `${id}.out`);
}

function getSessions(): {
  id: string;
  cmd: string;
  startTime: number;
  endTime: number | null;
  exitCode: number | null;
  state: "running" | "done";
}[] {
  if (!existsSync(SESSION_DIR)) return [];
  return readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(SESSION_DIR, f), "utf-8")))
    .sort((a, b) => a.startTime - b.startTime);
}

function writeMeta(
  id: string,
  m: {
    id: string;
    cmd: string;
    startTime: number;
    endTime: number | null;
    exitCode: number | null;
    state: "running" | "done";
  },
) {
  mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(metaPath(id), JSON.stringify(m));
}

function readMeta(id: string) {
  try {
    return JSON.parse(readFileSync(metaPath(id), "utf-8"));
  } catch {
    return null;
  }
}

function deleteSession(id: string) {
  try {
    rmSync(metaPath(id));
    rmSync(outPath(id));
  } catch {}
}

function genId(name?: string) {
  if (name) return `rf-${name}`;
  return "rf-" + crypto.randomUUID().slice(0, 8);
}

// Banned first-arg: these have a faster/correct replacement that run-fast NOT interposes for.
// The point of run-fast is to CORRECT you before you run something slow — so we hard-block these
// and tell you the right tool.
const bannedAsFirst: Set<string> = new Set([
  "find",
  "cat",
  "grep",
  "rg",
  "sed",
  "awk",
  "cut",
  "sort",
  "uniq",
  "less",
  "more",
  "xxd",
  "hexdump",
  "od",
  "base64",
  "tee",
  "tr",
  "paste",
  "join",
]);

const WHY: Record<string, string> = {
  find: "walks the whole tree every time → O(entries), GB of stat calls. fd/ffs use gitignore + an index.",
  grep: "ripgrep-fresh re-scan of a huge tree is wasteful when the ffs index already has the answer.",
  rg: "you invoked it bare — route content search through ffs grep (index) or scope rg to a single dir.",
  cat: "dumps a raw file into the transcript, flooding context. The read tool outlines/budgets.",
  head: "truncates a file's evidence. You have 1M context — read the FULL thing.",
  tail: "you cut the head off the evidence. Read the full file.",
  sed: "regex mangle on your source. ast-grep rewrites STRUCTURALLY on syntax, which is the only safe rewrite.",
  awk: "text-destroyer in a shell one-liner. Do the parse in code, or use ast-grep.",
  cut: "you sliced away columns you'll want 3 lines later. Persist full output.",
  sort: "stream-clobbering pipeline. Sort in code, keep the raw evidence.",
  uniq: "collapses the record you'll need. Dedup in code, keep the trail.",
  wc: "counting lines is a signal you should read the file, not truncate it.",
  less: "paging hides the full context in a pipe. Read the file.",
  more: "same as less — read the file.",
  xxd: "hex dump pollutes the transcript. Decode the bytes in your debugger.",
  hexdump: "byte-dump noise. Decode in code.",
  od: "octal/float inspect noise. Inspect in code.",
  base64: "obfuscates data in the transcript. Decode in code.",
  tee: "copies output you then inspect only partially. run-fast sessions persist full output.",
  tr: "regex transliterate mangling. Use ast-grep for structural transform.",
  paste: "column-join in a shell is a fragile hack. Do it in code.",
  join: "relation-join in shell is error-prone. Do it in code.",
};

const REPLACEMENTS: Record<string, string> = {
  find: [
    "fd <needle> <dir?>   # fast, gitignore-aware replacement for 'find'",
    "   or: ffs find <needle> --root <dir>  # estate index",
    "NEVER walk the whole disk: scope to a dir, or use the on-disk ffs index.",
  ].join("\n      "),
  grep: [
    "rg <pattern> <dir?>  # fast, respects .gitignore",
    "   or: ffs grep <regex> --root <dir> + --limit N  # index-backed, cheap",
    "NEVER 'grep -r' a huge tree; prefer rg or the ffs index.",
  ].join("\n      "),
  rg: [
    "ffs grep <regex> --root <dir>  # use the on-disk index instead of a fresh walk",
    "   (rg is fine for scoped, single-dir searches).",
  ].join("\n      "),
  cat: "read <path> via the read tool — 1M context, budget-aware outline by default, never truncated.",
  head: "read <path> via the read tool — reads the FULL file (1M context); there is NO reason to truncate.",
  tail: "read <path> via the read tool — full tail is just the end of a full read.",
  sed: [
    "ast-grep scan -p '<pattern>' --rewrite '<replacement>' -l ts <dir>  # tree-sitter STRUCTURAL rewrite",
    "   ast-grep works on syntax, not regex — it is the only safe in-place rewrite.",
  ].join("\n      "),
  awk: "ast-grep (structural) or the read tool; awk is a text destroyer you must not use.",
  cut: "persist FULL output (run-fast session file); slice columns in code, never in the transcript.",
  sort: "sort in code (JS/Python), not by clobbering the command stream with a pipeline.",
  uniq: "dedupe in code; never pipe the raw stream through uniq.",
  wc: "ffs stats or the read tool; never `| wc -l` to count (that truncates the evidence trail).",
  less: "read the file with the read tool (paging in a pipe hides the full context you need).",
  more: "read the file with the read tool.",
  xxd: "hex-decode in the code you're debugging; never dump bytes into the transcript.",
  hexdump: "hex-decode in code.",
  od: "octal/decimal inspect in code.",
  base64:
    "base64-decode in code; never shell out a decode that pollutes output.",
  tee: [
    "persist FULL output via run-fast's session file (run-fast <cmd> then run-fast logs <id>),",
    "   or the tool's own --output/--outfile flag — never tee a transcript.",
  ].join("\n      "),
  tr: "ast-grep for structural transform; never a regex transliteration pipeline.",
  paste: "do the column-join in code.",
  join: "do the relation join in code.",
};

async function streamReader(
  stream: ReadableStream<Uint8Array> | null,
  sink: { out: string; write: (t: string) => void },
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const t = new TextDecoder().decode(value);
      try {
        sink.write(t);
      } catch {
        break;
      }
      sink.out += t;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseArgs(args: string[]): {
  env: Record<string, string>;
  cwd: string;
  segments: string[][];
  ops: Array<"|" | "&&" | ";">;
  sessionName: string | undefined;
} {
  const env: Record<string, string> = { ...process.env };
  // Re-entry guard: mark every child as ALREADY running under run-fast so the
  // bash-2s-shim wrappers (git/gh/bun/npm/…) use the real binary instead of
  // re-routing through run-fast. Without this, a detached or foreground child
  // sources the shim, hits a slow route, and re-triggers run-fast → unbounded
  // recursion (observed: gh api spawning hundreds of `kairos run gh api`).
  env.RUN_FAST_ACTIVE = "1";
  let cwd: string | undefined;
  let sessionName: string | undefined;

  // Strip leading run-fast meta flags, capture env/cwd/id, and collect the command tokens.
  const toks: string[] = [];
  let idx = 0;
  while (idx < args.length) {
    const a = args[idx++];
    if (a === "--cwd" && idx < args.length) {
      cwd = args[idx++];
      continue;
    }
    if (a === "--env" && idx < args.length) {
      const ev = args[idx++];
      if (ev?.includes("=")) {
        const [k, ...v] = ev.split("=");
        env[k] = v.join("=");
      }
      continue;
    }
    if (a === "--id" && idx < args.length) {
      sessionName = args[idx++];
      continue;
    }
    if (
      a.includes("=") &&
      !a.startsWith("-") &&
      a.split("=")[0].match(/^[A-Z_][A-Z0-9_]*$/)
    ) {
      const [k, ...v] = a.split("=");
      env[k] = v.join("=");
      continue;
    }
    toks.push(a);
  }

  // Split into segments on | && ;
  const segments: string[][] = [];
  const ops: Array<"|" | "&&" | ";"> = [];
  let cur: string[] = [];
  for (const t of toks) {
    if (t === "|" || t === "&&" || t === ";") {
      if (cur.length) {
        segments.push(cur);
        cur = [];
      }
      ops.push(t);
    } else {
      cur.push(t);
    }
  }
  if (cur.length) segments.push(cur);

  // If no explicit separators but args look like a one-shot shell, coerce to a single segment.
  if (segments.length === 0) segments.push(["true"]);
  if (segments.length === 1 && ops.length === 0) {
    const cmd = segments[0];
    // Shell-compatible mode: run-fast -lc '<command>' — deadline-wrap through real bash.
    const dashIdx = cmd.findIndex(
      (c) => c === "-c" || c === "-lc" || c === "-l" || c === "--login",
    );
    if (dashIdx !== -1 && dashIdx + 1 < cmd.length) {
      // Permanent fix (2026-10-20): use `bash -c`, NOT `bash -lc`, for the
      // coerced one-shot shell. `-lc` sources the login shell, which loads the
      // estate `.bashrc` wrappers that re-route `git`/`kairos` — so a wrapped
      // `kairos run -lc 'git rebase'` spawned an unbounded recursion of
      // `bun run kairos ... git ...` (~hundreds at 100% CPU). The child already
      // inherits run-fast's env; a login shell only re-triggers the wrappers.
      // Use `bash -c` → the real binary is reached, no re-entry.
      segments[0] = ["/bin/bash", "-c", cmd.slice(dashIdx + 1).join(" ")];
    }
  }

  // Ban check on EVERY segment's first command.
  for (const seg of segments) {
    const base = seg[0]?.split("/").pop() ?? "";
    if (bannedAsFirst.has(base)) {
      const replace = REPLACEMENTS[base] ?? "ffs / ast-grep / the read tool";
      process.stderr.write(
        `\n[run-fast HARD-BLOCKED] '${base}' is banned — I refuse to run it.\n` +
          `\n  WHY it's banned:\n` +
          `  ${WHY[base] ?? "it destroys, truncates, or re-walks output — the lane of slower/wrong tools."}\n` +
          `\n  DO THIS INSTEAD (run it now):\n` +
          `  ${replace}\n` +
          `\n  Contract: do not run '${base}' again this session. You got corrected.\n`,
      );
      process.exit(126);
    }
  }

  return { env, cwd: cwd ?? process.cwd(), segments, ops, sessionName };
}

// ── Core ──

export async function runSession(
  args: string[],
  opts: { quiet?: boolean } = {},
): Promise<RunResult> {
  const p = parseArgs(args);

  // AUTO-DETACH (fix, don't scold): commands that are inherently slow/network
  // (git push/pull/fetch/clone/merge/rebase, gh *, make) never block the agent.
  // We hand them to the background runner and return a session id immediately;
  // the agent follows up with attach/logs/cancel. This replaces the 2s-kill +
  // breach+retry worst case with a sub-ms handoff.
  if (shouldDetach(p.segments[0] ?? [])) {
    const det = await runDetached(args, opts);
    // AUTO-FOLLOW (streaming delivery): detach alone returns a pointer and the
    // agent yields — the result never lands. Instead, stay on the call and
    // stream the session to completion (bounded by the detach ceiling), then
    // return the real exit code. `KAIROS_WAIT=0` restores pointer-only mode.
    if (process.env.KAIROS_WAIT !== "0") {
      await attachSession(det.id);
      const meta = readMeta(det.id);
      return {
        verdict: "ok",
        elapsedMs: meta
          ? meta.endTime && meta.startTime
            ? meta.endTime - meta.startTime
            : 0
          : 0,
        exitCode: meta?.exitCode ?? 1,
      };
    }
    return { verdict: "ok", elapsedMs: 0, exitCode: 0 };
  }

  const t0 = performance.now();
  const id = genId(p.sessionName);
  process.stderr.write(`[run-fast] session=${id}\n`);

  // Strict explicit deadline (`--deadline=N`): capture ONCE and thread through
  // BOTH the kill-timer and the breach verdict so they always agree. When set it
  // overrides command bumps and `.two-sec/policy.json` deadlineS (deadlineFor
  // returns it verbatim).
  const explicitS =
    process.env.RF_DEADLINE !== undefined &&
    process.env.RF_DEADLINE.trim() !== ""
      ? Number(process.env.RF_DEADLINE)
      : undefined;

  // Live-persist sink: writes EVERY chunk to both stdout (live) and the session file
  // (synchronous flush per chunk), so output is never buffered-and-lost and the
  // transcript is always the full record even if the process is killed mid-stream.
  const mkSink = () => {
    mkdirSync(SESSION_DIR, { recursive: true });
    const w = outPath(id);
    let pending = "";
    const flush = () => {
      if (pending) {
        const fd = openSync(w, "a");
        try {
          writeSync(fd, pending, null, "utf8");
        } finally {
          closeSync(fd);
        }
        pending = "";
      }
    };
    return {
      write(t: string) {
        process.stdout.write(t);
        pending += t;
        flush();
      },
      close() {
        flush();
      },
    };
  };
  const sink = mkSink();

  // A truncation segment (head/tail/wc -l) rewrites into: run upstream fully, persist
  // to the session file, then display only the requested window with a pointer to full output.
  const isTrunc = (seg: string[]): "head" | "tail" | "wc" | null => {
    const base = seg[0]?.split("/").pop() ?? "";
    if (base === "head") return "head";
    if (base === "tail") return "tail";
    if (base === "wc") return "wc";
    return null;
  };

  // Run one pipeline group (segments joined by |), honoring a trailing truncator.
  const runGroup = async (
    segments: string[][],
  ): Promise<{ stdout: string; exit: number }> => {
    // Detect trailing truncator → rewrite.
    const last = segments.at(-1)!;
    const trunc = isTrunc(last);
    const upstream = trunc ? segments.slice(0, -1) : segments;
    const upCmd = (upstream.length ? upstream : [["true"]])
      .map((s) => s.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "))
      .join(" | ");
    const dl = deadlineFor(
      upstream[0],
      explicitS !== undefined
        ? explicitS
        : effectiveDeadline(p.cwd, HARD_DEADLINE),
      explicitS,
    );

    // Rewrite: `upstream | head -N` → run `upstream` fully, persist, slice N lines for display.
    if (trunc) {
      const proc = spawn(["/bin/bash", "-o", "pipefail", "-c", upCmd], {
        stdout: "pipe",
        stderr: "inherit",
        stdin: "inherit",
        cwd: p.cwd,
        env: p.env as any,
      });
      const timer = setTimeout(() => {
        try {
          proc.kill(9);
        } catch {}
      }, dl * 1000);
      const buf: string[] = [];
      const reader = proc.stdout!.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf.push(new TextDecoder().decode(value));
      }
      clearTimeout(timer);
      const raw = buf.join("");
      await proc.exited;
      sink.write(raw); // persist full upstream to the session file
      const lines = raw.split("\n");
      let win = lines;
      let note = "";
      if (trunc === "head") {
        const n = Number(last[1]?.replace("-", "") ?? 10) || 10;
        win = lines.slice(0, n);
        note = `[full output first ${lines.length} lines saved to session file]`;
      }
      if (trunc === "tail") {
        const n = Number(last[1]?.replace("-", "") ?? 10) || 10;
        win = lines.slice(-n);
        note = `[full output last ${lines.length} lines saved to session file]`;
      }
      if (trunc === "wc") {
        win = [`${lines.length - 1}`];
        note = `[full output (${lines.length - 1} lines) saved to session file; use the read tool on the file for the whole]`;
      }
      return {
        stdout: win.join("\n") + (note ? `\n${note}` : ""),
        exit: proc.exitCode ?? 1,
      };
    }

    // No truncator: run the pipeline normally, stream as it produces (live-persisted).
    if (
      segments.length === 1 &&
      !segments[0]
        .map((s) => s.split("/").pop())
        .filter(Boolean)
        .some((b) => bannedAsFirst.has(b)) &&
      segments[0][0] !== "/bin/bash"
    ) {
      const proc = spawn(segments[0], {
        stdout: "pipe",
        stderr: "inherit",
        stdin: "inherit",
        cwd: p.cwd,
        env: p.env as any,
      });
      const timer = setTimeout(() => {
        try {
          proc.kill(9);
        } catch {}
      }, dl * 1000);
      await Promise.all([
        proc.exited,
        streamReader(proc.stdout, sink),
        streamReader(proc.stderr, { out: "", write: () => {} }),
      ]);
      clearTimeout(timer);
      return { stdout: "", exit: proc.exitCode ?? 1 };
    }

    // Multi-segment pipe / cached bash: run whole pipeline, stream out (live-persisted).
    const proc = spawn(
      [
        "/bin/bash",
        "-o",
        "pipefail",
        "-c",
        segments
          .map((s) => s.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "))
          .join(" | "),
      ],
      {
        stdout: "pipe",
        stderr: "inherit",
        stdin: "inherit",
        cwd: p.cwd,
        env: p.env as any,
      },
    );
    const timer = setTimeout(() => {
      try {
        proc.kill(9);
      } catch {}
    }, dl * 1000);
    await Promise.all([
      proc.exited,
      streamReader(proc.stdout, sink),
      streamReader(proc.stderr, { out: "", write: () => {} }),
    ]);
    clearTimeout(timer);
    return { stdout: "", exit: proc.exitCode ?? 1 };
  };

  let exit = 0;
  let i = 0;
  while (i < p.segments.length) {
    // Collect a | group.
    const group: string[][] = [p.segments[i]];
    while (i < p.segments.length - 1 && p.ops[i] === "|") {
      group.push(p.segments[i + 1]);
      i++;
    }
    const res = await runGroup(group);
    if (res.stdout) {
      process.stdout.write(`\n${res.stdout}\n`);
      sink.write(`\n${res.stdout}\n`);
    }
    exit = res.exit;
    // Handle the op that follows this group (if any).
    if (i < p.segments.length - 1) {
      const op = p.ops[i];
      if (op === "&&" && exit !== 0) break; // short-circuit
      i++;
    } else {
      i++;
    }
  }
  sink.close();

  const elapsedMs = performance.now() - t0;
  let verdict: RunResult["verdict"];
  // Breach verdict must match the kill-timer deadline: honor the per-project
  // policy (and RF_DEADLINE) rather than only the hardcoded 2.0s base. When an
  // explicit deadline is active, verdict and kill-timer share the identical value.
  const verdictDeadline =
    explicitS !== undefined
      ? explicitS
      : effectiveDeadline(p.cwd, HARD_DEADLINE);
  if (elapsedMs > verdictDeadline * 1000) {
    verdict = "breach";
    urgentBreach(args, elapsedMs / 1000, p.cwd);
  } else if (exit !== 0) {
    verdict = "fail";
  } else {
    verdict = "ok";
  }

  // Persist full combined output (sink already wrote incrementally; meta confirms done).
  writeMeta(id, {
    id,
    cmd: args.slice(0, 6).join(" "),
    startTime: t0,
    endTime: Date.now(),
    exitCode: exit,
    state: "done",
  });

  if (!opts.quiet)
    process.stderr.write(
      `[two-sec ${verdict} ${(elapsedMs / 1000 || 0).toFixed(2)}s exit=${exit}] id=${id}\n`,
    );
  if (verdict !== "ok")
    logVerdict(p.cwd, {
      kind: verdict,
      elapsedMs: Math.round(elapsedMs),
      exit,
      command: args.slice(0, 4).join(" "),
    });
  return { verdict, elapsedMs, exitCode: exit };
}

export async function attachSession(id: string) {
  let meta = readMeta(id);
  if (!meta) {
    process.stderr.write(`[run-fast] session ${id} not found\n`);
    process.exit(1);
  }
  if (meta.state === "running") {
    let lastLen = 0;
    const poll = setInterval(() => {
      try {
        const c = readFileSync(outPath(id), "utf-8");
        if (c.length > lastLen) {
          process.stdout.write(c.slice(lastLen));
          lastLen = c.length;
        }
        meta = readMeta(id);
        if (meta?.state === "done") {
          clearInterval(poll);
          process.stderr.write(
            `[two-sec done exit=${meta.exitCode}] id=${id}\n`,
          );
        }
      } catch {}
    }, 50);
  } else {
    process.stdout.write(readFileSync(outPath(id), "utf-8"));
    process.stderr.write(`[two-sec done exit=${meta.exitCode}] id=${id}\n`);
  }
}

export async function logsSession(id?: string) {
  if (id) {
    try {
      process.stdout.write(readFileSync(outPath(id), "utf-8"));
    } catch {
      process.stdout.write("(no output)\n");
    }
  } else {
    const ss = getSessions();
    if (ss.length === 0) {
      process.stdout.write("(no sessions)\n");
      return;
    }
    for (const s of ss.slice(-20)) {
      try {
        const o = readFileSync(outPath(s.id), "utf-8")
          .slice(-200)
          .replace(/\n/g, " ");
        process.stdout.write(
          `id=${s.id} exit=${s.exitCode} ${s.state} ${s.cmd}\n  ${o}\n`,
        );
      } catch {
        process.stdout.write(
          `id=${s.id} exit=${s.exitCode} ${s.state} ${s.cmd}\n`,
        );
      }
    }
  }
}

export async function listSessions() {
  const ss = getSessions();
  if (ss.length === 0) {
    process.stdout.write("(no sessions)\n");
    return;
  }
  for (const s of ss)
    process.stdout.write(
      `id=${s.id} exit=${s.exitCode ?? "?"} ${s.state} ${s.cmd}\n`,
    );
}

export async function purgeSessions(pattern?: string) {
  const ss = getSessions();
  let r = 0;
  for (const s of ss) {
    if (pattern && !s.cmd.includes(pattern)) continue;
    deleteSession(s.id);
    r++;
  }
  process.stderr.write(`[run-fast] purged ${r} session(s)\n`);
}

export async function cancelSession(id: string) {
  try {
    const { execSync } = await import("node:child_process");
    for (const line of execSync(`pgrep -f "${id}" 2>/dev/null || true`, {
      encoding: "utf-8",
    })
      .trim()
      .split("\n")) {
      if (line.trim())
        try {
          process.kill(Number(line));
        } catch {}
    }
  } catch {}
  process.stderr.write(`[run-fast] cancelled ${id}\n`);
}

/**
 * runDetached — cutting-edge non-blocking mode: spawn a slow command in the
 * background, attach it to a session file, and return the id to the caller
 * IMMEDIATELY (sub-ms), so the LLM turn never blocks on a network/build/inflight
 * command. Follow up with `kairos attach|logs|cancel <id>`.
 *
 * This is the real latency win over the 2s kill: instead of CANCELLING a slow
 * command (wasting the call and forcing a retry), we hand it off and let the
 * agent keep reasoning. The session is observable, cancellable, and its output
 * is persisted exactly like a foreground run.
 */
export async function runDetached(
  args: string[],
  opts: { quiet?: boolean } = {},
): Promise<{ id: string }> {
  const p = parseArgs(args);
  const id = genId(p.sessionName);
  mkdirSync(SESSION_DIR, { recursive: true });

  const cmd =
    p.segments.length > 0
      ? p.segments
          .map((s) => s.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "))
          .join(" ")
      : "true";

  // Print the session id FIRST so an LLM/tool sees it before anything else.
  process.stderr.write(`[run-fast] session=${id} (detached)\n`);
  process.stderr.write(
    `[run-fast] follow: kairos attach ${id} | kairos logs ${id} | kairos cancel ${id}\n`,
  );

  writeMeta(id, {
    id,
    cmd: cmd.slice(0, 120),
    startTime: Date.now(),
    endTime: null,
    exitCode: null,
    state: "running",
  });

  const out = outPath(id);

  // Spawn fully detached: separate process group, output to the session file.
  // `null` cwd => inherit; env inherited so credentials/SSH agent reach the child.
  const proc = spawn(["/bin/bash", "-o", "pipefail", "-c", cmd], {
    cwd: p.cwd || process.cwd(),
    env: p.env as any,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const fd = openSync(out, "a");
  const tee = (buf: Uint8Array) => {
    try {
      writeSync(fd, buf, null, "utf8");
      if (!opts.quiet)
        process.stderr.write(
          `[run-fast ${id}] ` + new TextDecoder().decode(buf),
        );
    } catch {}
  };
  // Canonical Bun pattern (borrowed from bun docs): Subprocess.stdout is a
  // ReadableStream, which is natively async-iterable. No cast, no .forEach.
  const drain = async (rs: ReadableStream<Uint8Array> | null) => {
    if (!rs) return;
    for await (const chunk of rs) tee(chunk);
  };
  drain(proc.stdout as any).catch(() => {});
  drain(proc.stderr as any).catch(() => {});
  proc.unref();

  proc.exited.then((code) => {
    try {
      closeSync(fd);
    } catch {}
    writeMeta(id, {
      id,
      cmd: cmd.slice(0, 120),
      startTime: Date.now(),
      endTime: Date.now(),
      exitCode: code ?? 1,
      state: "done",
    });
    process.stderr.write(`[run-fast] done exit=${code} id=${id}\n`);
  });

  return { id };
}
