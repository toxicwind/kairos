/**
 * Timing helpers — the measurement half of the latency doctrine.
 *
 * Ported from hft-latency/bin/measure.py (88 lines): now_us, measure, timed,
 * main. Microsecond resolution, structured output, and a single clock
 * (performance.now) so nothing drifts between calls.
 */

import { emit } from "./concurrent";

export function nowUs(): number {
  return performance.now() * 1000;
}

export type Measurement = {
  name: string;
  tag: string;
  latencyS: number;
  latencyUs: number;
  ok: boolean;
  error: string | null;
};

export function measure(name: string, tag: string, fn: () => unknown): Measurement {
  const t0 = nowUs();
  let ok = true;
  let error: string | null = null;
  try {
    fn();
  } catch (e) {
    ok = false;
    error = (e as Error).message;
  }
  const latencyUs = nowUs() - t0;
  const m: Measurement = { name, tag, latencyS: latencyUs / 1e6, latencyUs, ok, error };
  emit({ event: "measure", ...m });
  return m;
}

/** Time an async operation with the same contract as measure(). */
export async function measureAsync(name: string, tag: string, fn: () => Promise<unknown>): Promise<Measurement> {
  const t0 = nowUs();
  let ok = true;
  let error: string | null = null;
  try {
    await fn();
  } catch (e) {
    ok = false;
    error = (e as Error).message;
  }
  const latencyUs = nowUs() - t0;
  const m: Measurement = { name, tag, latencyS: latencyUs / 1e6, latencyUs, ok, error };
  emit({ event: "measure", ...m });
  return m;
}

/** Wrap a function so every call is measured automatically. */
export function timed<A extends unknown[], R>(name: string, tag: string, fn: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    const t0 = nowUs();
    const result = fn(...args);
    const latencyUs = nowUs() - t0;
    emit({ event: "measure", name, tag, latencyS: latencyUs / 1e6, latencyUs, ok: true, error: null });
    return result;
  };
}

export type Distribution = {
  count: number;
  minUs: number;
  p50Us: number;
  p95Us: number;
  p99Us: number;
  maxUs: number;
  meanUs: number;
};

/** Latency is a correctness criterion, so report the distribution, not a mean. */
export function distribution(samplesUs: readonly number[]): Distribution {
  if (!samplesUs.length) {
    return { count: 0, minUs: 0, p50Us: 0, p95Us: 0, p99Us: 0, maxUs: 0, meanUs: 0 };
  }
  const sorted = [...samplesUs].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return {
    count: sorted.length,
    minUs: sorted[0]!,
    p50Us: at(0.5),
    p95Us: at(0.95),
    p99Us: at(0.99),
    maxUs: sorted[sorted.length - 1]!,
    meanUs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}