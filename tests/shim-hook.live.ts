import { describe, test, expect } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emitBashShim } from "../src/init.ts";

const HOME = homedir();
const RF_BIN = join(HOME, ".local/bin/run-fast");
// Canonical live run-fast home (post-reorg: ranch/products/ops owns the shim).
const OPS_RUN_FAST = join(HOME, "pens/ranch/products/ops/run-fast");

describe("kairos run-fast hook is LIVE (anomaly #57 regression)", () => {
  test("~/.local/bin/run-fast resolves to an existing executable", () => {
    expect(existsSync(RF_BIN)).toBe(true);
    const real = realpathSync(RF_BIN);
    expect(existsSync(real)).toBe(true);
    // Must NOT point at a removed estate-ops path.
    expect(real).not.toContain("pens/estate/products/estate-ops");
  });

  test("~/.local/bin/run-fast resolves to the live ops shim", () => {
    const real = realpathSync(RF_BIN);
    expect(real).toBe(OPS_RUN_FAST);
  });

  test("the ops run-fast shim points KAIROS_DIR at the live kairos source", () => {
    const src = require("node:fs").readFileSync(OPS_RUN_FAST, "utf8");
    expect(src).toContain("/home/toxic/pens/olympus/products/kairos");
    expect(src).not.toContain("pens/ranch/kairos");
  });

  test("emitted shim resolves RF_BIN via ~/.local/bin (not a dead estate-ops path)", () => {
    const shim = emitBashShim();
    expect(shim).toContain("$HOME/.local/bin/run-fast");
    expect(shim).not.toContain("pens/estate/products/estate-ops");
  });

  test("sourcing the shim in an agent shell hooks git/bun and routes via run-fast", async () => {
    // Real round-trip: source the generated shim, then run a slow-routed command.
    // It must resolve RF_BIN to the live symlink and complete without ENOENT.
    const proc = Bun.spawn([
      "bash",
      "-c",
      `source ${join(HOME, "pens/olympus/products/kairos/shim.sh")}; ` +
        `type git | grep -q function && echo HOOKED; ` +
        `[ -x "$RF_BIN" ] && echo RF_LIVE || echo RF_DEAD`,
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    expect(exit).toBe(0);
    expect(out).toContain("HOOKED");
    expect(out).toContain("RF_LIVE");
    expect(err).not.toContain("ENOENT");
  });
});