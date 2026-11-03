/**
 * runner.ts — run-fast: the 2s deadline wrapper. MOSTLY INVISIBLE.
 *
 * Subcommands:
 *   run <cmd…>          the ONLY way commands should run. Deadline-capped.
 *   attach <id>         attach to live/historic session
 *   logs [id]           session output
 *   list                list sessions
 *   purge [pattern]     remove sessions
 *   cancel <id>         kill session
 *
 * kairos fixes, it doesn't scold: slow routes detach, banned tools rewrite
 * invisibly, breaches auto-race. The agent's transcript stays clean — all
 * diagnostic banners are gated behind KAIROS_DEBUG=1 (see notice.ts).
 *
 * Inline syntax in run args:
 *   FOO=bar              → env var
 *   --cwd /path          → working directory
 *   --id name            → session name
 */
import { spawn } from "bun";
import { openSync, writeSync, closeSync, readFileSync, mkdirSync } from "node:fs";
import { effectiveDeadline, logVerdict } from "./project-policy.ts";
import { deadlineFor, shouldDetach } from "./policy.ts";
import { shellQuoteCmd, segmentsToCmd } from "./quote.ts";
import {
  bannedAsFirst,
  rewriteBanned,
  isStrict,
  why,
  replacementFor,
} from "./rewrite.ts";
import {
sessionDir,
  getSessions,
  writeMeta,
  readMeta,
  deleteSession,
  genId,
  outPath,
} from "./session.ts";
import { scold, urgentBreach, notice, sessionLine } from "./notice.ts";

const HARD_DEADLINE = 4.0; // seconds (4s shim doctrine). NON-NEGOTIABLE.
const DELEND_CODE_RACE =
  process.env.DELEND_CODE_RACE ||
  "/home/toxic/pens/ergasterion/hephaistos/plugins/code-race/src/index.ts";

export interface RunResult {
  verdict: "ok" | "breach" | "fail" | "spawn-fail";
  elapsedMs: number;
  exitCode: number;
}

async function streamReader(
  stream: ReadableStream<Uint8Array> | null | undefined,
  sink: { write: (t: string) => void },
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
    }
  } finally {
    reader.releaseLock();
  }
}

function parseArgs(args: string[]): {
  env: Record<string, string | undefined>;
  cwd: string;
  segments: string[][];
  ops: Array<"|" | "&&" | ";">;
  sessionName: string | undefined;
} {
  const env: Record<string, string | undefined> = { ...process.env };
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
    // Only match the shell flag at index 0 (the command position). A `-l` deep
    // in the args (e.g. `wc -l file`, `ls -l`) is a real command flag, not the
    // bash login flag — matching it there would corrupt the command.
    const dashIdx = cmd.findIndex(
      (c, i) => i === 0 && (c === "-c" || c === "-lc" || c === "-l" || c === "--login"),
    );
    if (dashIdx !== -1 && dashIdx + 1 < cmd.length) {
      // Use `bash -c`, NOT `bash -lc`, for the coerced one-shot shell. `-lc`
      // sources the login shell, which loads the estate `.bashrc` wrappers that
      // re-route `git`/`kairos` — so a wrapped `kairos run -lc 'git rebase'`
      // spawned an unbounded recursion of `bun run kairos ... git ...`. The
      // child already inherits run-fast's env; a login shell only re-triggers
      // the wrappers. Use `bash -c` → the real binary is reached, no re-entry.
      segments[0] = ["/bin/bash", "-c", cmd.slice(dashIdx + 1).join(" ")];
    }
  }

  // Ban check on EVERY segment's first command — AUTONOMOUS (fix, don't scold):
  // rewrite the offending tool to its sanctioned equivalent and RUN it, so the
  // agent's work never dead-ends on a message. Silent when a rewrite exists.
  // `KAIROS_STRICT=1` restores the old hard-cancel for hosts that want
  // enforcement, not autonomy.
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    const base = seg[0]?.split("/").pop() ?? "";
    if (!bannedAsFirst.has(base)) continue;
    const rewritten = rewriteBanned(seg);
    if (rewritten && !isStrict()) {
      // INVISIBLE rewrite: swap the command and run it. The agent sees the
      // sanctioned equivalent's output with no notice.
      segments[si] = rewritten;
      continue;
    }
    if (isStrict()) {
      scold(
        `HARD-BLOCKED '${base}' (KAIROS_STRICT). WHY: ${why(base)}. DO INSTEAD: ${replacementFor(base)}`,
      );
      process.exit(126);
    }
    // No 1:1 rewrite available and not strict: run it as-is, silently.
    notice(
      `autonomous: '${base}' runs as-is (no safe rewrite). prefer: ${replacementFor(base)}`,
    );
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
  sessionLine(`session=${id}`);

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
    mkdirSync(sessionDir(), { recursive: true });
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

  // Run one pipeline group (segments joined by |), streaming live as it produces.
  // `cmd | head`/`| tail`/`| wc` are MITM-stripped: kairos REMOVES the trailing
  // truncator, runs the command FULLY, and returns the complete output — as if
  // the truncation never happened. LLMs flail by truncating everything; kairos
  // says "fuck that": nothing is ever sliced, nothing is ever lost. The full
  // output is also persisted to the session file.
  const runGroup = async (
    segments: string[][],
  ): Promise<{ stdout: string; exit: number }> => {
    const dl = deadlineFor(
      segments[0],
      explicitS !== undefined
        ? explicitS
        : effectiveDeadline(p.cwd, HARD_DEADLINE),
      explicitS,
    );

    // MITM rewrite: detect a trailing truncator (head/tail/wc) with an upstream.
    const last = segments.at(-1)!;
    const upstream = segments.slice(0, -1);
    const trunc: "head" | "tail" | "wc" | null =
      upstream.length && last.length
        ? (["head", "tail", "wc"] as const).find(
            (t) => last[0].split("/").pop() === t,
          ) ?? null
        : null;

    // MITM: strip the trailing truncator, run the upstream FULLY, return every
    // byte. The truncator is dropped from the command entirely — head/tail/wc
    // never happened.
    if (trunc) {
      const upCmd = upstream.map((s) => shellQuoteCmd(s)).join(" | ");
      const proc = spawn(["/bin/bash", "-o", "pipefail", "-c", upCmd], {
        stdout: "pipe",
        stderr: "inherit",
        stdin: "inherit",
        cwd: p.cwd,
        env: p.env,
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
      return {
        stdout: raw,
        exit: proc.exitCode ?? 1,
      };
    }

    // MITM: single-segment file truncation — `head file`/`tail file`/`wc file`.
    // Run `cat file` fully and return the complete contents — the truncator
    // never happened.
    const singleBase = segments[0][0]?.split("/").pop() ?? "";
    if (
      segments.length === 1 &&
      (singleBase === "head" || singleBase === "tail" || singleBase === "wc")
    ) {
      const fileArg = segments[0].slice(1).find((a) => !a.startsWith("-") && a !== "-");
      if (fileArg) {
        const proc = spawn(["/bin/bash", "-o", "pipefail", "-c", `cat ${shellQuoteCmd([fileArg])}`], {
          stdout: "pipe",
          stderr: "inherit",
          stdin: "inherit",
          cwd: p.cwd,
          env: p.env,
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
        sink.write(raw);
        return {
          stdout: raw,
          exit: proc.exitCode ?? 1,
        };
      }
    }

    // Run the pipeline normally, stream as it produces (live-persisted).
    if (
      segments.length === 1 &&
      !segments[0]
        .map((s) => s.split("/").pop())
        .filter((s): s is string => Boolean(s))
        .some((b) => bannedAsFirst.has(b)) &&
      segments[0][0] !== "/bin/bash"
    ) {
      const proc = spawn(segments[0], {
        stdout: "pipe",
        stderr: "inherit",
        stdin: "inherit",
        cwd: p.cwd,
        env: p.env,
      });
      const timer = setTimeout(() => {
        try {
          proc.kill(9);
        } catch {}
      }, dl * 1000);
      await Promise.all([
        proc.exited,
        streamReader(proc.stdout, sink),
        streamReader(proc.stderr, { write: () => {} }),
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
        segments.map((s) => shellQuoteCmd(s)).join(" | "),
      ],
      {
        stdout: "pipe",
        stderr: "inherit",
        stdin: "inherit",
        cwd: p.cwd,
        env: p.env,
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
      streamReader(proc.stderr, { write: () => {} }),
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
    urgentBreach(args, elapsedMs / 1000, verdictDeadline);
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

  sessionLine(`${verdict} ${(elapsedMs / 1000 || 0).toFixed(2)}s exit=${exit} id=${id}`);
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
    scold(`session ${id} not found`);
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
          sessionLine(`done exit=${meta.exitCode} id=${id}`);
        }
      } catch {}
    }, 50);
  } else {
    process.stdout.write(readFileSync(outPath(id), "utf-8"));
    sessionLine(`done exit=${meta.exitCode} id=${id}`);
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
  sessionLine(`purged ${r} session(s)`);
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
  sessionLine(`cancelled ${id}`);
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
  mkdirSync(sessionDir(), { recursive: true });

  // Lossless: preserve every arg boundary AND the operators between segments —
  // the old `join(" ")` turned `a && b` into `a b` and stripped inner quotes.
  const cmd = p.segments.length > 0 ? segmentsToCmd(p.segments, p.ops) : "true";

  // Print the session id FIRST so an LLM/tool sees it before anything else.
  sessionLine(`session=${id} (detached)`);
  sessionLine(`follow: kairos attach ${id} | kairos logs ${id} | kairos cancel ${id}`);

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
    env: p.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const fd = openSync(out, "a");
  const tee = (buf: Uint8Array) => {
    try {
      const s = new TextDecoder().decode(buf);
      writeSync(fd, s, null, "utf8");
      if (!opts.quiet) sessionLine(`[${id}] ` + s);
    } catch {}
  };
  const drain = async (rs: ReadableStream<Uint8Array> | null) => {
    if (!rs) return;
    for await (const chunk of rs) tee(chunk);
  };
  drain(proc.stdout).catch(() => {});
  drain(proc.stderr).catch(() => {});
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
    sessionLine(`done exit=${code} id=${id}`);
  });

  return { id };
}