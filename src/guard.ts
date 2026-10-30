/**
 * guard.ts — the command guard: bun decides, bash obeys.
 *
 * Usage: two-sec guard <command line>
 *   exit 0 → allowed (prints nothing)
 *   exit 1 → CANCELLED: urgent notice on STDOUT (agent-visible), error on stderr
 *
 * The bash DEBUG trap (extdebug) treats a non-zero trap return as "skip the
 * next command", so a guard exit 1 literally cancels the violating command.
 */

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { isSlow } from "./policy.ts";
import { effectiveBans, logVerdict } from "./project-policy.ts";

const urgent = (msg: string) => {
  process.stdout.write(
    `════ [kairos GUARD — URGENT, CANCELLED] ════\n` +
      `  ${msg.reason}\n` +
      `  MUST DO: ${msg.fix}\n` +
      `═══════════════════════════════════════\n`,
  );
};

/**
 * Redirect targets whose parent directory does not exist. Scans `>` `>>`
 * `2>` `&>`-style redirects (not `&1`/`&2` fd dups, not heredocs `<<`).
 * Returns the first missing target, or null. A `mkdir -p` for the same
 * parent earlier in the chain satisfies it.
 */
export function redirectTargetMissing(commandLine: string): string | null {
  const hasMkdir = /(^|[\s;&])mkdir\s+(-[a-zA-Z]*p[a-zA-Z]*\s+)/.test(
    commandLine,
  );
  const re = /(?:^|[\s;])(?:\d?&?>+|\d?>+|&>)\s?([^\s;&|<>]+)/g;
  for (const m of commandLine.matchAll(re)) {
    const target = m[1].replace(/^"|"$/g, "");
    if (!target || target.startsWith("&") || target.startsWith("/dev/"))
      continue;
    if (target.startsWith("<")) continue;
    const parent = dirname(target);
    if (parent === "." || parent === "/" || existsSync(parent)) continue;
    if (hasMkdir && commandLine.includes(parent)) continue;
    return target;
  }
  return null;
}
/** Trees so large an inline recursive walk is a latency breach — must go through run-fast. */
const HUGE_TREES = ["/home/toxic/estate", "/home/toxic/pens"];
const TREE_WALKERS = /\b(diff|du|find|grep|rg|fd|ls|fclones)\b/;

export function hugeTreeScan(commandLine: string): string | null {
  if (!TREE_WALKERS.test(commandLine)) return null;
  for (const t of HUGE_TREES) {
    if (commandLine.includes(t)) {
      // bounded walks are fine: find with -maxdepth, ls of the root itself
      if (
        /\bfind\b/.test(commandLine) &&
        /-maxdepth\s+[123]\b/.test(commandLine)
      )
        return null;
      return t;
    }
  }
  return null;
}

/** Host-agnostic verdict — consumed by every adapter (kappa/kilo plugin,
 * tau/omp extension, claude-code-style hook via `kairos hook`, plain CLI). */
export interface KairosVerdict {
  action: "allow" | "deny" | "replace";
  reason?: string;
  fix?: string;
  /** command to run instead (action === "replace") — routed through run-fast */
  replacement?: string;
}

/** One decision function for ALL hosts. Pure: no I/O, no cwd. */
export function verdict(commandLine: string): KairosVerdict {
  if (!commandLine || /^_2s|two-sec|print_doctrine_hint/.test(commandLine))
    return { action: "allow" };
  const missing = redirectTargetMissing(commandLine);
  if (missing)
    return {
      action: "deny",
      reason: `redirect target parent does not exist: ${missing}`,
      fix: "mkdir -p first (or persist to the designated audit dir) — never invent output paths",
    };
  const tree = hugeTreeScan(commandLine);
  if (tree)
    return {
      action: "replace",
      reason: `unbounded recursive walk over ${tree} (huge tree)`,
      fix: "routed through run-fast — detach + full-output persist",
      replacement: `run-fast ${JSON.stringify(commandLine)}`,
    };
  const [bin, sub] = commandLine.trim().split(/\s+/);
  if (bin && isSlow(bin, sub ?? ""))
    return {
      action: "replace",
      reason: `slow route: ${bin} ${sub ?? ""} → deadline runner`,
      fix: "routed through run-fast — deadline-capped, full output",
      replacement: `run-fast ${JSON.stringify(commandLine)}`,
    };
  return { action: "allow" };
}

export function guard(commandLine: string): 0 | 1 {
  // Never guard our own internals (recursion) or bash builtins/benign noise.
  if (!commandLine || /^_2s|two-sec|print_doctrine_hint/.test(commandLine))
    return 0;
  const v = verdict(commandLine);
  if (v.action === "deny") {
    urgent({ reason: v.reason!, fix: v.fix! });
    logVerdict(process.cwd(), {
      kind: "cancel",
      reason: v.reason,
      command: commandLine.slice(0, 120),
    });
    process.stderr.write(`[two-sec guard] CANCELLED: ${v.reason}\n`);
    return 1;
  }
  if (v.action === "replace" && hugeTreeScan(commandLine)) {
    urgent({ reason: v.reason!, fix: v.fix! });
    logVerdict(process.cwd(), {
      kind: "rewrite",
      reason: v.reason,
      command: commandLine.slice(0, 120),
    });
    process.stderr.write(`[two-sec guard] REWRITE: ${v.fix}\n`);
    return 0;
  }
  if (v.action === "replace") {
    process.stderr.write(`[two-sec guard] slow route → deadline runner\n`);
  }
  return 0;
}

if (import.meta.main) {
  const line = process.argv.slice(2).join(" ");
  process.exit(guard(line));
}
