import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadProjectPolicy,
  loadIgnore,
  effectiveBans,
  effectiveDeadline,
  logVerdict,
} from "../src/project-policy.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kairos-proj-"));
  mkdirSync(join(tmp, ".two-sec"), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

describe("loadProjectPolicy", () => {
  test("returns {} when no policy file", () => {
    expect(loadProjectPolicy(tmp)).toEqual({});
  });
  test("parses policy.json", () => {
    writeFileSync(
      join(tmp, ".two-sec", "policy.json"),
      JSON.stringify({ deadlineS: 8, extraBans: [], disableBans: ["sleep"] }),
    );
    expect(loadProjectPolicy(tmp).deadlineS).toBe(8);
  });
  test("returns {} on invalid JSON", () => {
    writeFileSync(join(tmp, ".two-sec", "policy.json"), "{invalid");
    expect(loadProjectPolicy(tmp)).toEqual({});
  });
});

describe("loadIgnore", () => {
  test("returns [] when no ignore file", () => {
    expect(loadIgnore(tmp)).toEqual([]);
  });
  test("parses ignore lines, skips comments/blanks", () => {
    writeFileSync(
      join(tmp, ".two-sec", "ignore"),
      "# comment\n\nsleep\n",
    );
    const re = loadIgnore(tmp);
    expect(re.length).toBe(1);
    expect(re[0].test("sleep")).toBe(true);
  });
  test("escapes invalid regex lines", () => {
    writeFileSync(join(tmp, ".two-sec", "ignore"), "a[bc\n");
    const re = loadIgnore(tmp);
    expect(re.length).toBe(1);
  });
});

describe("effectiveBans", () => {
  test("defaults to BANNED when no project policy", () => {
    const bans = effectiveBans(tmp);
    expect(bans.length).toBeGreaterThan(0);
    expect(bans.some((b) => b.reason.includes("/dev/null"))).toBe(true);
  });
  test("adds extraBans and removes disabled by reason substring", () => {
    writeFileSync(
      join(tmp, ".two-sec", "policy.json"),
      JSON.stringify({
        extraBans: [
          { test: "danger", action: "cancel", reason: "dangerous thing", fix: "don't" },
        ],
        disableBans: ["/dev/null"],
      }),
    );
    const bans = effectiveBans(tmp);
    expect(bans.some((b) => b.reason.includes("dangerous"))).toBe(true);
    expect(bans.some((b) => b.reason.includes("/dev/null"))).toBe(false);
  });
  test("skips extraBans with invalid regex", () => {
    writeFileSync(
      join(tmp, ".two-sec", "policy.json"),
      JSON.stringify({
        extraBans: [{ test: "(", action: "cancel", reason: "bad", fix: "x" }],
      }),
    );
    const bans = effectiveBans(tmp);
    expect(bans.some((b) => b.reason === "bad")).toBe(false);
  });
  test("ignore file suppresses matching rules", () => {
    writeFileSync(join(tmp, ".two-sec", "ignore"), "sleep\n");
    const bans = effectiveBans(tmp);
    expect(bans.some((b) => b.reason.includes("sleep"))).toBe(false);
  });
});

describe("effectiveDeadline", () => {
  test("returns base when no policy", () => {
    expect(effectiveDeadline(tmp, 4.0)).toBe(4.0);
  });
  test("returns policy deadlineS", () => {
    writeFileSync(
      join(tmp, ".two-sec", "policy.json"),
      JSON.stringify({ deadlineS: 12 }),
    );
    expect(effectiveDeadline(tmp)).toBe(12);
  });
});

describe("logVerdict", () => {
  test("appends a verdict line to verdicts.jsonl", () => {
    logVerdict(tmp, { kind: "cancel", reason: "test", command: "x" });
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const f = join(tmp, ".two-sec", "verdicts.jsonl");
    expect(existsSync(f)).toBe(true);
    const line = readFileSync(f, "utf8").trim();
    expect(JSON.parse(line).kind).toBe("cancel");
  });
});