/**
 * runner.ts — the deadline runner (run-fast successor, in Bun).
 *
 * Output contract (stable, pipe-safe):
 *   - child stdout → stdout verbatim; child stderr → stderr verbatim
 *   - LAST stderr line always matches ^[two-sec <verdict>]
 *   - breach: URGENT must-do block on STDOUT (agent-visible) + exit 9
 */
import { spawn } from "bun";

export interface RunResult {
  verdict: "ok" | "breach" | "fail" | "spawn-fail";
  elapsedMs: number;
  exitCode: number;
}

const urgentBreach = (cmd: string[], elapsedS: number, deadlineS: number) => {
  process.stdout.write(
    `\n════ [two-sec BREACH — URGENT, MUST DO] ════\n` +
    `  '${cmd.slice(0, 6).join(" ")}' took ${elapsedS.toFixed(3)}s > ${deadlineS}s deadline. FAILED + CANCELLED.\n` +
    `  MUST DO NOW (ast-find faster, in order):\n` +
    `  1. ffs impact <the-slow-symbol>   # blast radius — is this the right fix point?\n` +
    `  2. ffs flow <the-slow-symbol>     # def+body+callees — find the O(n^2)/spawn storm\n` +
    `  3. forge borrow '<what this command does>'   # external faster prior art\n` +
    `  4. or background it (harness background_process) — never wait longer.\n` +
    `  Do NOT retry the same command. A breach without a raced fix is a defect.\n` +
    `═══════════════════════════════════════\n`,
  );
};

export async function run(args: string[], opts: { deadlineS?: number; quiet?: boolean; cwd?: string } = {}): Promise<RunResult> {
  const deadlineS = opts.deadlineS ?? Number(process.env.RF_DEADLINE ?? 2.0);
  const quiet = opts.quiet ?? process.env.RF_QUIET === "1";
  const t0 = performance.now();

  const proc = spawn(args, { stdout: "inherit", stderr: "inherit", stdin: "inherit", cwd: opts.cwd });
  const timer = setTimeout(() => { try { proc.kill(9); } catch {} }, deadlineS * 1000);
  const code = await proc.exited;
  clearTimeout(timer);

  const elapsedMs = performance.now() - t0;
  let verdict: RunResult["verdict"];
  if (elapsedMs > deadlineS * 1000) {
    verdict = "breach";
    urgentBreach(args, elapsedMs / 1000, deadlineS);
  } else if (code !== 0) {
    verdict = "fail";
  } else {
    verdict = "ok";
  }

  if (verdict !== "ok" || !quiet) {
    process.stderr.write(`[two-sec ${verdict} ${((elapsedMs / 1000) || 0).toFixed(2)}s exit=${code}]\n`);
  }
  return { verdict, elapsedMs, exitCode: code };
}
