#!/usr/bin/env bun
/** Entry point. `bun bin/forge.ts <subcommand>` or the `forge` shim. */
import { main } from "../src/cli";

process.exitCode = await main(process.argv.slice(2));