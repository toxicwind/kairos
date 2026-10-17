/**
 * cli.ts — two-sec / run-fast multiplexer.
 *
 * Subcommands (when called as run-fast or two-sec):
 *   run <cmd…>          spawn session, stream output
 *   attach <id>         attach to session
 *   logs [id]           session output
 *   list                list sessions
 *   purge [pattern]     remove sessions
 *   cancel <id>         kill session
 *
 * Legacy two-sec-only commands:
 *   guard <line>        allow(0)/cancel(1)
 *   route <bin sub>     slow/fast detection
 *   init                emit bash shim
 */
import { runSession, attachSession, logsSession, listSessions, purgeSessions, cancelSession } from "./runner.ts";
import { guard } from "./guard.ts";
import { isSlow } from "./policy.ts";
import { emitBashShim } from "./init.ts";

const cmd = process.argv[2];
const rest = process.argv.slice(3);

switch (cmd) {
  case "run":
  case undefined:
    await runSession(rest.length ? rest : ["true"]);
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
  case "guard":
    process.exit(guard(rest.join(" ")));
    break;
  case "route":
    process.stdout.write(isSlow(rest[0] ?? "", rest[1] ?? "") ? "slow\n" : "fast\n");
    break;
  case "init":
    process.stdout.write(emitBashShim());
    break;
  default:
    process.stderr.write(`run-fast: unknown command '${cmd}' (run|attach|logs|list|purge|cancel|guard|route|init)\n`);
    process.exit(2);
}
