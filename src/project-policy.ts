/**
 * project-policy.ts — per-project policy layer (ToolGuardian-inspired:
 * declarative policy-as-data, not hardcoded patterns).
 *
 * Files (walked up from cwd, estate-style):
 *   .two-sec/policy.json — { deadlineS?, extraBans?: [{test,action,reason,fix}],
 *                            disableBans?: [reason substrings] }
 *   .two-sec/ignore      — one comment-ish line per allowed pattern (FP-Predictor:
 *                          lines matching an ignore entry NEVER fire)
 *   .two-sec/verdicts.jsonl — append-only behavioral log (Defense-as-Skill:
 *                          the guard's own evolution record)
 */
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { BANNED, type BanRule } from "./policy.ts";

export interface ProjectPolicy {
  deadlineS?: number;
  extraBans?: { test: string; action: "cancel" | "rewrite"; reason: string; fix: string }[];
  disableBans?: string[];
  ignore?: string[];
}

function findUp(start: string, name: string): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = join(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function loadProjectPolicy(cwd: string): ProjectPolicy {
  const f = findUp(cwd, join(".two-sec", "policy.json"));
  if (!f) return {};
  try {
    return JSON.parse(readFileSync(f, "utf8")) as ProjectPolicy;
  } catch {
    return {};
  }
}

export function loadIgnore(cwd: string): RegExp[] {
  const f = findUp(cwd, join(".two-sec", "ignore"));
  if (!f) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      try { return new RegExp(l); } catch { return new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); }
    });
}

/** Effective ban set: defaults + project extras − disabled − ignored. */
export function effectiveBans(cwd: string): BanRule[] {
  const policy = loadProjectPolicy(cwd);
  const ignore = loadIgnore(cwd);
  const rules: BanRule[] = [...BANNED];
  for (const extra of policy.extraBans ?? []) {
    try { rules.push({ ...extra, test: new RegExp(extra.test, "i") }); } catch { /* bad regex in policy: skip */ }
  }
  const disabled = policy.disableBans ?? [];
  return rules.filter(
    (r) =>
      !disabled.some((d) => r.reason.includes(d)) &&
      !ignore.some((re) => re.test(r.reason)),
  );
}

export function effectiveDeadline(cwd: string, base = 2.0): number {
  return loadProjectPolicy(cwd).deadlineS ?? base;
}

/** Append a behavioral verdict (Defense-as-Skill evolution record). */
export function logVerdict(cwd: string, entry: Record<string, unknown>): void {
  const dir = findUp(cwd, ".two-sec") ?? join(cwd, ".two-sec");
  try {
    appendFileSync(join(dir, "verdicts.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* read-only tree: skip */ }
}
