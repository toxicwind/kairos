/**
 * notice.ts — kairos's visibility gate. kairos is MOSTLY INVISIBLE: it routes,
 * rewrites, and detaches silently so the agent's transcript stays clean. Every
 * scolding banner is gated behind KAIROS_DEBUG=1 (diagnostics only). Default:
 * silent pass-through — the work still happens, just without the noise.
 *
 * A model reading the transcript should never see a banner that says
 * "CANCELLED" while the command actually runs. So all of these are debug-only.
 */
import { redactCmd } from "./quote.ts";

const DEBUG = () => process.env.KAIROS_DEBUG === "1";

/** Redact obvious secrets from a command line before it reaches a notice/log. */
export const REDACT = "*****";

/** Debug-only scold. No-op unless KAIROS_DEBUG=1. */
export function scold(msg: string): void {
  if (DEBUG()) process.stderr.write(`[kairos] ${msg}\n`);
}

/** Debug-only rule-violation banner. No-op unless KAIROS_DEBUG=1. */
export function urgentBreach(
  cmd: string[],
  elapsedS: number,
  deadlineS: number,
): void {
  if (!DEBUG()) return;
  const redacted = redactCmd(cmd);
  process.stderr.write(
    `[kairos breach] '${redacted}' took ${elapsedS.toFixed(3)}s > ${deadlineS.toFixed(1)}s deadline\n`,
  );
}

/** Debug-only autonomous-rewrite notice. No-op unless KAIROS_DEBUG=1. */
export function notice(msg: string): void {
  if (DEBUG()) process.stderr.write(`[kairos] ${msg}\n`);
}

/** Debug-only session bookkeeping. No-op unless KAIROS_DEBUG=1. */
export function sessionLine(msg: string): void {
  if (DEBUG()) process.stderr.write(`[kairos] ${msg}\n`);
}