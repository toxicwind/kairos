import { describe, test, expect } from "bun:test";
import { guard, redirectTargetMissing } from "../src/guard.ts";

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
});
