/**
 * shell-quote.live.ts — LIVE integration twin of shell-quote.test.ts.
 *
 * Coverage doctrine (AGENTS.md §1.9): the 90% gate is the LIVE tests, not the
 * unit tests. This file hits the REAL module/endpoint/binary — no mocks.
 * Run with: bun test --coverage --coverage-reporter=lcov
 * (gate: kairos scripts/coverage-gate.ts, ≥90% line + function on src/).
 *
 * TODO: fill in real live assertions against ../src/quote.ts. Each test must
 * exercise a distinct live contract (a transform, a state transition, a
 * real endpoint response, a real binary run) — never a static echo.
 */
import { describe, test, expect } from "bun:test";
import * as shell_quote from "../src/quote.ts";

describe("shell-quote (live)", () => {
  test("module loads and exposes its public surface", () => {
    const surface = Object.keys(shell_quote);
    expect(surface.length).toBeGreaterThan(0);
  });

  // TODO: replace with real live assertions. Example patterns:
  //   test("hits the live endpoint", async () => {
  //     const res = await shell_quote.someLiveFn();
  //     expect(res).toBeDefined();
  //   });
  //   test("runs the real binary", () => {
  //     const out = shell_quote.someBinaryCall();
  //     expect(out).toContain("expected");
  //   });
});
