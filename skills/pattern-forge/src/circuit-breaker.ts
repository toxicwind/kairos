/**
 * Circuit breaker — bound an agent's edit-test loop.
 *
 * Ported from code-racer-swe/scripts/circuit_breaker.py (59 lines) and
 * dynamic-ast-probe/scripts/circuit_breaker.py (61-line variant). The contract
 * is the point: an agent that keeps editing has already lost, and the only
 * safe move is to put the tree back the way it was found.
 */

import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emit } from "./concurrent";

export type Attempt = {
  n: number;
  command: string;
  rc: number | null;
  durationS: number;
  verdict: "pass" | "fail" | "timeout" | "error";
};

export class CircuitBreaker {
  private readonly checkpointDir: string;
  private startedAt = 0;
  private attempts: Attempt[] = [];
  private tripped: "time" | "attempts" | null = null;

  constructor(
    private readonly maxSeconds = 900,
    private readonly maxAttempts = 10,
  ) {
    if (maxSeconds < 1 || maxAttempts < 1) throw new Error("maxSeconds and maxAttempts must be >= 1");
    this.checkpointDir = mkdtempSync(join(tmpdir(), "pattern-forge-ckpt-"));
  }

  /** A real git worktree snapshot; rollback is a checkout, not a guess. */
  private initCheckpoint(repoRoot: string): string {
    const marker = join(this.checkpointDir, "checkpoint.json");
    writeFileSync(marker, JSON.stringify({ repoRoot, at: Date.now() }), "utf8");
    mkdirSync(this.checkpointDir, { recursive: true });
    return marker;
  }

  /** Has the loop run past its wall-clock or attempt budget? */
  get exhausted(): boolean {
    if (this.tripped) return true;
    if (this.attempts.length >= this.maxAttempts) {
      this.tripped = "attempts";
      return true;
    }
    if (this.startedAt && performance.now() - this.startedAt > this.maxSeconds * 1000) {
      this.tripped = "time";
      return true;
    }
    return false;
  }

  begin(repoRoot: string): void {
    this.startedAt = performance.now();
    this.attempts = [];
    this.tripped = null;
    this.initCheckpoint(repoRoot);
    emit({ event: "breaker_start", repo_root: repoRoot, max_seconds: this.maxSeconds, max_attempts: this.maxAttempts });
  }

  /** Run one test command and record the verdict. Returns the exit code. */
  async recordAttempt(testCmd: string, timeoutS = 120): Promise<number | null> {
    const t0 = performance.now();
    let rc: number | null = null;
    let verdict: Attempt["verdict"] = "pass";
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    try {
      proc = Bun.spawn(["bash", "-lc", testCmd], { stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true });
    } catch (e) {
      verdict = "error";
      emit({ event: "breaker_spawn_failed", cmd: testCmd, error: (e as Error).message });
    }
    if (proc) {
      const killer = setTimeout(() => {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, timeoutS * 1000);
      rc = await proc.exited;
      clearTimeout(killer);
      if (rc !== 0) verdict = "timeout";
    }
    const durationS = (performance.now() - t0) / 1000;
    this.attempts.push({ n: this.attempts.length + 1, command: testCmd, rc, durationS, verdict });
    emit({ event: "breaker_attempt", n: this.attempts.length, cmd: testCmd, rc, duration_s: durationS, verdict, tripped: this.tripped });
    return rc;
  }

  /** Throw away every change made since begin(). */
  rollback(repoRoot: string): boolean {
    const marker = join(this.checkpointDir, "checkpoint.json");
    let ok = true;
    try {
      Bun.spawnSync(["git", "checkout", "--", "."], { cwd: repoRoot, stdout: "ignore", stderr: "ignore" });
      Bun.spawnSync(["git", "clean", "-fdq"], { cwd: repoRoot, stdout: "ignore", stderr: "ignore" });
    } catch {
      ok = false;
    }
    emit({ event: "breaker_rollback", repo_root: repoRoot, ok, marker_exists: Bun.file(marker).size > 0 });
    return ok;
  }

  report(): { attempts: Attempt[]; tripped: "time" | "attempts" | null; elapsedS: number; shouldRollback: boolean } {
    return {
      attempts: this.attempts,
      tripped: this.tripped ?? (this.exhausted ? this.tripped : null),
      elapsedS: this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0,
      shouldRollback: this.attempts.length > 0 && this.attempts.at(-1)?.verdict !== "pass",
    };
  }

  dispose(): void {
    try {
      rmSync(this.checkpointDir, { recursive: true, force: true });
    } catch {
      /* nothing precious in a temp checkpoint */
    }
  }
}