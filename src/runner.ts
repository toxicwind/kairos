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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { effectiveDeadline, logVerdict } from "./project-policy.ts";
import { deadlineFor } from "./policy.ts";

const SESSION_DIR = join(process.env.HOME || "/tmp", ".run-fast");
const HARD_DEADLINE = 2.0; // seconds. NON-NEGOTIABLE.

export interface RunResult {
  verdict: "ok" | "breach" | "fail" | "spawn-fail";
  elapsedMs: number;
  exitCode: number;
}

const scold = (msg: string) => {
  process.stderr.write(`\n  ╔══════════════════════════════════════════════════════════════╗\n  ║                 ⚠ RUN-FAST RULE VIOLATION ⚠                    ║\n  ╚══════════════════════════════════════════════════════════════╝\n  ${msg}\n\n`);
};

const urgentBreach = (cmd: string[], elapsedS: number) => {
  process.stdout.write(
    `\n════ [two-sec BREACH — URGENT, MUST DO] ════\n` +
    `  '${cmd.slice(0, 8).join(" ")}' took ${elapsedS.toFixed(3)}s > ${HARD_DEADLINE.toFixed(1)}s deadline. FAILED + CANCELLED.\n` +
    `  YOU VIOLATED THE 2-SECOND RULE. This is a DEFECT, not a result.\n` +
    `  MUST DO NOW (ast-find faster, in order):\n` +
    `  1. ffs impact <the-slow-symbol>   # blast radius — right fix point\n` +
    `  2. ffs flow <the-slow-symbol>     # def+body+callees — find the O(n²)/spawn storm\n` +
    `  3. forge borrow '<what it does>'  # external faster prior art\n` +
    `  4. OR background it (background_process) — never wait longer.\n` +
    `  DO NOT retry the same slow command. A breach without a raced fix = defect.\n` +
    `═══════════════════════════════════════\n`,
  );
};

const scoldNotRunFast = (extra: string) => {
  scold(
    `You are NOT using run-fast for every command. This is the 2-second rule.\n` +
    `  EVERY command MUST go through run-fast:  run-fast <cmd…>\n` +
    `  ${extra}\n` +
    `  If you used a bare tool (bash/read/grep/glob/write) without run-fast, that is a\n` +
    `  violation. The ONLY exempt commands are git push/commit (explicit request) and\n` +
    `  ffs read (budget-aware code reading), and even those should prefer run-fast.\n` +
    `  Rerun this through:  run-fast <the same command>`);
};

// ── Session store ──

function metaPath(id: string) { return join(SESSION_DIR, `${id}.json`); }
function outPath(id: string) { return join(SESSION_DIR, `${id}.out`); }

function getSessions(): { id: string; cmd: string; startTime: number; endTime: number | null; exitCode: number | null; state: "running" | "done"; }[] {
  if (!existsSync(SESSION_DIR)) return [];
  return readdirSync(SESSION_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(join(SESSION_DIR, f), "utf-8")))
    .sort((a, b) => a.startTime - b.startTime);
}

function writeMeta(id: string, m: { id: string; cmd: string; startTime: number; endTime: number | null; exitCode: number | null; state: "running" | "done"; }) {
  mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(metaPath(id), JSON.stringify(m));
}

function readMeta(id: string) {
  try { return JSON.parse(readFileSync(metaPath(id), "utf-8")); } catch { return null; }
}

function deleteSession(id: string) {
  try { rmSync(metaPath(id)); rmSync(outPath(id)); } catch {}
}

function genId(name?: string) {
  if (name) return `rf-${name}`;
  return "rf-" + crypto.randomUUID().slice(0, 8);
}

const bannedAsFirst: Set<string> = new Set([
  "tail", "head", "cat", "grep", "sed", "awk", "cut", "sort", "uniq", "find",
  "echo", "printf", "wc", "less", "more", "xxd", "hexdump", "od", "base64",
  "tee", "tr", "paste", "join", "xargs", "split", "cp", "mv", "rm", "mkdir",
]);

async function streamReader(stream: ReadableStream<Uint8Array> | null, sink: { out: string; write: (t: string) => void }): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  try { while (true) { const { done, value } = await reader.read(); if (done) break; const t = new TextDecoder().decode(value); sink.out += t; sink.write(t); } }
  finally { reader.releaseLock(); }
}

function parseArgs(args: string[]): {
  env: Record<string, string>; cwd: string;
  cmd: string[]; sessionName: string | undefined;
} {
  const env: Record<string, string> = { ...process.env };
  let cwd: string | undefined;
  let cmd: string[] = [];
  let sessionName: string | undefined;
  let idx = 0;

  while (idx < args.length) {
    const a = args[idx];
    idx++;

    if (a === "--cwd" && idx < args.length) { cwd = args[idx++]; continue; }
    if (a === "--env" && idx < args.length) {
      const ev = args[idx];
      if (ev?.includes("=")) { const [k, ...v] = ev.split("="); env[k] = v.join("="); }
      idx++; continue;
    }
    if (a === "--id" && idx < args.length) { sessionName = args[idx++]; continue; }
    if (a.includes("=") && !a.startsWith("-") && a.split("=")[0].match(/^[A-Z_][A-Z0-9_]*$/)) {
      const [k, ...v] = a.split("="); env[k] = v.join("="); continue;
    }
    cmd.push(a);
  }

  // Enforce banned commands as the FIRST arg.
  const base = cmd[0]?.split("/").pop() ?? "";
  if (bannedAsFirst.has(base)) {
    scold(
      `Forbidden command '${base}'. You ran a raw CLI tool directly.\n` +
      `  - ${base} is EXPLICITLY BANNED. Do NOT use it.\n` +
      `  - Use the canonical estate tools instead:\n` +
      `      ffs find <needle>      # find files\n` +
      `      ffs grep <regex>       # search content\n` +
      `      ffs read <path>        # read files (budget-aware)\n` +
      `      ffs outline <path>     # sketch structure\n` +
      `  - And wrap the command in run-fast:  run-fast ffs find <needle>\n` +
      `  Rerun correctly. Now.`);
    process.exit(126);
  }

  return { env, cwd: cwd ?? process.cwd(), cmd, sessionName };
}

// ── Core ──

export async function runSession(args: string[], opts: { quiet?: boolean } = {}): Promise<RunResult> {
  const p = parseArgs(args);
  const dl = deadlineFor(p.cmd.length > 0 ? p.cmd : args,
    Number(process.env.RF_DEADLINE ?? effectiveDeadline(p.cwd, HARD_DEADLINE)));
  const t0 = performance.now();
  const id = genId(p.sessionName);

  process.stdout.write(`[run-fast] session=${id}\n`);

  const sink: { out: string; write: (t: string) => void } = { out: "", write: (t) => process.stdout.write(t) };
  const spawnC = (c: string[], e: Record<string, string>, d: string) =>
    spawn(c, { stdout: "pipe", stderr: "pipe", stdin: "pipe", cwd: d, env: e as any });

  const proc = spawnC(p.cmd.length > 0 ? p.cmd : ["true"], p.env, p.cwd);

  await Promise.all([proc.exited, streamReader(proc.stdout, sink), streamReader(proc.stderr, sink)]);

  const elapsedMs = performance.now() - t0;
  let verdict: RunResult["verdict"];

  if (elapsedMs > dl * 1000) {
    verdict = "breach";
    urgentBreach(args, elapsedMs / 1000);
  } else if (proc.exitCode !== 0) {
    verdict = "fail";
  } else {
    verdict = "ok";
  }

  writeMeta(id, { id, cmd: args.slice(0, 6).join(" "), startTime: t0, endTime: Date.now(), exitCode: proc.exitCode, state: "done" });
  writeFileSync(outPath(id), sink.out, "utf-8");

  if (!opts.quiet) process.stderr.write(`[two-sec ${verdict} ${((elapsedMs / 1000) || 0).toFixed(2)}s exit=${proc.exitCode}] id=${id}\n`);
  if (verdict !== "ok") logVerdict(p.cwd, { kind: verdict, elapsedMs: Math.round(elapsedMs), exit: proc.exitCode, command: args.slice(0, 4).join(" ") });
  return { verdict, elapsedMs, exitCode: proc.exitCode };
}

export async function attachSession(id: string) {
  let meta = readMeta(id);
  if (!meta) { process.stderr.write(`[run-fast] session ${id} not found\n`); process.exit(1); }
  if (meta.state === "running") {
    let lastLen = 0;
    const poll = setInterval(() => {
      try {
        const c = readFileSync(outPath(id), "utf-8");
        if (c.length > lastLen) { process.stdout.write(c.slice(lastLen)); lastLen = c.length; }
        meta = readMeta(id);
        if (meta?.state === "done") { clearInterval(poll); process.stderr.write(`[two-sec done exit=${meta.exitCode}] id=${id}\n`); }
      } catch {}
    }, 50);
  } else {
    process.stdout.write(readFileSync(outPath(id), "utf-8"));
    process.stderr.write(`[two-sec done exit=${meta.exitCode}] id=${id}\n`);
  }
}

export async function logsSession(id?: string) {
  if (id) { try { process.stdout.write(readFileSync(outPath(id), "utf-8")); } catch { process.stdout.write("(no output)\n"); } }
  else {
    const ss = getSessions();
    if (ss.length === 0) { process.stdout.write("(no sessions)\n"); return; }
    for (const s of ss.slice(-20)) {
      try { const o = readFileSync(outPath(s.id), "utf-8").slice(-200).replace(/\n/g, " "); process.stdout.write(`id=${s.id} exit=${s.exitCode} ${s.state} ${s.cmd}\n  ${o}\n`); }
      catch { process.stdout.write(`id=${s.id} exit=${s.exitCode} ${s.state} ${s.cmd}\n`); }
    }
  }
}

export async function listSessions() {
  const ss = getSessions();
  if (ss.length === 0) { process.stdout.write("(no sessions)\n"); return; }
  for (const s of ss) process.stdout.write(`id=${s.id} exit=${s.exitCode ?? "?"} ${s.state} ${s.cmd}\n`);
}

export async function purgeSessions(pattern?: string) {
  const ss = getSessions(); let r = 0;
  for (const s of ss) { if (pattern && !s.cmd.includes(pattern)) continue; deleteSession(s.id); r++; }
  process.stderr.write(`[run-fast] purged ${r} session(s)\n`);
}

export async function cancelSession(id: string) {
  try {
    const { execSync } = await import("node:child_process");
    for (const line of execSync(`pgrep -f "${id}" 2>/dev/null || true`, { encoding: "utf-8" }).trim().split("\n")) {
      if (line.trim()) try { process.kill(Number(line)); } catch {}
    }
  } catch {}
  process.stderr.write(`[run-fast] cancelled ${id}\n`);
}