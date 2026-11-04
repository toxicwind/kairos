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
  test("bans | true, 2>&1, sleep", () => {
    expect(firstBan("make | true")).toBeTruthy();
    expect(firstBan("cmd 2>&1 | foo")).toBeTruthy();
    expect(firstBan("sleep 5 && cmd")).toBeTruthy();
  });
  test("display truncation (| head/| tail/| wc, head -c, tail -c) is NOT banned", () => {
    // kairos is mostly invisible: display windows and byte slices are the
    // agent's call, never scolded or cancelled. Full output is still
    // live-persisted to the session file, so nothing is lost.
    expect(firstBan("cmd | head -20")).toBeNull();
    expect(firstBan("cmd | tail -5")).toBeNull();
    expect(firstBan("cmd | wc -l")).toBeNull();
    expect(firstBan("head -c 100 file")).toBeNull();
    expect(firstBan("tail -c 50 file")).toBeNull();
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
    expect(deadlineFor(["git", "status"], 2.0)).toBe(10);
    expect(deadlineFor(["bun", "test"], 2.0)).toBe(2.0);
  });
  test("detachDeadline ceiling", () => {
    expect(detachDeadline(["git", "push"])).toBe(600);
  });
  test("explicit --deadline=N is strict, verbatim (overrides bumps + base)", () => {
    // A user-supplied strict deadline beats DEADLINE_BUMPS (tsgo=10, MAX_BLOCKING_DEADLINE) and the base.
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
    expect(deadlineFor(["tsgo", "--noEmit"], 4.0)).toBe(10);
    expect(deadlineFor(["git", "status"], 4.0)).toBe(10);
    expect(deadlineFor(["echo", "hi"], 4.0)).toBe(4.0);
  });
  test("deadlineFor skips git -C flag+value to find the subcommand", () => {
    // `git -C /path status` → effective sub is status (bumped to 10s), not the path.
    expect(deadlineFor(["git", "-C", "/tmp", "status"], 4.0)).toBe(10);
    expect(deadlineFor(["git", "--git-dir", "/x", "push"], 4.0)).toBe(600);
    expect(deadlineFor(["git", "--work-tree", "/x", "pull"], 4.0)).toBe(600);
  });
  test("deadlineFor honors bin-level bumps (gh)", () => {
    expect(deadlineFor(["gh", "repo", "view"], 4.0)).toBe(10);
  });
});

describe("kairos shim canonical-path emission", () => {
  const shim = emitBashShim();

  test("RF_BIN resolves via ~/.local/bin (estate bin-contract), not barn/estate-ops", () => {
    expect(shim).toContain("$HOME/.local/bin/run-fast");
    expect(shim).not.toContain("$HOME/pens/barn/");
  });

  test("DELEND_CODE_RACE fallback is the hephaistos code-race plugin entry", () => {
    // init.ts embeds the runtime-expanded absolute path (not a runtime $HOME
    // expansion) — the shim literal carries the absolute pens path.
    expect(shim).toContain(
      "/home/toxic/pens/ergasterion/products/hephaistos/plugins/code-race/src/index.ts",
    );
    expect(shim).not.toContain("$HOME/pens/barn/");
  });

  test("no stale estate/ranch mirror path remains in the emitted shim", () => {
    expect(shim).not.toContain("estate/ranch");
  });

  test("shim head/tail/wc are FULLY invisible — no wrappers, no bans, no ffs routing", () => {
    // kairos must not intercept head/tail/wc at all: they run the real binaries.
    // Display truncation is the agent's call; full output is live-persisted to
    // the session file regardless, so nothing is lost.
    expect(shim).not.toMatch(/^head\(\)/);
    expect(shim).not.toMatch(/^tail\(\)/);
    expect(shim).not.toMatch(/^wc\(\)/);
    // No byte-truncation banCase for head/tail -c either.
    expect(shim).not.toMatch(/byte truncation/);
    // The comment documents the invisibility.
    expect(shim).toMatch(/FULLY invisible/);
  });

  test("shim preserves the full guard family for agent-shell snapshots", () => {
    // tau's shell-snapshot strips `_2s_*` and `head|tail` as common tools; the
    // estate shim re-adds the FULL family so bun()/git() and head/tail wrappers
    // are never orphaned (command-not-found) in agent tool shells.
    expect(shim).toMatch(/_2s_wrap/);
    expect(shim).toMatch(/_2s_guard/);
    expect(shim).toMatch(/_2s_urgent/);
  });

  test("shim does NOT export -f wrappers (leaks BASH_FUNC_* into interactive/user bash)", () => {
    // Regression: the old shim did `export -f head tail wc git bun ...`, which put
    // BASH_FUNC_head%%/tail%%/wc%%/... into the env of every child AND interactive
    // shell, hijacking the human's bash (pipelines cancelled) and breaking .bashrc.
    // Enforcement for agent children must come from BASH_ENV re-sourcing, not from
    // exported function definitions. The word `export -f` may only appear in a
    // leading comment explaining the removal, never as an executable line.
    const funcLines = shim
      .split("\n")
      .filter((line) => /^\s*export\s+-f\b/.test(line));
    expect(funcLines).toEqual([]);
  });

  test("shim gates on KAIROS_ENFORCE so an interactive shell goes idle, agents enforce", () => {
    // Regression: the shim armed its DEBUG trap and wrapped binaries in EVERY
    // shell, so a human's interactive bash was cancelled too. It now defaults to
    // idle in interactive shells (KAIROS_ENFORCE=0) and enforces in agent shells.
    expect(shim).toMatch(/KAIROS_ENFORCE/);
    expect(shim).toMatch(/KAIROS_SHIM_MODE=interactive/);
    expect(shim).toMatch(/KAIROS_SHIM_MODE=agent/);
    expect(shim).toMatch(/== \*i\* ]]; then/); // interactive detection via $-
  });
});
