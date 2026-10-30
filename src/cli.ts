/**
 * cli.ts — kairos / run-fast multiplexer.
 *
 * Subcommands (when called as run-fast or kairos):
 *   run <cmd…>          spawn session, stream output
 *   detach <cmd…>       spawn in background, return id immediately (non-blocking)
 *   bg <cmd…>           alias for detach
 *   attach <id>         attach to session
 *   logs [id]           session output
 *   list                list sessions
 *   purge [pattern]     remove sessions
 *   cancel <id>         kill session
 *
 * Legacy two-sec-only commands (kept for compat):
 *   guard <line>        allow(0)/cancel(1)
 *   route <bin sub>     slow/fast detection
 *   init                emit bash shim
 */
import {
  runSession,
  attachSession,
  logsSession,
  listSessions,
  purgeSessions,
  cancelSession,
  runDetached,
} from "./runner.ts";
import { guard, verdict } from "./guard.ts";
import { isSlow } from "./policy.ts";
import { emitBashShim } from "./init.ts";

let cmd = process.argv[2];
let rest = process.argv.slice(3);

// First-class deadline flag: `kairos run --deadline=4 <cmd…>` (also
// `--deadline 4`) sets a STRICT absolute deadline for this run. It overrides
// command bumps AND `.two-sec/policy.json` deadlineS (the runner threads it as
// an explicit deadline). The flag is stripped from the child argv (never leaks
// into the command).
const KAIROS_VERBS = new Set([
  "run",
  "detach",
  "bg",
  "attach",
  "logs",
  "list",
  "purge",
  "cancel",
  "guard",
  "route",
  "init",
]);

/**
 * Normalize a single verb dispatch. The estate `bin/kairos` symlink routes
 * through the `run-fast` bash shim, which ALWAYS prepends `run` as the first
 * runner arg. That means `kairos route bun test` arrives here as cmd="run",
 * rest=["route","bun","test"] — and would otherwise spawn the system
 * `/usr/bin/route`. This explicit argv[0] guard re-dispatches to the real
 * kairos verb so a kairos subcommand NEVER falls through to a same-named
 * system binary.
 */
function resolveDispatch(cmd0: string, argv0: string[]): [string, string[]] {
  if (cmd0 === "run" && argv0.length > 0 && KAIROS_VERBS.has(argv0[0])) {
    return [argv0[0], argv0.slice(1)];
  }
  return [cmd0, argv0];
}

if (cmd === "run" || cmd === "detach" || cmd === "bg") {
  let deadline: string | undefined;
  const named: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--deadline" && i + 1 < rest.length) deadline = rest[++i];
    else if (a.startsWith("--deadline="))
      deadline = a.slice("--deadline=".length);
    else if (a === "--") {
      named.push(...rest.slice(i));
      break;
    } else named.push(a);
  }
  // Runner-level meta flags (--cwd/--env/--id) are stripped inside the runner's
  // parseArgs; keep them in `named` so the deadline is the ONLY flag consumed here.
  if (deadline !== undefined) process.env.RF_DEADLINE = deadline;
  rest = named;
}

[cmd, rest] = resolveDispatch(cmd, rest);

switch (cmd) {
  case "run":
  case undefined:
    await runSession(rest.length ? rest : ["true"], {
      quiet: process.env.RF_QUIET === "1",
    });
    break;
  case "attach":
    await attachSession(rest[0] ?? "");
    break;
  case "logs":
    await logsSession(rest[0]);
    break;
  case "list":
    await listSessions();
    break;
  case "purge":
    await purgeSessions(rest[0]);
    break;
  case "cancel":
    await cancelSession(rest[0] ?? "");
    break;
  case "detach":
  case "bg":
    await runDetached(rest);
    break;
  case "guard":
    process.exit(guard(rest.join(" ")));
    break;
  case "hook":
    // Universal adapter protocol: read {command} JSON on stdin (any host's
    // hook — claude-code PreToolUse-style, codex policy, generic wrapper),
    // answer with a kairos verdict on stdout. Hosts translate:
    //   deny    → block the tool call (exit code / block flag)
    //   replace → rewrite the command input to `replacement`
    //   allow   → run as-is
    {
      let raw = "";
      for await (const chunk of Bun.stdin.stream()) raw += chunk;
      let command = rest.join(" ");
      if (!command && raw.trim()) {
        try {
          const parsed = JSON.parse(raw);
          command =
            parsed?.command ??
            parsed?.tool_input?.command ??
            parsed?.input?.command ??
            "";
        } catch {
          command = raw.trim();
        }
      }
      const v = verdict(command);
      process.stdout.write(`${JSON.stringify(v)}\n`);
      process.exit(v.action === "deny" ? 1 : 0);
    }
    break;
  case "route":
    process.stdout.write(
      isSlow(rest[0] ?? "", rest[1] ?? "") ? "slow\n" : "fast\n",
    );
    break;
  case "init":
    process.stdout.write(emitBashShim());
    break;
  default:
    process.stderr.write(
      `run-fast: unknown command '${cmd}' (run|detach|bg|attach|logs|list|purge|cancel|guard|route|init)\n`,
    );
    process.exit(2);
}
