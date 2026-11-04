/**
 * speculate.ts — KHSR Tier 0/1: the speculative-race trigger.
 *
 * `kairos run --max-time N --deadline M <cmd>`:
 *   Tier 0 (0–N s): run the command FOREGROUND, streaming inline. If it finishes
 *     within max-time, return its output + exit code normally — zero speculation
 *     overhead.
 *   Tier 1 (at N s breach): do NOT kill. Detach the original (it keeps running in
 *     its own process group, output persisted to the session file), write a
 *     speculation record `{id, shape, breachAt, deadlineAt}`, and return the
 *     session id immediately. Hephaistos (Tier 2) races a faster candidate
 *     against the original; first-to-correct wins (Tier 3); the ledger learns
 *     (Tier 4).
 *
 * The original is NEVER killed by the speculation — it is the fallback of last
 * resort. deadlineAt = breachAt + (--deadline, default 90s) is hephaistos's
 * budget, not a blocking wait on the agent call (which returns at the Tier-1
 * handoff).
 */
import { spawn } from "bun";
import { existsSync, mkdirSync, openSync, writeSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { genId, outPath, sessionDir, writeMeta } from "./session.ts";
import { sessionLine } from "./notice.ts";

/** Default speculation window (seconds) hephaistos has after a breach. */
export const DEFAULT_DEADLINE_S = 90;

/**
 * Minimum remaining window (seconds) for speculation to be VIABLE. The race
 * needs boot + lane spin-up + cheap verify before it can possibly beat the
 * original; if the original's remaining budget is smaller, invoking hephaistos
 * is guaranteed waste (the original always wins — the race never even finishes
 * booting). Edge case class: `--max-time 2 --deadline 10` on a 3s command —
 * the original finishes at 3s while hephaistos is still processing the prompt.
 */
export const MIN_VIABLE_RACE_S = Number(process.env.KAIROS_MIN_RACE_S || 5);

export interface SpeculationRecord {
  id: string;
  shape: string;
  breachAt: number;
  deadlineAt: number;
  state: "running" | "done" | "failed";
  winner?: "original" | "candidate";
}

export function speculationPath(id: string): string {
  return join(sessionDir(), `${id}.spec.json`);
}

export function writeSpeculation(rec: SpeculationRecord) {
  mkdirSync(sessionDir(), { recursive: true });
  writeFileAtomic(speculationPath(rec.id), JSON.stringify(rec));
}

export function readSpeculation(id: string): SpeculationRecord | null {
  try {
    return JSON.parse(readFileSync(speculationPath(id), "utf-8")) as SpeculationRecord;
  } catch {
    return null;
  }
}

function writeFileAtomic(p: string, data: string) {
  const fd = openSync(p, "w");
  try {
    writeSync(fd, data, null, "utf8");
  } finally {
    closeSync(fd);
  }
}

export interface SpeculativeResult {
  verdict: "ok" | "breach";
  id: string;
  exitCode: number | null;
  stdout: string;
}

/** Resolve the race entrypoint: KAIROS_RACE_BIN (tests) else the hephaistos code-race plugin. */
export function raceBin(): string {
  return (
    process.env.KAIROS_RACE_BIN ||
    process.env.DELEND_CODE_RACE ||
    "/home/toxic/pens/ergasterion/products/hephaistos/plugins/code-race/src/index.ts"
  );
}

/**
 * Tier 2 — invoke the hephaistos race entrypoint with {id, shape, deadlineAt}
 * JSON on stdin. Fire-and-forget: the agent call already returned; the race
 * runs in its own process and its verdict lands via the ledger/attach channel.
 */
export async function invokeRace(
  id: string,
  shape: string,
  deadlineAt: number,
): Promise<void> {
  const bin = raceBin();
  if (!bin || !existsSync(bin)) return;
  const payload = JSON.stringify({
    id,
    shape,
    deadlineAt,
    // Guidance for the smith: the winning candidate is often the REMOVAL of a
    // trivially-removable command (sleep, pointless waits) — "find a faster
    // sleep" is the wrong answer; "no sleep at all" is the right one.
    hint: "the fastest correct command may be the command removed",
  });
  // Detached spawn: the race OUTLIVES the agent call (the CLI exits at the
  // Tier-1 handoff; a non-detached child dies with it — observed as empty/partial
  // race payloads in testing). Bun's detached spawn exposes no writable stdin
  // stream, so the payload is staged to a temp file and redirected via the shell.
  const payloadFile = join(sessionDir(), `${id}.race-payload.json`);
  writeFileAtomic(payloadFile, payload);
  const proc = spawn(
    ["/bin/bash", "-c", `bun "${bin}" < "${payloadFile}"`],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    },
  );
  proc.unref();
  await proc.exited;
}

export interface CandidateVerdict {
  cmd: string;
  sampleSpeedup: number;
}

/**
 * Tier 2 verify gate (megakernel-style cheap verify): a candidate may only
 * enter the race if it produces the SAME output shape on a sample AND is
 * strictly faster than the baseline. Anything else is discarded (null) —
 * never raced.
 */
export async function verifyCandidate(
  candidateCmd: string,
  baseline: () => Promise<{ stdout: string; exitCode: number }>,
  expectedShape: string,
): Promise<CandidateVerdict | null> {
  // Sample-run the candidate.
  const t0 = performance.now();
  const proc = spawn(["/bin/bash", "-o", "pipefail", "-c", candidateCmd], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const buf: string[] = [];
  const reader = proc.stdout!.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf.push(new TextDecoder().decode(value));
  }
  await proc.exited;
  const candidateMs = performance.now() - t0;
  const candidateOut = buf.join("");

  // Output-shape gate: same output, else discard.
  if (candidateOut !== expectedShape) return null;
  if ((proc.exitCode ?? 1) !== 0) return null;

  // Speed gate: strictly faster than the baseline on the sample, else discard.
  const b0 = performance.now();
  const base = await baseline();
  const baselineMs = performance.now() - b0;
  if (base.stdout !== expectedShape) return null;
  if (candidateMs >= baselineMs) return null;

  return { cmd: candidateCmd, sampleSpeedup: baselineMs / candidateMs };
}

/**
 * Run a command under the speculative-race contract. When `maxTimeS` is set and
 * the command breaches it, the original is detached (kept running) and a
 * speculation record is written; the caller gets the session id back immediately.
 */
export async function runSpeculative(
  cmd: string,
  opts: {
    maxTimeS: number;
    deadlineS: number;
    cwd?: string;
    env?: Record<string, string | undefined>;
  },
): Promise<SpeculativeResult> {
  const id = genId();
  mkdirSync(sessionDir(), { recursive: true });
  const out = outPath(id);

  writeMeta(id, {
    id,
    cmd: cmd.slice(0, 120),
    startTime: Date.now(),
    endTime: null,
    exitCode: null,
    state: "running",
  });

  // Redirect stdout+stderr to the session file via the shell. The CLI holds NO
  // pipe to the grandchild, so a detached (Tier-1) grandchild can never keep the
  // CLI's stdout open or the event loop alive past the handoff. Tier 0 reads the
  // file after completion; Tier 1 leaves the output in the file for attach/logs.
  //
  // Re-entry guard: the child must NOT inherit RF_MAX_TIME (or it would re-trigger
  // speculation and recurse) and must mark RUN_FAST_ACTIVE so the bash shim uses
  // the real binary instead of re-routing through kairos.
  const childEnv: Record<string, string | undefined> = {
    ...(opts.env || process.env),
    RF_MAX_TIME: undefined,
    RUN_FAST_ACTIVE: "1",
  };
  const proc = spawn(
    ["/bin/bash", "-o", "pipefail", "-c", `${cmd} >> "${out}" 2>&1`],
    {
      cwd: opts.cwd || process.cwd(),
      env: childEnv,
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    },
  );

  const t0 = Date.now();
  const breachAt = t0 + opts.maxTimeS * 1000;
  const deadlineAt = breachAt + opts.deadlineS * 1000;

  // Wait for completion, bounded by max-time. A cancellable timer fires the
  // breach only if the process is still running at max-time; if the process
  // exits first, the timer is cleared so it never keeps the event loop alive.
  let timer: ReturnType<typeof setTimeout> | null = null;
  const breached = new Promise<{ code: null; breached: true }>((resolve) => {
    const wait = breachAt - Date.now();
    timer = setTimeout(
      () => resolve({ code: null, breached: true }),
      Math.max(0, wait),
    );
  });
  const completed = await Promise.race([
    proc.exited.then((code) => {
      if (timer) clearTimeout(timer);
      return { code, breached: false };
    }),
    breached,
  ]);

  if (completed.breached) {
    // Tier 1: detach. The original keeps running (proc is detached + unref'd).
    // Write the speculation record and return the id immediately.
    proc.unref();
    // The 90s window is measured from the RECORDED breach moment — derive
    // deadlineAt from the same timestamp written to the record (never from a
    // precomputed value; a 1ms clock tick made them disagree in testing).
    const breachMs = Date.now();
    writeSpeculation({
      id,
      shape: cmd,
      breachAt: breachMs,
      deadlineAt: breachMs + opts.deadlineS * 1000,
      state: "running",
    });
    // The session id IS the return value of the breach handoff (the caller —
    // agent or hephaistos — needs it to attach/logs/cancel). Not a diagnostic
    // banner: emitted on stdout unconditionally, machine-parseable.
    process.stdout.write(`session=${id} (speculative, detached at ${opts.maxTimeS}s)\n`);
    sessionLine(`follow: kairos attach ${id} | kairos logs ${id} | kairos cancel ${id}`);
    // Tier 3 viability gate: if the original's remaining budget cannot beat the
    // race's boot+verify cost, invoking hephaistos is guaranteed waste (the
    // original always finishes before the race even boots). Skip the race —
    // the original is the winner by construction.
    const remainingS = (breachMs + opts.deadlineS * 1000 - Date.now()) / 1000;
    if (remainingS >= MIN_VIABLE_RACE_S) {
      // Tier 2: hand the speculation to hephaistos — fire-and-forget from the
      // agent's perspective (the agent call already returned the id). The race
      // entrypoint gets {id, shape, deadlineAt} JSON on stdin.
      invokeRace(id, cmd, breachMs + opts.deadlineS * 1000).catch(() => {});
    } else {
      sessionLine(
        `viability: remaining ${remainingS.toFixed(1)}s < ${MIN_VIABLE_RACE_S}s boot cost — no race, original wins`,
      );
    }
    return { verdict: "breach", id, exitCode: null, stdout: "" };
  }

  // Tier 0: completed within max-time. Finalize meta and return the output.
  const exitCode = completed.code ?? 1;
  writeMeta(id, {
    id,
    cmd: cmd.slice(0, 120),
    startTime: t0,
    endTime: Date.now(),
    exitCode,
    state: "done",
  });
  let stdout = "";
  try {
    stdout = readFileSync(out, "utf-8");
  } catch {}
  return { verdict: "ok", id, exitCode, stdout };
}