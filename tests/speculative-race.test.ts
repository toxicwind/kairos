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

// Session id is emitted as `session=<id>` (detached) or `session=<id> (detached)`.
function extractId(out: string): string | null {
  const m = out.match(/session=([A-Za-z0-9-]+)/);
  return m ? m[1] : null;
}

function meta(id: string) {
  const p = join(SESSION_DIR, `${id}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

function spec(id: string) {
  const p = join(SESSION_DIR, `${id}.spec.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
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

  test("RF_DEADLINE reaches the child env; RF_MAX_TIME is stripped (re-entry guard)", async () => {
    // The runner consumes --max-time/--deadline in the CLI process itself. The
    // GRANDCHILD must see RF_DEADLINE (threaded through) but NOT RF_MAX_TIME —
    // a child that re-triggers speculation would recurse (observed: 875 spec
    // files from exactly that recursion before the guard existed).
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
    expect(out).toContain("RF_DEADLINE=60");
    expect(out).not.toContain("RF_MAX_TIME=");
  });

  test("without --max-time, no RF_MAX_TIME is set (default path unchanged)", async () => {
    const { out, exit } = await runCli(["run", "--", "env"]);
    expect(exit).toBe(0);
    expect(out).not.toContain("RF_MAX_TIME=");
  });
});

describe("Cycle 2 — Tier 1: breach detaches instead of killing", () => {
  test(
    "a command breaching --max-time returns a session id, keeps the original running, and writes a speculation record",
    async () => {
      // `--max-time 1 sleep 3`: breaches at 1s. The call must return promptly
      // (~1-2s, NOT wait the full 3s), the original must NOT be killed
      // (meta.state stays "running"), and a speculation record must exist.
      const started = Date.now();
      const { out, err, exit } = await runCli([
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

      // The call returned (not killed at breach) with a session id.
      expect(exit).toBe(0);
      // sessionLine writes to stderr — search both streams for the id.
      const id = extractId(out + err);
      expect(id).not.toBeNull();

      // Returned promptly — well under the 3s sleep (breach at 1s, handoff sub-ms).
      expect(elapsed).toBeLessThan(2800);

      // The original is still running (detached, NOT killed).
      const m = meta(id!);
      expect(m).not.toBeNull();
      expect(m.state).toBe("running");

      // A speculation record exists referencing this id + the command shape.
      const s = spec(id!);
      expect(s).not.toBeNull();
      expect(s.id).toBe(id);
      expect(s.shape).toBe("sleep 3");
      expect(typeof s.breachAt).toBe("number");
      // deadlineAt = breachAt + --deadline (90).
      expect(s.deadlineAt - s.breachAt).toBe(90_000);
    },
    10_000,
  );

  test("a command finishing under --max-time returns normally with NO speculation record", async () => {
    const { out, exit } = await runCli([
      "run",
      "--max-time",
      "5",
      "--deadline",
      "90",
      "--",
      "echo",
      "fast",
    ]);
    expect(exit).toBe(0);
    expect(out).toContain("fast");
    // No breach → no speculation record for this run.
    const id = extractId(out);
    if (id) expect(spec(id)).toBeNull();
  });
});