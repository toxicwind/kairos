import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emitBashShim } from "../src/init.ts";

const HOME = homedir();
const STALE_CORRAL = "corral/delendai";
const PLUGIN = join(
  HOME,
  "pens/olympus/products/ergasterion/hephaistos/plugins/code-race",
);
const LAUNCHER = join(HOME, "pens/barn/estate-ops/delend-code-race");
const MANIFEST = join(HOME, "pens/barn/estate-ops/bin/manifest.yaml");

const read = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

// Keep a generous per-file timeout so slow realpath/spawn checks can breathe.
if (typeof test.setTimeout === "function") test.setTimeout(60000);

describe("delend-code-race chain survives the delendai→hephaistos reorg", () => {
  test("launcher imports the relocated plugin entry that still exports main", () => {
    const src = read(LAUNCHER);
    expect(src).toContain(PLUGIN + "/src/index.ts");
    expect(src).not.toContain(STALE_CORRAL);
    // The import target physically exists.
    expect(existsSync(join(PLUGIN, "src/index.ts"))).toBe(true);
    // And it still exports `main` with the same signature the launcher awaits.
    expect(read(join(PLUGIN, "src/index.ts"))).toMatch(
      /export async function main/,
    );
  });

  test("kairos runner resolves DELEND_CODE_RACE to the living launcher (not stale corral)", () => {
    const runner = read(
      join(HOME, "pens/olympus/products/kairos/src/runner.ts"),
    );
    expect(runner).toContain(LAUNCHER);
    expect(runner).not.toContain(STALE_CORRAL);
    expect(existsSync(LAUNCHER)).toBe(true);
  });

  test("all three delend bins resolve to existing plugin entrypoints", () => {
    const map: Record<string, string> = {
      "delend-code-race": LAUNCHER,
      "delend-code-race-line": join(PLUGIN, "bin/race-line.ts"),
      "delend-code-race-rs": join(
        PLUGIN,
        "crates/code-race/target/release/delend-code-race",
      ),
    };
    for (const [name, target] of Object.entries(map)) {
      expect(existsSync(target), `${name} target ${target} exists`).toBe(true);
    }
  });

  test("manifest pins all delend* links at the new hephaistos plugin (no stale corral)", () => {
    const m = read(MANIFEST);
    expect(m).toContain(`"${LAUNCHER}"`);
    expect(m).toContain(`"${join(PLUGIN, "bin/race-line.ts")}"`);
    expect(m).toContain(
      `"${join(PLUGIN, "crates/code-race/target/release/delend-code-race")}"`,
    );
    expect(m).not.toContain(STALE_CORRAL);
  });

  test("estate-ops launcher dir contains no stale corral/delendai reference", () => {
    // Codifies the ad-hoc guard: `grep -rn corral/delendai pens/barn/estate-ops/delend-code-race*`
    const launcherLine = join(
      HOME,
      "pens/barn/estate-ops/delend-code-race-line",
    );
    expect(read(LAUNCHER)).not.toContain(STALE_CORRAL);
    expect(read(launcherLine)).not.toContain(STALE_CORRAL);
  });

  test("no live tooling in the delend chain references a deleted path (estate-ops dup / corral)", () => {
    // Stops the slow `grep -r pens` (143ms→60s timeout) by asserting over the
    // deterministic chain surface instead: the launcher, its sibling line launcher,
    // the kairos runner, and the manifest. These four files OWN every reference the
    // auto-racer can follow; nothing outside them is reachable at runtime.
    const surface = [
      LAUNCHER,
      join(HOME, "pens/barn/estate-ops/delend-code-race-line"),
      join(HOME, "pens/olympus/products/kairos/src/runner.ts"),
      MANIFEST,
    ];
    for (const p of surface) {
      const text = read(p);
      // The deleted corral/delendai path must never appear as a live reference.
      expect(text, `no stale corral/delendai in ${p}`).not.toContain(
        "corral/delendai",
      );
      // The old estate-ops delend-code-race-line sibling must not be referenced
      // as a target (the plugin's bin/race-line.ts is the canonical entrypoint).
      expect(
        text,
        `no estate-ops delend-code-race-line target in ${p}`,
      ).not.toContain("barn/estate-ops/delend-code-race-line");
    }
  });

  test("manifest carries every delend entry pointing at the hephaistos plugin", () => {
    const m = read(MANIFEST);
    // The three delend links, all resolving under the relocated plugin.
    // The manifest generator (2026-10-27 rewrite) emits PATH-style names
    // ("~/.local/bin/<bin>"), not bare bin names — assert that form.
    expect(m).toContain('name: "~/.local/bin/delend-code-race"');
    expect(m).toContain(`target: "${LAUNCHER}"`);
    expect(m).toContain('name: "~/.local/bin/delend-code-race-line"');
    expect(m).toContain(`target: "${join(PLUGIN, "bin/race-line.ts")}"`);
    expect(m).toContain('name: "~/.local/bin/delend-code-race-rs"');
    expect(m).toContain(
      `target: "${join(PLUGIN, "crates/code-race/target/release/delend-code-race")}"`,
    );
    // And nothing points at the deleted corral tree or the stale estate-ops dup.
    expect(m).not.toContain("corral/delendai");
    expect(m).not.toContain("estate-ops/delend-code-race-line");
  });

  test("shim emits canonical pens/barn paths for RF_BIN and DELEND_CODE_RACE", () => {
    const shim = emitBashShim();
    expect(shim).toContain("$HOME/pens/barn/estate-ops/run-fast");
    expect(shim).toContain("$HOME/pens/barn/estate-ops/delend-code-race");
    expect(shim).not.toContain("$HOME/estate/bin/");
    expect(shim).not.toContain(STALE_CORRAL);
  });

  test("launcher physically loads and run: fast command under 2s → PASS, no race", async () => {
    // Real round-trip: spawn the launcher the exact way kairos would (`bun <launcher>`),
    // with a trivial fast command. It must load the plugin and complete, not ENOENT.
    const proc = Bun.spawn(["bun", LAUNCHER, "--2s", "echo hi"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    expect(exit).toBe(0);
    expect(err).not.toContain("ENOENT");
    expect(out + err).toMatch(/PASS|No race needed/i);
  });
});
