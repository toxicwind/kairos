import { describe, test, expect, afterEach } from "bun:test";
import { scold, urgentBreach, notice, sessionLine } from "../src/notice.ts";

const origDebug = process.env.KAIROS_DEBUG;
const origStderrWrite = process.stderr.write;
let captured: string[] = [];

function captureStderr() {
  captured = [];
  process.stderr.write = ((chunk: string) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
}
function restoreStderr() {
  process.stderr.write = origStderrWrite;
}

afterEach(() => {
  if (origDebug !== undefined) process.env.KAIROS_DEBUG = origDebug;
  else delete process.env.KAIROS_DEBUG;
  restoreStderr();
});

describe("notice.ts visibility gate", () => {
  test("scold is silent by default", () => {
    delete process.env.KAIROS_DEBUG;
    captureStderr();
    scold("you broke it");
    expect(captured.join("")).toBe("");
  });

  test("scold prints under KAIROS_DEBUG=1", () => {
    process.env.KAIROS_DEBUG = "1";
    captureStderr();
    scold("you broke it");
    expect(captured.join("")).toContain("[kairos] you broke it");
  });

  test("urgentBreach is silent by default", () => {
    delete process.env.KAIROS_DEBUG;
    captureStderr();
    urgentBreach(["git", "push"], 5.5, 4.0);
    expect(captured.join("")).toBe("");
  });

  test("urgentBreach prints redacted breach under debug", () => {
    process.env.KAIROS_DEBUG = "1";
    captureStderr();
    urgentBreach(["gh", "api", "token=sk-123"], 6.0, 4.0);
    const out = captured.join("");
    expect(out).toContain("breach");
    expect(out).toContain("6.000s");
    expect(out).not.toContain("sk-123"); // secret redacted
  });

  test("notice is silent by default, prints under debug", () => {
    delete process.env.KAIROS_DEBUG;
    captureStderr();
    notice("autonomous rewrite");
    expect(captured.join("")).toBe("");

    process.env.KAIROS_DEBUG = "1";
    captureStderr();
    notice("autonomous rewrite");
    expect(captured.join("")).toContain("[kairos] autonomous rewrite");
  });

  test("sessionLine is silent by default, prints under debug", () => {
    delete process.env.KAIROS_DEBUG;
    captureStderr();
    sessionLine("session=rf-abc");
    expect(captured.join("")).toBe("");

    process.env.KAIROS_DEBUG = "1";
    captureStderr();
    sessionLine("session=rf-abc");
    expect(captured.join("")).toContain("[kairos] session=rf-abc");
  });
});