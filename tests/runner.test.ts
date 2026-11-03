import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runSession,
  runDetached,
  attachSession,
  logsSession,
  listSessions,
  purgeSessions,
  cancelSession,
} from "../src/runner.ts";

let tmp: string;

afterEach(() => {
  delete process.env.KAIROS_SESSION_DIR;
  delete process.env.KAIROS_DEBUG;
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

function useTmpSession() {
  tmp = mkdtempSync(join(tmpdir(), "kairos-run-"));
  process.env.KAIROS_SESSION_DIR = tmp;
  return tmp;
}

describe("runSession", () => {
  test("echo returns its output in stdout", async () => {
    useTmpSession();
    const r = await runSession(["echo", "hello"], { quiet: true });
    expect(r.verdict).toBe("ok");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello");
  });

  test("MITM: | head returns the FULL upstream output (ls is not windowed)", async () => {
    useTmpSession();
    const r = await runSession(
      ["ls", "/home/toxic/pens/olympus/products/kairos", "|", "head", "-1"],
      { quiet: true },
    );
    expect(r.verdict).toBe("ok");
    // head -1 would return 1 line; the MITM returns the FULL listing.
    expect(r.stdout.split("\n").filter(Boolean).length).toBeGreaterThan(1);
    expect(r.stdout).toContain("package.json");
  });

  test("rewrites banned cat to ffs read invisibly (returns file content)", async () => {
    useTmpSession();
    const r = await runSession(
      ["cat", "/home/toxic/pens/olympus/products/kairos/package.json"],
      { quiet: true },
    );
    expect(r.verdict).toBe("ok");
    expect(r.exitCode).toBe(0);
    // The rewrite must return the real file content, not an error or empty.
    expect(r.stdout).toContain('"name": "kairos"');
  });

  test("reports fail on non-zero exit", async () => {
    useTmpSession();
    const r = await runSession(["false"], { quiet: true });
    expect(r.verdict).toBe("fail");
    expect(r.exitCode).toBe(1);
  });

  test("detaches slow network ops (git status, not push)", async () => {
    useTmpSession();
    process.env.KAIROS_WAIT = "0";
    // Use git status (read-only) — never git push in a test.
    const r = await runSession(["git", "status"], { quiet: true });
    expect(r.verdict).toBe("ok");
  });

  test("--cwd changes the working directory (pwd reflects it)", async () => {
    useTmpSession();
    const r = await runSession(
      ["--cwd", "/tmp", "pwd"],
      { quiet: true },
    );
    expect(r.verdict).toBe("ok");
    expect(r.stdout).toContain("/tmp");
  });

  test("--env reaches the child (echo $FOO expands)", async () => {
    useTmpSession();
    const r = await runSession(
      ["--env", "FOO=bar", "sh", "-c", "echo $FOO"],
      { quiet: true },
    );
    expect(r.verdict).toBe("ok");
    expect(r.stdout).toContain("bar");
  });

  test("coerces bash -c one-shot shell (output is the command's)", async () => {
    useTmpSession();
    const r = await runSession(
      ["-c", "echo shell-coerced"],
      { quiet: true },
    );
    expect(r.verdict).toBe("ok");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("shell-coerced");
  });

  test("handles && short-circuit (right side does not run on failure)", async () => {
    useTmpSession();
    // `false && echo nope` — the && short-circuits, so 'nope' never prints.
    const r = await runSession(["false", "&&", "echo", "nope"], { quiet: true });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).not.toContain("nope");
  });

  test("handles ; sequential operator (both commands run)", async () => {
    useTmpSession();
    const r = await runSession(["echo", "a", ";", "echo", "b"], { quiet: true });
    expect(r.verdict).toBe("ok");
    expect(r.stdout).toContain("a");
    expect(r.stdout).toContain("b");
  });

  test("multi-segment pipe runs through bash (grep filters)", async () => {
    useTmpSession();
    const r = await runSession(
      ["printf", "a\\nb\\nc", "|", "grep", "b"],
      { quiet: true },
    );
    expect(r.exitCode).toBe(0);
    // grep b must filter to only the 'b' line.
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(["b"]);
  });

  test("env FOO=bar inline assignment reaches the child", async () => {
    useTmpSession();
    const r = await runSession(["FOO=bar", "sh", "-c", "echo $FOO"], { quiet: true });
    expect(r.verdict).toBe("ok");
    expect(r.stdout).toContain("bar");
  });

  test("MITM: | head returns the FULL upstream output, not the window", async () => {
    useTmpSession();
    const r = await runSession(
      ["printf", "a\\nb\\nc\\nd\\ne", "|", "head", "-2"],
      { quiet: true },
    );
    expect(r.verdict).toBe("ok");
    // The truncator is stripped — every byte of the upstream is returned.
    expect(r.stdout).toContain("a");
    expect(r.stdout).toContain("e");
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("MITM: | tail returns the FULL upstream output, not just the tail", async () => {
    useTmpSession();
    const r = await runSession(
      ["printf", "a\\nb\\nc\\nd\\ne", "|", "tail", "-2"],
      { quiet: true },
    );
    expect(r.verdict).toBe("ok");
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("MITM: | wc returns the FULL upstream output, not the line count", async () => {
    useTmpSession();
    const r = await runSession(
      ["printf", "a\\nb\\nc\\nd\\ne", "|", "wc", "-l"],
      { quiet: true },
    );
    expect(r.verdict).toBe("ok");
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("MITM: head file returns the FULL file contents, not the first N lines", async () => {
    useTmpSession();
    const r = await runSession(
      ["head", "-2", "/home/toxic/pens/olympus/products/kairos/package.json"],
      { quiet: true },
    );
    expect(r.verdict).toBe("ok");
    // Full file content is present — not just the first 2 lines.
    expect(r.stdout).toContain('"name": "kairos"');
    expect(r.stdout).toContain('"scripts"');
    expect(r.stdout.split("\n").length).toBeGreaterThan(2);
  });

  test("MITM: wc file returns the FULL file contents, not the count", async () => {
    useTmpSession();
    const r = await runSession(
      ["wc", "-l", "/home/toxic/pens/olympus/products/kairos/package.json"],
      { quiet: true },
    );
    expect(r.verdict).toBe("ok");
    expect(r.stdout).toContain('"name": "kairos"');
    expect(r.stdout.split("\n").length).toBeGreaterThan(2);
  });

  test("MITM: tail file returns the FULL file contents, not the last N lines", async () => {
    useTmpSession();
    const r = await runSession(
      ["tail", "-2", "/home/toxic/pens/olympus/products/kairos/package.json"],
      { quiet: true },
    );
    expect(r.verdict).toBe("ok");
    expect(r.stdout).toContain('"name": "kairos"');
    expect(r.stdout.split("\n").length).toBeGreaterThan(2);
  });

  test("MITM: a plain pipeline (no truncator) is untouched and returns its output", async () => {
    useTmpSession();
    const r = await runSession(
      ["printf", "x\\ny", "|", "tr", "a-z", "A-Z"],
      { quiet: true },
    );
    expect(r.verdict).toBe("ok");
    expect(r.stdout).toContain("X");
    expect(r.stdout).toContain("Y");
  });

  test("strict mode hard-blocks banned commands via subprocess", async () => {
    useTmpSession();
    const proc = Bun.spawn(
      ["bun", "src/cli.ts", "run", "cat", "package.json"],
      {
        cwd: "/home/toxic/pens/olympus/products/kairos",
        env: { ...process.env, KAIROS_STRICT: "1", KAIROS_DEBUG: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const exit = await proc.exited;
    expect(exit).toBe(126);
  });

  test("banned command with no rewrite runs as-is", async () => {
    useTmpSession();
    // `paste` is banned but has no 1:1 rewrite → runs as-is via the notice path.
    const r = await runSession(["paste", "/etc/hostname"], { quiet: true });
    expect(r.verdict).toBe("ok");
  });

  test("passes --env and KEY=value env to the child", async () => {
    useTmpSession();
    const r = await runSession(
      ["--env", "FOO=bar", "sh", "-c", "echo $FOO"],
      { quiet: true },
    );
    expect(r.verdict).toBe("ok");
  });

  test("--cwd changes the working directory", async () => {
    useTmpSession();
    const r = await runSession(
      ["--cwd", "/tmp", "pwd"],
      { quiet: true },
    );
    expect(r.verdict).toBe("ok");
  });

  test("reports breach when a command exceeds the explicit deadline", async () => {
    useTmpSession();
    process.env.RF_DEADLINE = "0.1";
    const r = await runSession(["sleep", "0.5"], { quiet: true });
    expect(r.verdict).toBe("breach");
    delete process.env.RF_DEADLINE;
  });

  test("handles --id session name", async () => {
    useTmpSession();
    const r = await runSession(
      ["--id", "named-session", "echo", "hi"],
      { quiet: true },
    );
    expect(r.verdict).toBe("ok");
  });

  test("logsSession with an id reads the session file", async () => {
    useTmpSession();
    await runDetached(["echo", "logged-output"], { quiet: true });
    await new Promise((r) => setTimeout(r, 100));
    const orig = process.stdout.write;
    let captured = "";
    process.stdout.write = ((c: string) => {
      captured += String(c);
      return true;
    }) as typeof process.stdout.write;
    try {
      const { getSessions } = await import("../src/session.ts");
      const ss = getSessions();
      if (ss.length) await logsSession(ss[0].id);
    } finally {
      process.stdout.write = orig;
    }
    expect(captured).toContain("logged-output");
  });

  test("attachSession on a done session streams its output", async () => {
    useTmpSession();
    await runDetached(["echo", "attached-output"], { quiet: true });
    await new Promise((r) => setTimeout(r, 100));
    const orig = process.stdout.write;
    let captured = "";
    process.stdout.write = ((c: string) => {
      captured += String(c);
      return true;
    }) as typeof process.stdout.write;
    try {
      const { getSessions } = await import("../src/session.ts");
      const ss = getSessions();
      if (ss.length) await attachSession(ss[0].id);
    } finally {
      process.stdout.write = orig;
    }
    expect(captured).toContain("attached-output");
  });

  test("does not corrupt ls -l (real flag, not shell login)", async () => {
    useTmpSession();
    const r = await runSession(
      ["ls", "-l", "/home/toxic/pens/olympus/products/kairos"],
      { quiet: true },
    );
    expect(r.verdict).toBe("ok");
  });
});

describe("session lifecycle", () => {
  test("runDetached creates a session that completes", async () => {
    const dir = useTmpSession();
    const { id } = await runDetached(["echo", "detached-ok"], { quiet: true });
    expect(id).toMatch(/^rf-/);
    // Wait for completion (poll the meta file)
    const metaPath = join(dir, `${id}.json`);
    let done = false;
    for (let i = 0; i < 50; i++) {
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, "utf8"));
        if (meta.state === "done") {
          done = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(done).toBe(true);
  });

  test("logsSession lists sessions", async () => {
    useTmpSession();
    await runDetached(["echo", "x"], { quiet: true });
    await new Promise((r) => setTimeout(r, 50));
    // logsSession writes to stdout; capture it.
    const orig = process.stdout.write;
    let captured = "";
    process.stdout.write = ((c: string) => {
      captured += String(c);
      return true;
    }) as typeof process.stdout.write;
    try {
      await logsSession();
    } finally {
      process.stdout.write = orig;
    }
    expect(captured).toContain("id=rf-");
  });

  test("listSessions returns session rows", async () => {
    useTmpSession();
    await runDetached(["echo", "y"], { quiet: true });
    await new Promise((r) => setTimeout(r, 50));
    const orig = process.stdout.write;
    let captured = "";
    process.stdout.write = ((c: string) => {
      captured += String(c);
      return true;
    }) as typeof process.stdout.write;
    try {
      await listSessions();
    } finally {
      process.stdout.write = orig;
    }
    expect(captured).toContain("id=rf-");
  });

  test("purgeSessions removes sessions", async () => {
    const dir = useTmpSession();
    await runDetached(["echo", "z"], { quiet: true });
    await new Promise((r) => setTimeout(r, 50));
    await purgeSessions();
    const remaining = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(remaining.length).toBe(0);
  });

  test("purgeSessions with a pattern only removes matching", async () => {
    const dir = useTmpSession();
    await runDetached(["echo", "keep-me"], { quiet: true });
    await runDetached(["echo", "drop-me"], { quiet: true });
    await new Promise((r) => setTimeout(r, 300));
    const { getSessions } = await import("../src/session.ts");
    const before = getSessions();
    await purgeSessions("drop-me");
    const remaining = getSessions();
    expect(remaining.some((s) => s.cmd.includes("drop-me"))).toBe(false);
    expect(remaining.some((s) => s.cmd.includes("keep-me"))).toBe(true);
  });

  test("logsSession with no id lists recent sessions", async () => {
    useTmpSession();
    await runDetached(["echo", "list-me"], { quiet: true });
    await new Promise((r) => setTimeout(r, 100));
    const orig = process.stdout.write;
    let captured = "";
    process.stdout.write = ((c: string) => {
      captured += String(c);
      return true;
    }) as typeof process.stdout.write;
    try {
      await logsSession();
    } finally {
      process.stdout.write = orig;
    }
    expect(captured).toContain("list-me");
  });

  test("logsSession with no id and no sessions prints no-sessions", async () => {
    const dir = useTmpSession();
    // Ensure the dir exists but is empty.
    const orig = process.stdout.write;
    let captured = "";
    process.stdout.write = ((c: string) => {
      captured += String(c);
      return true;
    }) as typeof process.stdout.write;
    try {
      await logsSession();
    } finally {
      process.stdout.write = orig;
    }
    expect(captured).toContain("no sessions");
  });

  test("cancelSession on a nonexistent id is a no-op", async () => {
    useTmpSession();
    await cancelSession("rf-nonexistent");
  });
});