import { describe, test, expect } from "bun:test";
import {
  rewriteBanned,
  bannedAsFirst,
  isStrict,
  why,
  replacementFor,
} from "../src/rewrite.ts";

describe("rewriteBanned", () => {
  test("cat <file> → ffs read <file>", () => {
    expect(rewriteBanned(["cat", "package.json"])).toEqual([
      "ffs",
      "read",
      "package.json",
    ]);
  });
  test("less/more <file> → ffs read <file>", () => {
    expect(rewriteBanned(["less", "src/policy.ts"])).toEqual([
      "ffs",
      "read",
      "src/policy.ts",
    ]);
    expect(rewriteBanned(["more", "README.md"])).toEqual([
      "ffs",
      "read",
      "README.md",
    ]);
  });
  test("cat with flags or no file → null (no safe rewrite)", () => {
    expect(rewriteBanned(["cat", "-n", "file"])).toBeNull();
    expect(rewriteBanned(["cat"])).toBeNull();
  });
  test("head/tail are NOT rewritten (fully invisible, run real binary)", () => {
    expect(rewriteBanned(["head", "data.txt"])).toBeNull();
    expect(rewriteBanned(["tail", "-n", "20", "log.txt"])).toBeNull();
    expect(rewriteBanned(["head", "-c", "100", "file"])).toBeNull();
    expect(rewriteBanned(["tail", "-f", "log"])).toBeNull();
  });
  test("find bare needle → ffs find", () => {
    expect(rewriteBanned(["find", "src"])).toEqual(["ffs", "find", "src"]);
    expect(rewriteBanned(["find", "src", "tests"])).toEqual([
      "ffs",
      "find",
      "src",
      "tests",
    ]);
  });
  test("find with flags → null (flags would break rewrite)", () => {
    expect(rewriteBanned(["find", "-name", "*.ts"])).toBeNull();
    expect(rewriteBanned(["find", ".", "-maxdepth", "2"])).toBeNull();
  });
  test("glob <pattern> → ffs glob", () => {
    expect(rewriteBanned(["glob", "*.ts"])).toEqual(["ffs", "glob", "*.ts"]);
  });
  test("grep/rg <pattern> → argos-grep (architect order 2026-11-06)", () => {
    expect(rewriteBanned(["grep", "foo"])).toEqual(["argos-grep", "foo"]);
    expect(rewriteBanned(["rg", "bar", "src"])).toEqual([
      "argos-grep",
      "bar",
      "--corpus",
      "src",
    ]);
  });
  test("grep with leading flag → null", () => {
    expect(rewriteBanned(["grep", "-r", "foo"])).toBeNull();
  });
  test("unknown base → null", () => {
    expect(rewriteBanned(["echo", "hi"])).toBeNull();
    expect(rewriteBanned(["ls", "-la"])).toBeNull();
  });
});

describe("bannedAsFirst", () => {
  test("contains the slow/wrong-lane tools", () => {
    for (const b of [
      "find",
      "cat",
      "grep",
      "rg",
      "sed",
      "awk",
      "cut",
      "sort",
      "uniq",
      "less",
      "more",
      "xxd",
      "hexdump",
      "od",
      "base64",
      "tee",
      "tr",
      "paste",
      "join",
      "glob",
    ]) {
      expect(bannedAsFirst.has(b), `${b} banned`).toBe(true);
    }
  });
  test("does not contain display tools", () => {
    // kairos is mostly invisible: head/tail/wc are NOT banned (display windows).
    expect(bannedAsFirst.has("head")).toBe(false);
    expect(bannedAsFirst.has("tail")).toBe(false);
    expect(bannedAsFirst.has("wc")).toBe(false);
  });
});

describe("isStrict", () => {
  test("defaults to false (autonomy)", () => {
    const prev = process.env.KAIROS_STRICT;
    delete process.env.KAIROS_STRICT;
    expect(isStrict()).toBe(false);
    if (prev !== undefined) process.env.KAIROS_STRICT = prev;
  });
  test("true when KAIROS_STRICT=1", () => {
    const prev = process.env.KAIROS_STRICT;
    process.env.KAIROS_STRICT = "1";
    expect(isStrict()).toBe(true);
    if (prev !== undefined) process.env.KAIROS_STRICT = prev;
    else delete process.env.KAIROS_STRICT;
  });
});

describe("why / replacementFor", () => {
  test("returns a reason for known tools", () => {
    expect(why("cat")).toContain("read tool");
    expect(why("find")).toContain("ffs");
  });
  test("returns a fallback for unknown", () => {
    expect(why("nope")).toContain("slower/wrong");
  });
  test("replacementFor returns the generic ffs fallback for unknown", () => {
    expect(replacementFor("unknown")).toBe("ffs / ast-grep / the read tool");
  });
  test("replacementFor returns a suggestion", () => {
    expect(replacementFor("cat")).toContain("read");
    expect(replacementFor("unknown")).toContain("ffs");
  });
});