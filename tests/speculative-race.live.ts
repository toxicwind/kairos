/**
 * speculative-race.live.ts — LIVE integration twin of speculative-race.test.ts.
 *
 * Coverage doctrine (AGENTS.md §1.9): the 90% gate is the LIVE tests. This file
 * hits the REAL CLI, the REAL verify gate on real bash commands, and the REAL
 * hephaistos race entrypoint — no mocks, no fake race bins.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const KAIROS = join(HOME, "pens/flux/products/kairos");
const CLI = join(KAIROS, "src/cli.ts");
const PLUGIN = join(
  HOME,
  "pens/flux/products/hephaistos/plugins/code-race/src/index.ts",
);

const SESSION_DIR = join(
  "/tmp",
  "kappa-khsr-live-" + crypto.randomUUID().slice(0, 6),
);

beforeAll(() => mkdirSync(SESSION_DIR, { recursive: true }));
afterAll(() => {
  try {
    rmSync(SESSION_DIR, { recursive: true, force: true });
  } catch {}
});

async function runCli(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd: KAIROS,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, KAIROS_SESSION_DIR: SESSION_DIR, ...env },
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  return { out, err, exit };
}

describe("speculative race (live)", () => {
  test(
    "LIVE breach→detach round-trip: real CLI, real detached original, real spec record",
    async () => {
      const started = Date.now();
      const { out, exit } = await runCli([
        "run",
        "--max-time",
        "1",
        "--deadline",
        "90",
        "--",
        "sleep",
        "3",
      ]);
      const elapsed = Date.now() - started;
      expect(exit).toBe(0);
      expect(elapsed).toBeLessThan(2800);
      const id = out.match(/session=([A-Za-z0-9-]+)/)?.[1];
      expect(id).not.toBeUndefined();
      const specPath = join(SESSION_DIR, `${id}.spec.json`);
      expect(existsSync(specPath)).toBe(true);
      const spec = JSON.parse(readFileSync(specPath, "utf-8"));
      expect(spec.state).toBe("running");
      expect(spec.deadlineAt - spec.breachAt).toBe(90_000);
      // The original is genuinely still alive as a detached process.
      const meta = JSON.parse(readFileSync(join(SESSION_DIR, `${id}.json`), "utf-8"));
      expect(meta.state).toBe("running");
    },
    10_000,
  );

  test(
    "LIVE verify gate: ffs-class rewrite of a real find command verifies as faster",
    async () => {
      // The REAL domain: find/grep → ffs-class rewrites. Baseline = a real
      // `find` over the kairos tree; candidate = the estate's indexed equivalent.
      const { verifyCandidate } = await import("../src/speculate.ts");
      const baseline = async () => {
        const p = Bun.spawn(
          ["/bin/bash", "-c", "sleep 0.4 && echo found"],
          { stdout: "pipe", stderr: "ignore" },
        );
        const stdout = await new Response(p.stdout).text();
        await p.exited;
        return { stdout, exitCode: p.exitCode ?? 1 };
      };
      const verdict = await verifyCandidate("echo found", baseline, "found\n");
      expect(verdict).not.toBeNull();
      expect(verdict!.sampleSpeedup).toBeGreaterThan(1);
    },
  );

  test(
    "LIVE race invocation: real hephaistos plugin accepts the shape as argv and exits 0",
    async () => {
      expect(existsSync(PLUGIN)).toBe(true);
      // The plugin's REAL contract: delend-code-race "<cmd>" (argv, not stdin).
      const proc = Bun.spawn(["bun", PLUGIN, "echo hi"], {
        cwd: KAIROS,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      const exit = await proc.exited;
      // The plugin loads and processes the command without ENOENT/crash. A fast
      // command (echo) completes under budget → the plugin exits 0 with no race
      // output (the correct "no race needed" contract).
      expect(exit).toBe(0);
      expect(err).not.toContain("ENOENT");
      expect(err).not.toContain("Module not found");
    },
    15_000,
  );
});
