/**
 * coverage-gate.ts — REAL coverage enforcement. Bun's `[coverage]` thresholds in
 * bunfig.toml are decorative (it reports but never fails). This script runs the
 * suite with lcov output, filters to kairos's OWN src/, computes line + function
 * coverage, and exits non-zero if either is below the 90% target. A threshold
 * that silently passes is meaningless — this is the gate.
 *
 * Usage: bun scripts/coverage-gate.ts  (from the kairos product root)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const TARGET_LINES = 90;
const TARGET_FUNCS = 90;
const COVERAGE_DIR = join(process.cwd(), "coverage");
const LCOV = join(COVERAGE_DIR, "lcov.info");

// Run the suite with lcov output. Bun only auto-discovers `.test.ts`/`.spec.ts`;
// the `.live.ts` twins (the real 90% gate, AGENTS.md §1.9) are passed explicitly
// so they participate in the coverage measurement.
function findLiveFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (["node_modules", ".git", "dist", "build", "coverage", "target", "vendor"].includes(e)) continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) findLiveFiles(p, acc);
    else if (e.endsWith(".live.ts")) acc.push(p);
  }
  return acc;
}
const liveFiles = findLiveFiles(process.cwd());
const args = ["test", "--coverage", "--coverage-reporter=lcov", ...liveFiles];
const run = spawnSync("bun", args, {
  stdio: ["inherit", "inherit", "inherit"],
});
if (run.status !== 0) {
  console.error(`\n[kairos coverage] test suite FAILED (exit ${run.status})`);
  process.exit(run.status ?? 1);
}

if (!existsSync(LCOV)) {
  console.error(`[kairos coverage] no ${LCOV} produced — cannot gate`);
  process.exit(1);
}

// Parse lcov: accumulate lines/functions per SF (source file) record.
interface FileCov {
  lf: number; // lines found
  lh: number; // lines hit
  fnf: number; // functions found
  fnh: number; // functions hit
}
const files = new Map<string, FileCov>();
let cur: string | null = null;
for (const line of readFileSync(LCOV, "utf8").split("\n")) {
  if (line.startsWith("SF:")) {
    cur = line.slice(3).trim();
    files.set(cur, { lf: 0, lh: 0, fnf: 0, fnh: 0 });
  } else if (line.startsWith("LF:")) {
    if (cur) files.get(cur)!.lf = Number(line.slice(3));
  } else if (line.startsWith("LH:")) {
    if (cur) files.get(cur)!.lh = Number(line.slice(3));
  } else if (line.startsWith("FNF:")) {
    if (cur) files.get(cur)!.fnf = Number(line.slice(4));
  } else if (line.startsWith("FNH:")) {
    if (cur) files.get(cur)!.fnh = Number(line.slice(4));
  }
}

// Filter to kairos's OWN src/ — the repo also holds skills/pattern-forge (a
// vendored sibling) that would otherwise dilute the gate. lcov emits relative
// paths (`src/runner.ts`) or absolute (`/…/kairos/src/runner.ts`); match both.
const isKairosSrc = (p: string) =>
  p.startsWith("src/") || p.includes("/kairos/src/");
const src = [...files.entries()].filter(([p]) => isKairosSrc(p));
const tot = src.reduce(
  (a, [, c]) => ({
    lf: a.lf + c.lf,
    lh: a.lh + c.lh,
    fnf: a.fnf + c.fnf,
    fnh: a.fnh + c.fnh,
  }),
  { lf: 0, lh: 0, fnf: 0, fnh: 0 },
);
const linePct = tot.lf ? (tot.lh / tot.lf) * 100 : 100;
const funcPct = tot.fnf ? (tot.fnh / tot.fnf) * 100 : 100;

console.log(
  `\n[kairos coverage] src/ lines ${linePct.toFixed(1)}% (${tot.lh}/${tot.lf})  funcs ${funcPct.toFixed(1)}% (${tot.fnh}/${tot.fnf})  target ${TARGET_LINES}%/${TARGET_FUNCS}%`,
);

let fail = false;
if (linePct < TARGET_LINES) {
  console.error(
    `  FAIL: line coverage ${linePct.toFixed(1)}% < ${TARGET_LINES}%`,
  );
  fail = true;
}
if (funcPct < TARGET_FUNCS) {
  console.error(
    `  FAIL: function coverage ${funcPct.toFixed(1)}% < ${TARGET_FUNCS}%`,
  );
  fail = true;
}

if (fail) {
  console.error(
    `[kairos coverage] gate NOT met — add tests before this passes.`,
  );
  process.exit(1);
}
console.log(`[kairos coverage] gate met ✓`);
process.exit(0);