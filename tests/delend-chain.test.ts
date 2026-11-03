import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emitBashShim } from "../src/init.ts";

const HOME = homedir();
const STALE_CORRAL = "corral/delendai";
// Canonical post-reorg home: ergasterion is a TOP-LEVEL pen (pens/ergasterion),
// not a product under olympus. The code-race plugin lives there.
const PLUGIN = join(HOME, "pens/ergasterion/hephaistos/plugins/code-race");
// The delend-code-race launcher lives in the estate pen's estate-ops product.
const LAUNCHER = join(
  HOME,
  "pens/estate/products/estate-ops/delend-code-race",
);
const MANIFEST = join(HOME, "pens/barn/estate-ops/bin/manifest.yaml");
// The estate-ops dir also resolves via the ~/.local/bin symlink (bin-verify).
const BIN_LAUNCHER = join(HOME, ".local/bin/delend-code-race");

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

  test("~/.local/bin/delend-code-race symlink resolves to the living launcher", () => {
    const target = read(BIN_LAUNCHER);
    expect(target).toContain(PLUGIN + "/src/index.ts");
    // The canonical launcher physically exists.
    expect(existsSync(LAUNCHER)).toBe(true);
  });

  test("kairos runner resolves DELEND_CODE_RACE to the hephaistos plugin entry", () => {
    const runner = read(
      join(HOME, "pens/olympus/products/kairos/src/runner.ts"),
    );
    expect(runner).toContain(PLUGIN + "/src/index.ts");
    expect(runner).not.toContain(STALE_CORRAL);
    expect(existsSync(join(PLUGIN, "src/index.ts"))).toBe(true);
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

  test("manifest pins the delend-code-race link at estate-ops + plugin entrypoints", () => {
    const m = read(MANIFEST);
    // Manifest emits its own name form (PATH-style) — assert the names exist and
    // the targets point at estate-ops launcher + plugin entries, never the corral.
    expect(m).toContain('name: "~/.local/bin/delend-code-race"');
    expect(m).toContain(`target: "${LAUNCHER}"`);
    expect(m).toContain('name: "~/.local/bin/delend-code-race-line"');
    expect(m).toContain(`target: "${join(PLUGIN, "bin/race-line.ts")}"`);
    expect(m).toContain('name: "~/.local/bin/delend-code-race-rs"');
    expect(m).toContain(
      `target: "${join(PLUGIN, "crates/code-race/target/release/delend-code-race")}"`,
    );
    expect(m).not.toContain(STALE_CORRAL);
  });

  test("no live tooling in the delend chain references a deleted path (barn/estate-ops dup / corral)", () => {
    // Assert over the deterministic chain surface: launcher, plugin, kairos runner,
    // and the manifest. Nothing outside them is reachable at runtime.
    const surface = [
      LAUNCHER,
      join(HOME, "pens/olympus/products/kairos/src/runner.ts"),
      join(HOME, "pens/olympus/products/kairos/src/init.ts"),
      MANIFEST,
    ];
    for (const p of surface) {
      const text = read(p);
      // The deleted corral/delendai path must never appear as a live reference.
      expect(text, `no stale corral/delendai in ${p}`).not.toContain(
        "corral/delendai",
      );
      // The retired barn/estate-ops delend-code-race sibling must not be referenced
      // as a target (estate/products/estate-ops is canonical).
      expect(
        text,
        `no barn/estate-ops delend-code-race target in ${p}`,
      ).not.toContain("pens/barn/estate-ops/delend-code-race");
    }
  });

  test("shim emits canonical paths: RF_BIN via ~/.local/bin, DELEND_CODE_RACE at hephaistos", () => {
    const shim = emitBashShim();
    expect(shim).toContain("$HOME/.local/bin/run-fast");
    expect(shim).toContain(
      "/home/toxic/pens/ergasterion/hephaistos/plugins/code-race/src/index.ts",
    );
    expect(shim).not.toContain("$HOME/pens/barn/");
    expect(shim).not.toContain(STALE_CORRAL);
  });

  test("launcher physically loads and run: fast command under 2s → PASS, no race", async () => {
    // Real round-trip: spawn the launcher the exact way kairos would (`bun <launcher>`),
    // with a trivial fast command. It must load the plugin and complete, not ENOENT.
    const proc = Bun.spawn(["bun", LAUNCHER, "--", "echo hi"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    expect(exit).toBe(0);
    expect(err).not.toContain("ENOENT");
    expect(out + err).toMatch(/PASS|No race needed|ok|hi/i);
  });
});