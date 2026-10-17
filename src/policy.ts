/**
 * policy.ts — the two-sec command policy: what is slow, what is banned.
 *
 * Single source of truth for both the runner routing and the guard.
 */

/** Subcommands that routinely exceed 2s → route through the deadline runner. */
export const SLOW_ROUTES: Record<string, Set<string>> = {
  git: new Set(["push", "pull", "fetch", "clone", "merge", "rebase", "submodule", "gc", "filter-repo"]),
  bun: new Set(["install", "add", "remove", "update", "test", "build", "typecheck", "publish", "link", "run"]),
  npm: new Set(["install", "ci", "update", "build", "test", "typecheck", "publish"]),
  tsgo: new Set(["noEmit", "check", "typecheck"]),
  turbo: new Set(["typecheck", "build", "test", "run"]),
  tsc: new Set(["noEmit", "build"]),
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

/**
 * Per-command deadline overrides (seconds). Slow-but-bounded tools that walk a
 * large tree legitimately need more than the 2s default; declare them here so
 * BOTH the runner (which enforces) and the guard (which routes/advises) read
 * one table. This is the first-class way to widen a window — never an abort.
 */
export const DEADLINE_BUMPS: Record<string, number> = {
  glob: 10,
  find: 10,
  "ffs_glob": 10,
  "ffs_find": 10,
  "ffs_index": 10,
  typecheck: 180,
  tsgo: 180,
  turbo: 180,
  tsc: 180,
  status: 20, // git status (incl --ignored) walks huge trees on the estate
};

/** Resolve the effective subcommand, skipping git-style flags and their values (`-C path`, `--help`). */
function effectiveSub(args: string[]): string {
  let i = 1;
  while (i < args.length) {
    const a = args[i];
    if (a === "-C" || a === "--git-dir" || a === "--work-tree") { i += 2; continue; } // flag + value
    if (a && a.startsWith("-")) { i += 1; continue; } // other flag
    return a;
  }
  return "";
}

/** Resolve the effective deadline for `args`, honoring per-command bumps. */
export function deadlineFor(args: string[], baseS = 2.0): number {
  const bin = String(args[0] ?? "");
  const sub = effectiveSub(args);
  if (bin === "ffs" || bin.endsWith("/ffs")) {
    // catch the tree-walking reader subcommands and auto-widen their window
    if (sub === "glob" || sub === "find" || sub === "index") return 10;
    return DEADLINE_BUMPS[`ffs_${sub}`] ?? baseS;
  }
  // `bun typecheck` / `npm typecheck` / `tsgo --noEmit` / `git status`: widen by subcommand too.
  if (bin === "git" && sub === "status") return DEADLINE_BUMPS.status;
  if (sub === "typecheck" || sub === "noEmit" || sub === "check" || sub === "build") {
    return DEADLINE_BUMPS[sub] ?? DEADLINE_BUMPS[bin] ?? baseS;
  }
  return DEADLINE_BUMPS[bin] ?? baseS;
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
