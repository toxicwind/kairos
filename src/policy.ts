/**
 * policy.ts — the two-sec command policy: what is slow, what is banned.
 *
 * Single source of truth for both the runner routing and the guard.
 */

/** Subcommands that routinely exceed 2s → route through the deadline runner. */
export const SLOW_ROUTES: Record<string, Set<string>> = {
  git: new Set(["push", "pull", "fetch", "clone", "merge", "rebase", "submodule", "gc", "filter-repo"]),
  bun: new Set(["install", "add", "remove", "update", "test", "build", "publish", "link", "run"]),
  npm: new Set(["install", "ci", "update", "build", "test", "publish"]),
  pnpm: new Set(["add", "install", "update"]),
  pip: new Set(["install"]),
  pip3: new Set(["install"]),
  uv: new Set(["sync", "add", "lock"]),
  gh: new Set(["repo", "pr", "release", "api"]),
  gitleaks: new Set(["git", "detect"]),
  "codebase-memory": new Set(["index_repository", "get_file_outline", "semantic_search"]),
  cargo: new Set(["build", "test", "check"]),
  go: new Set(["build", "test", "vet"]),
  ffs: new Set(["index", "map"]),
  make: new Set([]), // bare make is slow by default
};

export function isSlow(bin: string, sub: string): boolean {
  const subs = SLOW_ROUTES[bin];
  if (!subs) return false;
  if (bin === "make") return true;
  return subs.has(sub);
}

/** Truncation / swallow patterns — BANNED. Guard cancels with an urgent fix. */
export interface BanRule {
  test: RegExp;
  action: "cancel" | "rewrite";
  reason: string;
  fix: string;
}

export const BANNED: BanRule[] = [
  { test: /(^|[\s;])\d?&?>\s*\/dev\/null|2>\s*\/dev\/null|1>\s*\/dev\/null/, action: "rewrite", reason: "output discarded to /dev/null", fix: "run without the redirect — agents MUST see full output" },
  { test: /\|\s*true(\s|$)/, action: "cancel", reason: "'| true' swallows the exit code", fix: "handle the failure explicitly" },
  { test: /2>&\s*1/, action: "rewrite", reason: "'2>&1' merges stderr into stdout", fix: "drop the merge — keep streams separate" },
  { test: /\|\s*head(\s|$)|\|\s*tail(\s|$)|\|\s*wc\s+-l/, action: "rewrite", reason: "pipeline truncation (head/tail/wc)", fix: "persist FULL output; read via ffs" },
  { test: /(^|\s)sleep\s+\d+/, action: "cancel", reason: "blocking sleep", fix: "readiness-check or background it — never sleep to wait" },
  { test: /\[:\s*-?\d+\s*\]\s*$|\bhead\s+-c\s|\btail\s+-c\s/, reason: "byte/slice truncation in output", fix: "persist full output; slice only in code, never in transcripts" },
];

/** Returns the first matching ban rule, or null. */
export function firstBan(commandLine: string): BanRule | null {
  for (const rule of BANNED) if (rule.test.test(commandLine)) return rule;
  return null;
}
