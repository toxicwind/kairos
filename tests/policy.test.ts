import { describe, test, expect } from "bun:test";
import {
  firstBan,
  isSlow,
  shouldDetach,
  detachDeadline,
  deadlineFor,
} from "../src/policy.ts";
import { guard } from "../src/guard.ts";
import { emitBashShim } from "../src/init.ts";

describe("policy", () => {
  test("bans /dev/null redirects", () => {
    expect(firstBan("echo hi >/dev/null")?.reason).toContain("/dev/null");
    expect(firstBan("cmd 2>/dev/null")?.reason).toContain("/dev/null");
  });
  test("bans | true, 2>&1, pipe truncation, sleep", () => {
    expect(firstBan("make | true")).toBeTruthy();
    expect(firstBan("cmd 2>&1 | foo")).toBeTruthy();
    expect(firstBan("cmd | head -20")).toBeTruthy();
    expect(firstBan("sleep 5 && cmd")).toBeTruthy();
  });
  test("allows clean commands", () => {
    expect(firstBan("git status --porcelain")).toBeNull();
    expect(firstBan("ffs grep pattern --limit 5")).toBeNull();
  });
  test("slow routing table", () => {
    expect(isSlow("git", "push")).toBe(true);
    expect(isSlow("git", "status")).toBe(false);
    expect(isSlow("bun", "install")).toBe(true);
    expect(isSlow("bun", "--version")).toBe(false);
    expect(isSlow("make", "")).toBe(true);
  });
  test("guard cancels violations (exit 1), allows clean (0)", () => {
    expect(guard("echo x >/dev/null")).toBe(0); // rewrite class: notify, not cancel
    expect(guard("git status")).toBe(0);
  });
  test("guard ignores its own internals", () => {
    expect(guard("_2s_slow git push")).toBe(0);
    expect(guard("")).toBe(0);
  });
  test("auto-detach network/inherently-slow ops (fix, don't scold)", () => {
    expect(shouldDetach(["git", "push", "origin", "main"])).toBe(true);
    expect(shouldDetach(["git", "pull"])).toBe(true);
    expect(shouldDetach(["git", "clone", "repo"])).toBe(true);
    expect(shouldDetach(["git", "merge", "branch"])).toBe(true);
    expect(shouldDetach(["git", "rebase", "main"])).toBe(true);
    expect(shouldDetach(["gh", "pr", "create"])).toBe(true);
    expect(shouldDetach(["make"] as string[])).toBe(true);
  });
  test("fast/local commands stay foreground (not detached)", () => {
    expect(shouldDetach(["git", "status", "--porcelain"])).toBe(false);
    expect(shouldDetach(["bun", "test"])).toBe(false);
    expect(shouldDetach(["ffs", "grep", "x"])).toBe(false);
    expect(shouldDetach([])).toBe(false);
  });
  test("git network ops get a generous deadline (not the 2s base)", () => {
    expect(deadlineFor(["git", "push"], 2.0)).toBe(600);
    expect(deadlineFor(["git", "pull"], 2.0)).toBe(600);
    expect(deadlineFor(["git", "status"], 2.0)).toBe(20);
    expect(deadlineFor(["bun", "test"], 2.0)).toBe(2.0);
  });
  test("detachDeadline ceiling", () => {
    expect(detachDeadline(["git", "push"])).toBe(600);
  });
  test("explicit --deadline=N is strict, verbatim (overrides bumps + base)", () => {
    // A user-supplied strict deadline beats DEADLINE_BUMPS (tsgo=180) and the base.
    expect(deadlineFor(["tsgo", "--noEmit"], 4.0, 1.0)).toBe(1.0);
    expect(deadlineFor(["git", "push"], 4.0, 2.5)).toBe(2.5);
    expect(deadlineFor(["bun", "test"], 4.0, 0.5)).toBe(0.5);
    expect(deadlineFor(["echo", "hi"], 4.0, 3.0)).toBe(3.0);
  });
  test("deadlineFor tolerates undefined/empty args (empty pipe group upstream)", () => {
    // `head -5 file` rewrites to an empty upstream group; the runner passes
    // upstream[0] verbatim. That must resolve to the base deadline, not crash.
    expect(deadlineFor(undefined as unknown as string[], 4.0)).toBe(4.0);
    expect(deadlineFor([], 4.0)).toBe(4.0);
    expect(shouldDetach(undefined as unknown as string[])).toBe(false);
  });
  test("without explicitS, deadlineFor still honors bumps + base", () => {
    expect(deadlineFor(["tsgo", "--noEmit"], 4.0)).toBe(180);
    expect(deadlineFor(["git", "status"], 4.0)).toBe(20);
    expect(deadlineFor(["echo", "hi"], 4.0)).toBe(4.0);
  });
});

describe("kairos shim canonical-path emission", () => {
  const shim = emitBashShim();

  test("RF_BIN points at the canonical pens/barn/estate-ops/run-fast (not stale estate/bin)", () => {
    expect(shim).toContain("$HOME/pens/barn/estate-ops/run-fast");
    expect(shim).not.toContain("$HOME/estate/bin/run-fast");
  });

  test("DELEND_CODE_RACE fallback is the canonical pens/barn/estate-ops path", () => {
    expect(shim).toContain("$HOME/pens/barn/estate-ops/delend-code-race");
    expect(shim).not.toContain("$HOME/estate/bin/delend-code-race");
  });

  test("no stale estate/ranch mirror path remains in the emitted shim", () => {
    expect(shim).not.toContain("estate/ranch");
  });

  test("shim head/tail doctrine wrappers route files to ffs and cancel pipes", () => {
    // Regression: agents kept using head/tail because (1) the wrappers only
    // matched `-n N FILE` and (2) the DEBUG trap can't see piped segments.
    // The wrappers must reference ffs for file reads and cancel piped streams.
    expect(shim).toMatch(/command ffs read/);         // file truncation → ffs
    expect(shim).toMatch(/never pipe head/);          // pipe-truncation doctrine
    expect(shim).toMatch(/never pipe tail/);
    expect(shim).toMatch(/\[ -p \/dev\/stdin \]/);    // pipe detection lives in the wrapper
    // The wrapper must be self-contained (locally defined loop var, no ghosts).
    expect(shim).toMatch(/for _a in "\$@"/);
    // `-f` (follow) is monitoring, not truncation — must pass through unchanged.
    expect(shim).toMatch(/\[ "\$1" = "-f" \]/);
    // wc is also banned for pipelines (head/tail/wc) — must have a wrapper too,
    // not just head/tail. Legit file counting (wc -l FILE) passes through.
    expect(shim).toMatch(/never pipe wc/);
    expect(shim).toMatch(/\bwc\(\)/);
  });

  test("shim preserves the full guard family for agent-shell snapshots", () => {
    // tau's shell-snapshot strips `_2s_*` and `head|tail` as common tools; the
    // estate shim re-adds the FULL family so bun()/git() and head/tail wrappers
    // are never orphaned (command-not-found) in agent tool shells.
    expect(shim).toMatch(/_2s_wrap/);
    expect(shim).toMatch(/_2s_guard/);
    expect(shim).toMatch(/_2s_urgent/);
  });
});
