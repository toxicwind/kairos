import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// KHSR speculative-race tests. Every feature is RED-first: the test asserts the
// REAL contract (flag consumed, breach detaches, hephaistos invoked, arbitration,
// ledger) and is written BEFORE the implementation exists.

const HOME = homedir();
const KAIROS = join(HOME, "pens/flux/products/kairos");
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
describe("Cycle 3 — Tier 2: hephaistos race invocation + cheap verify gate", () => {
  test(
    "at breach, kairos invokes the race entrypoint with the command shape as argv + spec context env",
    async () => {
      // Fake race entrypoint: a REAL script (no mock framework) that records
      // the argv + env it received to a file, then exits 0. The plugin's real
      // contract is `race "<cmd>"` argv + KAIROS_SPEC_* env (no stdin).
      const raceBin = join(SESSION_DIR, "fake-race.ts");
      const raceSeen = join(SESSION_DIR, "race-seen.json");
      await Bun.write(
        raceBin,
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(raceSeen)}, JSON.stringify({ argv: process.argv.slice(2), specId: process.env.KAIROS_SPEC_ID, deadlineAt: process.env.KAIROS_SPEC_DEADLINE_AT }));
console.log("race done");`,
      );
      const { out, err, exit } = await runCli(
        ["run", "--max-time", "1", "--deadline", "90", "--", "sleep", "3"],
        { KAIROS_RACE_BIN: raceBin },
      );
      expect(exit).toBe(0);
      // The race entrypoint is fire-and-forget — poll briefly for its record.
      let seenRaw = "";
      for (let i = 0; i < 30 && !seenRaw; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          seenRaw = readFileSync(raceSeen, "utf-8");
        } catch {}
      }
      const seen = JSON.parse(seenRaw);
      const id = extractId(out + err);
      expect(id).not.toBeNull();
      expect(seen.specId).toBe(id);
      // The command shape rides as the argv command line.
      expect(seen.argv.join(" ")).toContain("sleep");
      expect(Number(seen.deadlineAt)).toBeGreaterThan(Date.now());
    },
    10_000,
  );

  test("a candidate that fails cheap verify is never raced (verify gate)", async () => {
    // verifyCandidate contract: same output shape AND strictly faster on the
    // sample, else the candidate is discarded (returns null).
    const { verifyCandidate } = await import("../src/speculate.ts");
    // Candidate: same output ("hi"), but SLOWER than the baseline — must be discarded.
    const slower = {
      cmd: 'sleep 0.2 && echo hi',
      run: async () => ({ stdout: "hi\n", exitCode: 0 }),
    };
    const baseline = async () => ({ stdout: "hi\n", exitCode: 0 });
    const verdict = await verifyCandidate(slower.cmd, baseline, "hi\n");
    expect(verdict).toBeNull();
  });

  test("a candidate that passes cheap verify (same shape, faster) is accepted", async () => {
    const { verifyCandidate } = await import("../src/speculate.ts");
    // Baseline = the ORIGINAL command actually executed (slow: sleep 0.3).
    const baseline = async () => {
      const p = Bun.spawn(["/bin/bash", "-c", "sleep 0.3 && echo hi"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const stdout = await new Response(p.stdout).text();
      await p.exited;
      return { stdout, exitCode: p.exitCode ?? 1 };
    };
    // Candidate = the REMOVAL of the sleep (the architect's point: the fastest
    // correct command is the command with the sleep deleted).
    const verdict = await verifyCandidate("echo hi", baseline, "hi\n");
    expect(verdict).not.toBeNull();
    expect(verdict!.cmd).toBe("echo hi");
    expect(verdict!.sampleSpeedup).toBeGreaterThan(1);
  });
});

describe("Cycle 3b — Tier 3 edge cases: speculation viability", () => {
  test("race window shorter than race boot cost → hephaistos is NEVER invoked (viability gate)", async () => {
    // --max-time 1 --deadline 2: the original (sleep 3) breaches at 1s but its
    // remaining budget (2s) cannot beat the race boot+verify cost. Invoking
    // hephaistos is guaranteed waste — the viability gate must skip it.
    const raceBin = join(SESSION_DIR, "fake-race-viability.ts");
    const raceSeen = join(SESSION_DIR, "race-viability-seen.json");
    await Bun.write(
      raceBin,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(raceSeen)}, JSON.stringify({ argv: process.argv.slice(2), specId: process.env.KAIROS_SPEC_ID }));`,
    );
    const { exit } = await runCli(
      ["run", "--max-time", "1", "--deadline", "2", "--", "sleep", "3"],
      { KAIROS_RACE_BIN: raceBin },
    );
    expect(exit).toBe(0);
    // Give any (wrongly) fired race process time to write.
    await new Promise((r) => setTimeout(r, 800));
    expect(existsSync(raceSeen)).toBe(false);
    // The speculation record still exists (the original is still tracked).
  });

  test("viability gate: remaining window >= boot cost → race IS invoked", async () => {
    const raceBin = join(SESSION_DIR, "fake-race-viability2.ts");
    const raceSeen = join(SESSION_DIR, "race-viability2-seen.json");
    await Bun.write(
      raceBin,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(raceSeen)}, JSON.stringify({ argv: process.argv.slice(2), specId: process.env.KAIROS_SPEC_ID }));`,
    );
    await runCli(
      ["run", "--max-time", "1", "--deadline", "90", "--", "sleep", "3"],
      { KAIROS_RACE_BIN: raceBin },
    );
    let seen = "";
    for (let i = 0; i < 30 && !seen; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { seen = readFileSync(raceSeen, "utf-8"); } catch {}
    }
    expect(seen).not.toBe("");
  });
});

describe("Cycle 4 — Tier 3: first-to-correct arbitration + 90s re-attach", () => {
  test("arbitrate: original exits 0 before deadline → original wins, candidates dropped", async () => {
    const { arbitrate } = await import("../src/speculate.ts");
    // Original completes quickly with exit 0; candidate is slower.
    const result = await arbitrate({
      id: "arb-1",
      shape: "sleep 3",
      deadlineAt: Date.now() + 60_000,
      original: () => Promise.resolve({ exitCode: 0, stdout: "original-out\n" }),
      candidates: [async () => ({ cmd: "echo candidate", stdout: "candidate-out\n" })],
    });
    expect(result.winner).toBe("original");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("original-out\n");
  });

  test("arbitrate: verified candidate finishes first → candidate wins, original cancelled after correctness", async () => {
    const { arbitrate } = await import("../src/speculate.ts");
    // Original is slow (never resolves in time); candidate is fast and correct.
    const result = await arbitrate({
      id: "arb-2",
      shape: "sleep 3",
      deadlineAt: Date.now() + 60_000,
      original: () => new Promise((r) => setTimeout(() => r({ exitCode: 0, stdout: "original\n" }), 5000)),
      candidates: [async () => ({ cmd: "echo candidate", stdout: "candidate\n" })],
      cancelOriginal: async () => {},
    });
    expect(result.winner).toBe("candidate");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("candidate\n");
  });

  test("arbitrate: deadline hit with no winner → speculation-failed, re-attach original", async () => {
    const { arbitrate } = await import("../src/speculate.ts");
    let cancelled = false;
    const result = await arbitrate({
      id: "arb-3",
      shape: "sleep 3",
      deadlineAt: Date.now() + 300, // 300ms window
      original: () => new Promise((r) => setTimeout(() => r({ exitCode: 0, stdout: "late\n" }), 2000)),
      candidates: [() => new Promise((r) => setTimeout(() => r({ cmd: "echo x", stdout: "x\n" }), 2000))],
      cancelOriginal: async () => { cancelled = true; },
    });
    expect(result.winner).toBe("none");
    expect(result.speculationFailed).toBe(true);
    // The original is NOT cancelled on deadline-hit — it is re-attached instead.
    expect(cancelled).toBe(false);
  });
});

describe("Cycle 5 — Tier 4: ledger + no-speculate marks", () => {
  test("every race appends a JSONL row to the ledger", async () => {
    const { recordRace, readLedger } = await import("../src/speculate.ts");
    const ledgerPath = join(SESSION_DIR, "speculation-ledger.jsonl");
    recordRace(ledgerPath, {
      command_shape: "grep -r x /tmp",
      winner: "original",
      candidate: null,
      sample_speedup: 0,
      full_speedup: 1,
      verify_cost_ms: 12,
    });
    recordRace(ledgerPath, {
      command_shape: "grep -r x /tmp",
      winner: "candidate",
      candidate: "ffs grep x",
      sample_speedup: 2.5,
      full_speedup: 3.1,
      verify_cost_ms: 40,
    });
    const rows = readLedger(ledgerPath);
    expect(rows.length).toBe(2);
    expect(rows[0].winner).toBe("original");
    expect(rows[1].candidate).toBe("ffs grep x");
  });

  test("shape with >=3 original-wins gets no-speculate", async () => {
    const { recordRace, shouldNoSpeculate } = await import("../src/speculate.ts");
    const ledgerPath = join(SESSION_DIR, "speculation-ledger-ns.jsonl");
    for (let i = 0; i < 3; i++) {
      recordRace(ledgerPath, {
        command_shape: "sleep 30",
        winner: "original",
        candidate: null,
        sample_speedup: 0,
        full_speedup: 1,
        verify_cost_ms: 5,
      });
    }
    expect(shouldNoSpeculate(ledgerPath, "sleep 30")).toBe(true);
    // A different shape is not marked.
    expect(shouldNoSpeculate(ledgerPath, "grep -r x /tmp")).toBe(false);
  });
});
