/**
 * The nanosecond racer — benchmarks candidate implementations against each
 * other and prints a leaderboard.
 *
 * Ported from code-racer-swe/scripts/code_racer.py (79 lines) and
 * dynamic-ast-probe/scripts/code_racer.py (byte-identical sha 219af8a9bc).
 * Warmups exist because the first call pays JIT and page-fault costs that have
 * nothing to do with the candidate; reporting a cold number is how these
 * benchmarks lie.
 */

import { nowUs, distribution, type Distribution } from "./measure";

export type Candidate = {
  name: string;
  /** Candidate implementations. Exactly one runs per measurement. */
  impl: () => unknown;
};

export type RacerRow = {
  name: string;
  distribution: Distribution;
  /** nanoseconds per single call — the comparable number. */
  medianNs: number;
};

export type RacerResult = { rows: RacerRow[]; winner: string | null; warmupRuns: number; testRuns: number };

export class CodeRacer {
  constructor(
    private readonly warmupRuns = 5,
    private readonly testRuns = 50,
  ) {
    if (warmupRuns < 0 || testRuns < 1) throw new Error("warmupRuns >= 0 and testRuns >= 1 required");
  }

  /** Benchmark every candidate. A candidate that throws is ranked last, not skipped. */
  race(candidates: readonly Candidate[]): RacerResult {
    if (!candidates.length) throw new Error("race needs at least one candidate");

    const rows: RacerRow[] = [];
    for (const candidate of candidates) {
      for (let i = 0; i < this.warmupRuns; i++) {
        try {
          candidate.impl();
        } catch {
          break; // a candidate that cannot even warm up is not a contender
        }
      }
      const samples: number[] = [];
      let failure: string | null = null;
      for (let i = 0; i < this.testRuns; i++) {
        const t0 = nowUs();
        try {
          candidate.impl();
        } catch (e) {
          failure = (e as Error).message;
          break;
        }
        samples.push(nowUs() - t0);
      }
      const dist = distribution(samples);
      rows.push({ name: candidate.name, distribution: dist, medianNs: dist.p50Us * 1000, ...(failure ? { failure } : {}) } as RacerRow);
    }

    rows.sort((a, b) => rank(a) - rank(b));
    const first = rows[0];
    return { rows, winner: first && first.distribution.count > 0 ? first.name : null, warmupRuns: this.warmupRuns, testRuns: this.testRuns };
  }

  printLeaderboard(result: RacerResult): string {
    const lines = [`=== Code Racer Leaderboard (${result.warmupRuns} warmup / ${result.testRuns} runs) ===`];
    const nameWidth = Math.max(4, ...result.rows.map((r) => r.name.length));
    for (const [i, row] of result.rows.entries()) {
      const d = row.distribution;
      const broken = d.count === 0;
      lines.push(
        `${broken ? " " : String(i + 1).padStart(2)}. ${row.name.padEnd(nameWidth)}  ` +
          (broken
            ? "FAILED"
            : `median ${fmtNs(row.medianNs)}  p95 ${fmtNs(d.p95Us * 1000)}  mean ${fmtNs(d.meanUs * 1000)}`),
      );
    }
    lines.push(result.winner ? `winner: ${result.winner}` : "winner: none (every candidate failed)");
    return lines.join("\n");
  }
}

/** A candidate with no successful samples is infinitely slow, not infinitely fast. */
const rank = (row: RacerRow): number => (row.distribution.count > 0 ? row.medianNs : Number.POSITIVE_INFINITY);

export function fmtNs(ns: number): string {
  if (ns < 1_000) return `${ns.toFixed(1)}ns`;
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(2)}µs`;
  return `${(ns / 1_000_000).toFixed(2)}ms`;
}