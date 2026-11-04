#!/usr/bin/env bun
/**
 * live-scaffold.ts — auto-apply the `.live.ts` twin doctrine.
 *
 * Coverage doctrine (AGENTS.md §1.9, 2026-11-04): every `.test.ts` needs a
 * `.live.ts` twin in the same test dir, and the `.live.ts` files are the real
 * 90% coverage gate (line + function, parsed from lcov) — NOT the unit tests.
 *
 * This script finds `.test.ts` files that lack a `.live.ts` twin and scaffolds
 * one: it imports the same module under test and lays down a live-test skeleton
 * (real endpoint/binary/provider call, not mocks). You then fill in the actual
 * live assertions and run it with `--coverage --coverage-reporter=lcov`.
 *
 * Usage (from a product root):
 *   bun /home/toxic/pens/ergasterion/products/kairos/scripts/live-scaffold.ts
 *   bun .../live-scaffold.ts --root /path/to/product     # scan a specific root
 *   bun .../live-scaffold.ts --dry-run                    # report only, no writes
 *   bun .../live-scaffold.ts --force                      # overwrite existing twins
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, dirname, basename, extname } from "node:path";

const ROOT = process.argv.includes("--root")
  ? process.argv[process.argv.indexOf("--root") + 1]
  : process.cwd();
const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".cache",
  "target", "vendor", "archive", "blobs", "sessions", "custom-session-files",
  ".corral", ".super-ralph", ".smithers", "bazel-out", "bazel-bin",
]);

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, acc);
    else if (e.endsWith(".test.ts")) acc.push(p);
  }
  return acc;
}

/** Resolve the module-under-test import used by a `.test.ts` (best-effort). */
function findModuleImport(testPath: string): string | null {
  const src = readFileSync(testPath, "utf8");
  // Prefer non-relative-package imports that point at the product's own src.
  const rel = /from\s+["'](\.[^"']+)["']/.exec(src);
  if (rel) return rel[1];
  // Fallback: any import that is not a bare package name.
  const any = /from\s+["']([^"']+)["']/.exec(src);
  return any ? any[1] : null;
}

function twinFor(testPath: string): string {
  const base = basename(testPath, ".test.ts");
  return join(dirname(testPath), `${base}.live.ts`);
}

function scaffold(testPath: string): string {
  const mod = findModuleImport(testPath);
  const base = basename(testPath, ".test.ts");
  const relMod = mod ?? `./${base}`;
  const modName = base.replace(/[^A-Za-z0-9_$]/g, "_") || "mod";
  return `/**
 * ${base}.live.ts — LIVE integration twin of ${basename(testPath)}.
 *
 * Coverage doctrine (AGENTS.md §1.9): the 90% gate is the LIVE tests, not the
 * unit tests. This file hits the REAL module/endpoint/binary — no mocks.
 * Run with: bun test --coverage --coverage-reporter=lcov
 * (gate: kairos scripts/coverage-gate.ts, ≥90% line + function on src/).
 *
 * TODO: fill in real live assertions against ${relMod}. Each test must
 * exercise a distinct live contract (a transform, a state transition, a
 * real endpoint response, a real binary run) — never a static echo.
 */
import { describe, test, expect } from "bun:test";
import * as ${modName} from "${relMod}";

describe("${base} (live)", () => {
  test("module loads and exposes its public surface", () => {
    const surface = Object.keys(${modName});
    expect(surface.length).toBeGreaterThan(0);
  });

  // TODO: replace with real live assertions. Example patterns:
  //   test("hits the live endpoint", async () => {
  //     const res = await ${modName}.someLiveFn();
  //     expect(res).toBeDefined();
  //   });
  //   test("runs the real binary", () => {
  //     const out = ${modName}.someBinaryCall();
  //     expect(out).toContain("expected");
  //   });
});
`;
}

const tests = walk(ROOT);
const created: string[] = [];
const missing: string[] = [];
const skipped: string[] = [];

for (const t of tests) {
  const twin = twinFor(t);
  if (exists(twin) && !FORCE) {
    skipped.push(twin);
    continue;
  }
  missing.push(t);
  const body = scaffold(t);
  if (!DRY_RUN) {
    mkdirSync(dirname(twin), { recursive: true });
    writeFileSync(twin, body);
  }
  created.push(twin);
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

console.log(`\n[live-scaffold] root=${ROOT}`);
console.log(`  .test.ts found:      ${tests.length}`);
console.log(`  twins created:       ${created.length}${DRY_RUN ? " (dry-run, not written)" : ""}`);
console.log(`  twins already exist: ${skipped.length}${FORCE ? " (--force, overwritten)" : ""}`);
if (missing.length) {
  console.log("\n  created twins:");
  for (const m of created) console.log(`    + ${relative(ROOT, m)}`);
  console.log("\n  next: fill in live assertions, then run the coverage gate:");
  console.log("    bun test --coverage --coverage-reporter=lcov");
  console.log("    bun scripts/coverage-gate.ts   # ≥90% line + func on src/");
}