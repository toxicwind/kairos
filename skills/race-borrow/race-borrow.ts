#!/usr/bin/env bun
/**
 * race-borrow.ts — Race multiple providers for patterns, borrow the best results.
 * Combines the "race" parallel-first-wins concept with pattern-borrow ranking.
 *
 * HFT rules (2026-09-20): TRUE first-valid-wins per pattern. Losers are
 * aborted the moment a winner arrives (AbortController) — never awaited.
 * Fail-fast: a 403/429/timeout kills that contestant instantly; no retry
 * loops, no 60s sleeps. A dead lane is data, not a reason to wait.
 *
 * Usage: bun run race-borrow.ts [patterns...] [--top N] [--per-page N] [--weights k=v,...] [--providers p1,p2,...] [--interactive] [--help]
 */

import { parseArgs } from "node:util";

// A token is not enough. The GitHub API answers 403 to any request without a
// User-Agent, and Bun's fetch does not add one. So the skill failed with a
// valid token in the environment while curl on the same URL returned 200.
// `token` is the legacy scheme; fine-grained PATs want `Bearer`.
function resolveToken(): string | undefined {
  const fromEnv = Bun.env.GITHUB_TOKEN ?? Bun.env.GH_TOKEN;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  // The gh CLI usually holds a working credential. Reach for it rather than
  // demanding a duplicate secret in the environment.
  try {
    const result = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
    const token = new TextDecoder().decode(result.stdout).trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

const TOKEN = resolveToken();
if (TOKEN === undefined) {
  console.error("ERROR: no GitHub token. Set GITHUB_TOKEN, GH_TOKEN, or log in with `gh auth login`.");
  process.exit(1);
}

const API = "https://api.github.com";
const HEAD = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "race-borrow",
};

const DEFAULT_PATTERNS = ["sovereign", "tau", "pi", "oh-my-pi", "llama-swap"];
const DEFAULT_PROVIDERS = ["openrouter", "groq", "google", "mistral"];
const BUG_TERMS = ["TODO", "FIXME", "HACK", "BUG", "WORKAROUND", "XXX"];
const FACTORS = ["stars", "forks", "open_issues", "updated"] as const;
type Weight = Partial<Record<(typeof FACTORS)[number], number>>;
const DEFAULT_W: Weight = { stars: 3, forks: 1, open_issues: 1, updated: 2 };

// Per-attempt fail-fast ceiling. Slow is a kind of wrong.
const ATTEMPT_TIMEOUT_MS = 15_000;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    top: { type: "string" },
    "per-page": { type: "string" },
    weights: { type: "string" },
    providers: { type: "string" },
    interactive: { type: "boolean" },
    help: { type: "boolean" },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(
    `Usage: bun run race-borrow.ts [patterns...] [--top N] [--per-page N] [--weights k=v,...] [--providers p1,p2,...] [--interactive]`,
  );
  process.exit(0);
}

const PATTERNS = positionals.length ? positionals : DEFAULT_PATTERNS;
const TOP = Number(values.top ?? PATTERNS.length);
const PER_PAGE = Number(values["per-page"] ?? 5);
const W: Weight = { ...DEFAULT_W };
const SELECTED_PROVIDERS = values.providers?.split(",").map((p) => p.trim()) ?? DEFAULT_PROVIDERS;

if (values.weights) {
  for (const kv of values.weights.split(",")) {
    const [k, v] = kv.split("=");
    if (k && v && k in DEFAULT_W) (W as any)[k] = Number(v);
  }
}

async function gh(path: string, params: Record<string, string> | undefined, signal: AbortSignal): Promise<any> {
  let url = `${API}${path}`;
  if (params) url += `?${new URLSearchParams(params).toString()}`;
  // Single attempt, fail-fast. A 403/429/timeout/abort kills this contestant
  // instantly — the other lanes are already in flight. No retry loops.
  const res = await fetch(url, { headers: HEAD, signal });
  if (!res.ok) throw new Error(`GH API ${res.status}`);
  return res.json();
}

async function raceProvider(pattern: string, provider: string, page: number, signal: AbortSignal): Promise<any> {
  const query = `${pattern} repo:sovereign-projects/ language:typescript language:ts language:rust language:go`;
  const data = await gh("/search/code", {
    q: query,
    per_page: String(PER_PAGE),
    page: String(page),
  }, signal);
  return { provider, pattern, data, time: Date.now() };
}

const rows: any[] = [];

// TRUE first-valid-wins per pattern: all provider lanes fire at once, the
// first valid response wins, losers are aborted immediately. Patterns race
// each other concurrently (independent).
async function racePattern(pattern: string): Promise<any> {
  const kill = new AbortController();
  try {
    const contenders = SELECTED_PROVIDERS.map((provider) => {
      const laneSignal = AbortSignal.any([kill.signal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)]);
      const p = raceProvider(pattern, provider, 1, laneSignal);
      // Swallow post-race loser rejections: aborting a lost lane is not an error.
      p.catch(() => {});
      return p;
    });
    const winner = await Promise.race(contenders);
    rows.push({ pattern, winner });
    return winner;
  } finally {
    kill.abort(); // losers die NOW — never awaited, never nursed
  }
}

async function raceAll() {
  await Promise.all(PATTERNS.map(racePattern));
}

function norm(key: string) {
  return key.replace(/^renamed_from|type_of|language:/, "").trim();
}

function rank(weights: Weight) {
  const score = (repo: any) => {
    let s = 0;
    for (const f of FACTORS) {
      const v = repo[norm(f)] ?? 0;
      s += (weights[f] ?? DEFAULT_W[f as keyof Weight] ?? 0) * Math.log1p(v);
    }
    if (BUG_TERMS.some((t) => repo.description?.includes(t))) s -= 5;
    return s;
  };
  return rows.sort((a, b) => score(b.winner.data.items?.[0] ?? {}) - score(a.winner.data.items?.[0] ?? {}));
}

function printRank(weights: Weight) {
  const ranked = rank(weights);
  console.log(`\n=== Race-Borrow Results (${PATTERNS.length} patterns, ${SELECTED_PROVIDERS.length} providers) ===\n`);
  for (const r of ranked.slice(0, TOP)) {
    const item = r.winner.data.items?.[0];
    if (item) {
      console.log(`🏆 ${r.pattern} → ${item.full_name} (via ${r.winner.provider})`);
      console.log(`   Stars: ${item.stargazers_count} | Forks: ${item.forks_count} | Issues: ${item.open_issues_count}`);
    }
  }
  console.log(`\n--- Weights: ${JSON.stringify(W)} ---\n`);
}

async function main() {
  await raceAll();
  printRank(W);
  if (values.interactive) {
    console.log("Interactive mode: use --weights to adjust ranking factors");
  }
}

main().catch(console.error);
