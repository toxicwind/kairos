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

import { firstBan, isSlow } from "./policy.ts";

const urgent = (msg: string) => {
  process.stdout.write(
    `════ [two-sec GUARD — URGENT, CANCELLED] ════\n` +
    `  ${msg.reason}\n` +
    `  MUST DO: ${msg.fix}\n` +
    `═══════════════════════════════════════\n`,
  );
};

export function guard(commandLine: string): 0 | 1 {
  // Never guard our own internals (recursion) or bash builtins/benign noise.
  if (!commandLine || /^_2s|two-sec|print_doctrine_hint/.test(commandLine)) return 0;

  const ban = firstBan(commandLine);
  if (ban) {
    urgent(ban);
    if (ban.action === "cancel") {
      process.stderr.write(`[two-sec guard] CANCELLED: ${ban.reason}\n`);
      return 1;
    }
    // rewrite class: notify + instruct, let it run
    process.stderr.write(`[two-sec guard] REWRITE: ${ban.fix}\n`);
    return 0;
  }
  // Slow subcommand? Don't cancel — advise the routing (the wrappers do it).
  const [bin, sub] = commandLine.trim().split(/\s+/);
  if (bin && isSlow(bin, sub ?? "")) {
    process.stderr.write(`[two-sec guard] slow route: ${bin} ${sub} → deadline runner (2.0s cap)\n`);
  }
  return 0;
}

if (import.meta.main) {
  const line = process.argv.slice(2).join(" ");
  process.exit(guard(line));
}
