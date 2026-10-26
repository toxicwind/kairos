/**
 * The race engine — first VALID wins, hedged, with a winners ledger.
 *
 * Ported from hft-latency/bin/race.py (429 lines). This is the doctrine Chris
 * called out by name, so the semantics are preserved exactly rather than
 * tidied:
 *
 *   - FIRST VALID WINS: the first contestant to exit 0 with a matching output
 *     wins; losers are aborted immediately and the race returns.
 *   - The hedge is a single deadline, never a poll. With hedgeMs > 0 the
 *     best-known strategy launches alone at t=0; backups launch only if no
 *     valid result arrived by the deadline. A fast primary means the backups
 *     never run at all.
 *   - No orphans: every contestant starts in its own process group and is
 *     SIGKILLed as a group, so losers leave no children behind.
 *   - The winners ledger is the same file the Python engine writes, so hedged
 *     ordering improves across implementations and over time.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { WINNERS_LOG } from "./paths";

export const OUTPUT_CAP = 256 * 1024;

export type Strategy = {
  name: string;
  cmd: string[];
  match?: string;
  env?: Record<string, string>;
};

export type AttemptResult = {
  name: string;
  ok: boolean;
  valid: boolean;
  rc: number | null;
  error: string | null;
  output: string;
  outputTruncated: boolean;
  stderrTail: string;
  latencyS: number;
  /** Lost the race and was aborted. Distinct from a crash or a timeout. */
  cancelled: boolean;
};

export type RaceOutcome = {
  winner: string | null;
  winnerOutput: string;
  winnerTruncated: boolean;
  results: Record<string, AttemptResult>;
};

let emitStream: (line: string) => void = (line) => process.stderr.write(`${line}\n`);

/** JSONL telemetry on stderr, exactly as the Python engine emitted it. */
export function emit(event: Record<string, unknown>): void {
  emitStream(JSON.stringify(event));
}

export function setEmitter(fn: (line: string) => void): void {
  emitStream = fn;
}

async function drainCapped(stream: ReadableStream<Uint8Array> | null, cap: number): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: "", truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (size >= cap) {
        truncated = true;
        continue;
      }
      const room = Math.min(value.length, cap - size);
      chunks.push(room === value.length ? value : value.subarray(0, room));
      size += room;
    }
  } catch {
    /* stream closed under us; whatever drained is still worth reporting */
  }
  const merged = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    merged.set(chunk, at);
    at += chunk.length;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

/** Kill the whole process group. No orphans, no lingering children. */
function killGroup(pid: number): void {
  if (pid <= 0) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run one contestant. Never throws: a loser is a value, not an exception.
 * Aborting the signal means the contestant lost — kill its group and report.
 */
export async function runOne(strategy: Strategy, timeoutS: number, signal?: AbortSignal): Promise<AttemptResult> {
  const t0 = performance.now();
  const elapsed = (): number => (performance.now() - t0) / 1000;
  const base: AttemptResult = {
    name: strategy.name,
    ok: false,
    valid: false,
    rc: null,
    error: null,
    output: "",
    outputTruncated: false,
    stderrTail: "",
    latencyS: 0,
    cancelled: false,
  };
  const fail = (error: string): AttemptResult => ({ ...base, error, latencyS: elapsed() });

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(strategy.cmd, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, ...(strategy.env ?? {}) },
      detached: true, // own process group, so killGroup takes the whole tree
    });
  } catch (e) {
    return fail(`command-not-found: ${strategy.cmd[0]} (${(e as Error).message})`);
  }

  if (signal?.aborted) {
    killGroup(proc.pid);
    return { ...fail("aborted"), cancelled: true };
  }
  const onAbort = (): void => killGroup(proc.pid);
  signal?.addEventListener("abort", onAbort, { once: true });

  const drainOut = drainCapped(proc.stdout as ReadableStream<Uint8Array>, OUTPUT_CAP);
  const drainErr = drainCapped(proc.stderr as ReadableStream<Uint8Array>, OUTPUT_CAP);

  const timer = setTimeout(() => killGroup(proc.pid), timeoutS * 1000);
  const rc = await proc.exited;
  clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);

  const latency = elapsed();
  if (signal?.aborted) return { ...fail("aborted"), latencyS: latency, cancelled: true };
  if (latency >= timeoutS) return { ...fail(`timeout>${timeoutS}s`), latencyS: latency };

  const [{ text: output, truncated }, { text: errText }] = await Promise.all([drainOut, drainErr]);
  const valid = rc === 0 && (strategy.match === undefined || new RegExp(strategy.match, "s").test(output));
  return {
    name: strategy.name,
    ok: true,
    valid,
    rc,
    error: null,
    output: valid ? output : "",
    outputTruncated: valid && truncated,
    stderrTail: errText.slice(-2000),
    latencyS: latency,
    cancelled: false,
  };
}

type Contestant = { name: string; controller: AbortController; promise: Promise<AttemptResult> };

/** Re-emit NDJSON telemetry a contestant printed on its own stderr. */
function passthrough(stderrTail: string): void {
  for (const line of stderrTail.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes('"event"')) continue;
    try {
      emit(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      /* not telemetry */
    }
  }
}

/**
 * Race contestants. First VALID wins. Nothing is left running afterwards.
 *
 * hedgeMs = 0 launches everyone at t=0. hedgeMs > 0 launches the best-known
 * strategy alone and arms the backups against a single deadline.
 */
export async function runRace(
  strategies: Strategy[],
  opts: { raceId: string; tag: string; timeoutS: number; raceTimeoutS: number; hedgeMs?: number },
): Promise<RaceOutcome> {
  const { raceId, tag, timeoutS, raceTimeoutS, hedgeMs = 0 } = opts;
  const t0 = performance.now();
  const now = (): number => (performance.now() - t0) / 1000;
  const hedged = hedgeMs > 0 && strategies.length > 1;
  const ordered = hedged ? hedgeOrder(tag, strategies) : [...strategies];

  const results: Record<string, AttemptResult> = {};
  const inflight = new Map<string, Contestant>();
  let winner: string | null = null;
  let winnerOutput = "";
  let winnerTruncated = false;
  let backups: Strategy[] = [];
  let hedgeFired = false;
  let hedgeTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Completions land in a shared buffer and signal a shared wake. An earlier
   * version raced the in-flight promises directly, which snapshotted the set
   * at call time: strategies the hedge launched mid-iteration were never
   * awaited, so a winning backup would have been silently ignored.
   */
  const finished: AttemptResult[] = [];
  let wake: (() => void) | null = null;

  const launch = (s: Strategy): void => {
    const controller = new AbortController();
    emit({ event: "attempt_start", race_id: raceId, name: s.name, t_launch_s: now() });
    const promise = runOne(s, timeoutS, controller.signal);
    inflight.set(s.name, { name: s.name, controller, promise });
    promise.then((r) => {
      inflight.delete(s.name);
      finished.push(r);
      wake?.();
    });
  };

  emit({
    event: "race_start",
    race_id: raceId,
    tag,
    contestants: ordered.map((s) => s.name),
    launch_order: hedged ? ordered.map((s) => s.name) : null,
    hedge_ms: hedgeMs,
    timeout_s: timeoutS,
    race_timeout_s: raceTimeoutS,
  });

  if (hedged) {
    backups = ordered.slice(1);
    launch(ordered[0]!);
    emit({ event: "hedge_armed", race_id: raceId, hedge_ms: hedgeMs, primary: ordered[0]!.name, backups: backups.map((s) => s.name) });
    hedgeTimer = setTimeout(() => {
      if (winner || hedgeFired) return;
      hedgeFired = true;
      emit({ event: "hedge_fired", race_id: raceId, t_s: now(), backups: backups.map((s) => s.name) });
      for (const s of backups) launch(s);
      backups = [];
    }, hedgeMs);
  } else {
    for (const s of ordered) launch(s);
  }

  try {
    for (;;) {
      if (winner !== null) break;
      if (!finished.length) {
        if (!inflight.size) break;
        const remaining = raceTimeoutS - now();
        if (remaining <= 0) break;
        // The only clock in the loop: the race deadline. The hedge deadline
        // is a trigger, not a poll.
        const { promise: woke, resolve } = Promise.withResolvers<void>();
        wake = resolve;
        const clock = setTimeout(resolve, remaining * 1000);
        await woke;
        clearTimeout(clock);
        wake = null;
      }
      while (finished.length) {
        const r = finished.shift()!;
        results[r.name] = r;
        emit({ event: "attempt_done", race_id: raceId, name: r.name, ok: r.ok, valid: r.valid, latency_s: r.latencyS, error: r.error });
        passthrough(r.stderrTail);
        if (r.valid && winner === null) {
          winner = r.name;
          winnerOutput = r.output;
          winnerTruncated = r.outputTruncated;
        }
      }
    }
  } finally {
    // Stand down: if the primary won before the deadline the backups never ran.
    if (hedgeTimer) {
      clearTimeout(hedgeTimer);
      if (winner !== null) emit({ event: "hedge_standdown", race_id: raceId, winner, t_s: now() });
    }
    // Abort every loser. runOne's abort handler kills the process group, so
    // nothing is left running and no children are orphaned.
    for (const c of inflight.values()) c.controller.abort();
    await Promise.allSettled([...inflight.values()].map((c) => c.promise));
    // The loop broke on the winner, so the losers' completions are still in the
    // buffer. Without this the caller cannot tell a cancelled loser from a
    // contestant that never ran.
    while (finished.length) {
      const r = finished.shift()!;
      results[r.name] ??= r;
      emit({ event: "attempt_done", race_id: raceId, name: r.name, ok: r.ok, valid: r.valid, cancelled: r.cancelled, latency_s: r.latencyS, error: r.error });
    }
  }

  return { winner, winnerOutput, winnerTruncated, results };
}

export function loadStrategies(path: string): Strategy[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const list = Array.isArray(parsed) ? parsed : ((parsed as { strategies?: unknown })?.strategies ?? parsed);
  if (!Array.isArray(list)) throw new Error(`strategies file ${path} is not a list`);
  const strategies = list as Strategy[];
  for (const s of strategies) {
    if (!s?.name || !s?.cmd) throw new Error(`each strategy needs name + cmd: ${JSON.stringify(s)}`);
  }
  return strategies;
}

export type WinnerEntry = {
  ts: number;
  tag: string;
  winner: string;
  latency: Record<string, { latency_s: number }>;
};

export function logWinners(tag: string, winner: string, latency: Record<string, { latency_s: number }>, logPath: string = WINNERS_LOG): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify({ ts: Date.now() / 1000, tag, winner, latency })}\n`, "utf8");
  } catch {
    /* the ledger is an optimisation, never a correctness requirement */
  }
}

export function readWinners(tag: string, logPath: string = WINNERS_LOG): { wins: Record<string, number>; lats: Record<string, number[]> } {
  const wins: Record<string, number> = {};
  const lats: Record<string, number[]> = {};
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return { wins, lats };
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: WinnerEntry;
    try {
      entry = JSON.parse(line) as WinnerEntry;
    } catch {
      continue;
    }
    if (entry.tag !== tag) continue;
    if (entry.winner) wins[entry.winner] = (wins[entry.winner] ?? 0) + 1;
    for (const [name, r] of Object.entries(entry.latency ?? {})) {
      (lats[name] ??= []).push(r?.latency_s ?? 1e9);
    }
  }
  return { wins, lats };
}

function medianLatency(values: number[] | undefined): number {
  if (!values?.length) return 1e9;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function rankByRecord<T extends { name: string }>(items: T[], tag: string, logPath?: string): T[] {
  const { wins, lats } = readWinners(tag, logPath);
  return items
    .map((item, i) => ({ item, i }))
    .sort(
      (a, b) =>
        (wins[b.item.name] ?? 0) - (wins[a.item.name] ?? 0) ||
        medianLatency(lats[a.item.name]) - medianLatency(lats[b.item.name]) ||
        a.i - b.i,
    )
    .map((e) => e.item);
}

/** Best-known-first: most wins, then lowest median latency. Stable on ties. */
export function hedgeOrder(tag: string, strategies: Strategy[], logPath?: string): Strategy[] {
  return rankByRecord(strategies, tag, logPath);
}

export function leadWithWinner(
  tag: string,
  strategies: Strategy[],
): { tag: string; winCounts: Record<string, number>; ranked: { name: string; wins: number; medianLatencyS: number }[] } {
  const { wins, lats } = readWinners(tag);
  const ranked = rankByRecord(strategies, tag).map((s) => ({
    name: s.name,
    wins: wins[s.name] ?? 0,
    medianLatencyS: medianLatency(lats[s.name]),
  }));
  return { tag, winCounts: wins, ranked };
}