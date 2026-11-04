import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// KHSR speculative-race tests. Every feature is RED-first: the test asserts the
// REAL contract (flag consumed, breach detaches, hephaistos invoked, arbitration,
// ledger) and is written BEFORE the implementation exists.

const HOME = homedir();
const KAIROS = join(HOME, "pens/ergasterion/products/kairos");
const CLI = join(KAIROS, "src/cli.ts");

// Isolated session dir per run so tests never touch the live ~/.run-fast store.
const SESSION_DIR = join("/tmp", "kappa-khsr-" + crypto.randomUUID().slice(0, 6));

beforeAll(() => {
  mkdirSync(SESSION_DIR, { recursive: true });
});
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
    env: {
      ...process.env,
      KAIROS_SESSION_DIR: SESSION_DIR,
      ...env,
    },
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  return { out, err, exit };
}

describe("Cycle 1 — --max-time / --deadline flag parsing", () => {
  test("--max-time and --deadline are consumed by the CLI and never leak into child argv", async () => {
    // A fast command (echo) with both flags set: the flags must be stripped from
    // the child argv (echo must NOT receive --max-time/--deadline as args) and
    // the run must complete normally (exit 0).
    const { out, exit } = await runCli([
      "run",
      "--max-time",
      "5",
      "--deadline",
      "90",
      "--",
      "echo",
      "hi",
    ]);
    expect(exit).toBe(0);
    // echo output is present and clean — the flags were consumed, not passed to
    // echo. (The runner live-persists stdout, so echo's "hi" may appear more than
    // once; the contract is that the flags never leak into the child argv.)
    expect(out).toContain("hi");
    expect(out).not.toContain("--max-time");
    expect(out).not.toContain("--deadline");
  });

  test("RF_MAX_TIME and RF_DEADLINE env are set for the runner when flags are present", async () => {
    // The runner must see the parsed values. We assert the contract via a child
    // that prints its env: `kairos run --max-time 7 --deadline 60 -- env | grep RF_`.
    const { out, exit } = await runCli([
      "run",
      "--max-time",
      "7",
      "--deadline",
      "60",
      "--",
      "env",
    ]);
    expect(exit).toBe(0);
    expect(out).toContain("RF_MAX_TIME=7");
    expect(out).toContain("RF_DEADLINE=60");
  });

  test("without --max-time, no RF_MAX_TIME is set (default path unchanged)", async () => {
    const { out, exit } = await runCli(["run", "--", "env"]);
    expect(exit).toBe(0);
    expect(out).not.toContain("RF_MAX_TIME=");
  });
});