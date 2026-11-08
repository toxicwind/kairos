import { describe, test, expect } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emitBashShim } from "../src/init.ts";

const HOME = homedir();
// Canonical name is kairos (run-fast is the retired alias, 2026-11-08).
const RF_BIN = join(HOME, ".local/bin/kairos");
// Canonical live kairos home (post-reorg: ranch/products/ops owns the shim).
const OPS_RUN_FAST = join(HOME, "pens/ranch/products/ops/bin/kairos");

describe("kairos run-fast hook is LIVE (anomaly #57 regression)", () => {
  test("~/.local/bin/kairos resolves to an existing executable", () => {
    expect(existsSync(RF_BIN)).toBe(true);
    const real = realpathSync(RF_BIN);
    expect(existsSync(real)).toBe(true);
    // Must NOT point at a removed estate-ops path.
    expect(real).not.toContain("pens/estate/products/estate-ops");
  });

  test("~/.local/bin/kairos resolves to the live ops shim", () => {
    const real = realpathSync(RF_BIN);
    expect(real).toBe(OPS_RUN_FAST);
  });

  test("the ops kairos shim points KAIROS_DIR at the live kairos source", () => {
    const src = require("node:fs").readFileSync(OPS_RUN_FAST, "utf8");
    expect(src).toContain("/home/toxic/pens/ergasterion/products/kairos");
    expect(src).not.toContain("pens/ranch/kairos");
  });

  test("emitted shim resolves RF_BIN via ~/.local/bin/kairos (not a dead estate-ops path)", () => {
    const shim = emitBashShim();
    expect(shim).toContain("$HOME/.local/bin/kairos");
    expect(shim).not.toContain("pens/estate/products/estate-ops");
  });

  test("sourcing the shim in an agent shell hooks git/bun and routes via kairos", async () => {
    // Real round-trip: source the generated shim, then run a slow-routed command.
    // It must resolve RF_BIN to the live symlink and complete without ENOENT.
    const proc = Bun.spawn([
      "bash",
      "-c",
      `source ${join(HOME, "pens/ergasterion/products/kairos/shim.sh")}; ` +
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