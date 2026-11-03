import { describe, test, expect, afterEach } from "bun:test";
import { guard, redirectTargetMissing, hugeTreeScan, verdict } from "../src/guard.ts";

afterEach(() => {
  delete process.env.KAIROS_DEBUG;
});

describe("redirect-into-nonexistent-dir guard", () => {
  test("flags > into a missing parent", () => {
    expect(redirectTargetMissing("echo hi > /tmp/kappa/kairos-t/NOPE/f.txt")).toBe("/tmp/kappa/kairos-t/NOPE/f.txt");
  });
  test("flags >> into a missing parent", () => {
    expect(redirectTargetMissing("cmd 2>> /tmp/kappa/kairos-t/NOPE2/log.txt")).toBeTruthy();
  });
  test("allows existing parent", () => {
    expect(redirectTargetMissing("echo hi > /tmp/kappa/kairos-t/ok/f.txt")).toBeNull();
  });
  test("allows when mkdir -p precedes in same chain", () => {
    expect(redirectTargetMissing("mkdir -p /tmp/kappa/kairos-t/NOPE3 && echo hi > /tmp/kappa/kairos-t/NOPE3/f.txt")).toBeNull();
  });
  test("ignores /dev/null, &1, heredocs, pipes", () => {
    expect(redirectTargetMissing("cmd >/dev/null")).toBeNull();
    expect(redirectTargetMissing("cmd 2>&1")).toBeNull();
    expect(redirectTargetMissing("cmd <<EOF")).toBeNull();
    expect(redirectTargetMissing("cmd | grep x")).toBeNull();
  });
  test("guard cancels the redirect miss", () => {
    expect(guard("echo hi > /tmp/kappa/kairos-t/NOPE/f.txt")).toBe(1);
  });
});

describe("huge-tree scan routing", () => {
  test("diff/du/find over estate or pens gets routed (rewrite, not cancel)", () => {
    expect(guard("diff -rq /home/toxic/estate /home/toxic/pens/estate")).toBe(0);
    expect(guard("du -sh /home/toxic/pens")).toBe(0);
  });
  test("small scoped finds are fine", () => {
    expect(guard("find /tmp/kappa -name '*.ts'")).toBe(0);
  });
  test("hugeTreeScan allows bounded maxdepth finds", () => {
    expect(
      hugeTreeScan("find /home/toxic/pens -maxdepth 2 -name '*.ts'"),
    ).toBeNull();
    expect(hugeTreeScan("find /home/toxic/pens -name '*.ts'")).toBe(
      "/home/toxic/pens",
    );
  });
  test("verdict routes slow ops to replace", () => {
    const v = verdict("git push origin main");
    expect(v.action).toBe("replace");
    expect(v.replacement).toContain("run-fast");
  });
  test("verdict denies missing redirect parent", () => {
    const v = verdict("echo hi > /tmp/kappa/kairos-t/NOPE/f.txt");
    expect(v.action).toBe("deny");
  });
  test("verdict allows clean and internal commands", () => {
    expect(verdict("").action).toBe("allow");
    expect(verdict("_2s_slow git push").action).toBe("allow");
    expect(verdict("git status --porcelain").action).toBe("allow");
  });
  test("guard debug path prints under KAIROS_DEBUG=1", () => {
    process.env.KAIROS_DEBUG = "1";
    const origErr = process.stderr.write;
    let captured = "";
    process.stderr.write = ((c: string) => {
      captured += String(c);
      return true;
    }) as typeof process.stderr.write;
    try {
      guard("echo hi > /tmp/kappa/kairos-t/NOPE/f.txt");
    } finally {
      process.stderr.write = origErr;
    }
    expect(captured).toContain("[kairos guard]");
  });
});
