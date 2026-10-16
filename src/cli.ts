/**
 * cli.ts — two-sec entrypoints.
 *   two-sec run <cmd…>      deadline runner (2.0s cap, urgent breach on stdout)
 *   two-sec guard <line>    allow(0)/cancel(1) + urgent stdout notice
 *   two-sec route <bin sub> prints "slow" when the pair must be capped
 *   two-sec init            emit the static bash glue (shim.sh)
 */
import { run } from "./runner.ts";
import { guard } from "./guard.ts";
import { isSlow } from "./policy.ts";
import { emitBashShim } from "./init.ts";

const cmd = process.argv[2];
const rest = process.argv.slice(3);

switch (cmd) {
  case "run":
  case undefined:
    await run(rest.length ? rest : ["true"]);
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
    process.stderr.write(`two-sec: unknown command '${cmd}' (run|guard|route|init)\n`);
    process.exit(2);
}
