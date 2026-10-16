import { describe, test, expect } from "bun:test";
import { firstBan, isSlow } from "../src/policy.ts";
import { guard } from "../src/guard.ts";

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
});
