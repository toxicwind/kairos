import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_DIR,
  sessionDir,
  writeMeta,
  readMeta,
  getSessions,
  deleteSession,
  genId,
  outPath,
} from "../src/session.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kairos-session-test-"));
  process.env.KAIROS_SESSION_DIR = tmp;
});

afterEach(() => {
  delete process.env.KAIROS_SESSION_DIR;
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

describe("session store", () => {
  test("writeMeta + readMeta round-trip", () => {
    const id = genId("test");
    const meta = {
      id,
      cmd: "echo hi",
      startTime: 1000,
      endTime: 2000,
      exitCode: 0,
      state: "done" as const,
    };
    writeMeta(id, meta);
    expect(readMeta(id)).toEqual(meta);
    expect(existsSync(join(tmp, `${id}.json`))).toBe(true);
    expect(existsSync(outPath(id))).toBe(false); // out file not created by meta
    // getSessions lists it
    const sessions = getSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe(id);
    // deleteSession removes it
    deleteSession(id);
    expect(readMeta(id)).toBeNull();
    expect(existsSync(join(tmp, `${id}.json`))).toBe(false);
  });

  test("getSessions skips corrupt meta files", () => {
    writeMeta("good", {
      id: "good",
      cmd: "x",
      startTime: 1,
      endTime: 2,
      exitCode: 0,
      state: "done",
    });
    // Corrupt: id mismatch
    writeFileSync(join(tmp, "bad.json"), '{"id":"other","cmd":"x"}');
    // Corrupt: invalid JSON
    writeFileSync(join(tmp, "broken.json"), "{not json");
    // Empty file
    writeFileSync(join(tmp, "empty.json"), "");
    const sessions = getSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe("good");
  });

  test("genId with name prefixes rf-", () => {
    expect(genId("deploy")).toBe("rf-deploy");
    expect(genId()).toMatch(/^rf-[0-9a-f]{8}$/);
  });

  test("getSessions sorts by startTime", () => {
    writeMeta("a", {
      id: "a",
      cmd: "first",
      startTime: 100,
      endTime: 200,
      exitCode: 0,
      state: "done",
    });
    writeMeta("b", {
      id: "b",
      cmd: "second",
      startTime: 50,
      endTime: 150,
      exitCode: 1,
      state: "done",
    });
    const sessions = getSessions();
    expect(sessions[0].id).toBe("b");
    expect(sessions[1].id).toBe("a");
  });

  test("readMeta tolerates missing file", () => {
    expect(readMeta("does-not-exist")).toBeNull();
  });

  test("sessionDir honors KAIROS_SESSION_DIR override", () => {
    expect(sessionDir()).toBe(tmp);
  });
});