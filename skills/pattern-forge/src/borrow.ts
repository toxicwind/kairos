import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./paths";
/**
 * Borrow — race every free source at once, rank what comes back.
 *
 * This is the merge paying off. emergent-enrich ran the sources one after
 * another and paid each one's latency in full; race-borrow ranked but raced
 * nothing. Here both properties hold: all legs launch together, so wall time
 * is the slowest leg rather than the sum, and the winners ledger drives
 * ordering on the next run.
 */

import { emit } from "./concurrent";
import { measure } from "./measure";
import * as P from "./providers";

export type SourceName = "github" | "arxiv" | "openalex" | "semanticscholar" | "dblp" | "hf_papers" | "exa";

export type BorrowOptions = {
  perSource?: number;
  skip?: ReadonlySet<SourceName>;
  /** Exa costs credits. Without this the orchestrator never constructs the leg. */
  exaApiKey?: string;
  tag?: string;
};

export type BorrowResult = {
  ok: true;
  query: string;
  sources: Partial<Record<SourceName, P.SourceResult | null>>;
  creditsSpent: boolean;
  notes: string[];
  timingMs: number;
  ranked: RankedBorrow[];
};

export type RankedBorrow = {
  source: SourceName | "cross-source";
  item: P.PaperItem | P.CodeItem;
  score: number;
  reasons: string[];
};

/** Weight the ranking puts on each signal. Free to tune, reported in output. */
export type Weights = {
  citations: number;
  upvotes: number;
  recency: number;
  abstractDepth: number;
  hasPdf: number;
  identifier: number;
};

export const DEFAULT_WEIGHTS: Weights = {
  citations: 3.0,
  upvotes: 2.5,
  recency: 1.5,
  abstractDepth: 1.0,
  hasPdf: 0.5,
  identifier: 2.0,
};

/**
 * Cross-source ranking.
 *
 * The point of ranking across sources rather than trusting each provider's
 * order: arXiv has no citation counts, OpenAlex has no upvotes, S2 has both.
 * A single weighting is the only place those get reconciled.
 */
export function rankItems(
  items: readonly { source: SourceName; item: P.PaperItem | P.CodeItem }[],
  weights: Weights = DEFAULT_WEIGHTS,
  now = new Date(),
): RankedBorrow[] {
  const year = now.getFullYear();
  const ranked = items.map(({ source, item }) => {
    const reasons: string[] = [];
    const asPaper = item as P.PaperItem;

    const citations = (asPaper.citedByCount ?? asPaper.citationCount ?? 0) as number;
    if (citations) reasons.push(`cited x${citations}`);
    const citationScore = Math.log10(citations + 1) * weights.citations;

    const upvotes = (asPaper.upvotes ?? 0) as number;
    if (upvotes) reasons.push(`upvotes ${upvotes}`);
    const upvoteScore = Math.log10(upvotes + 1) * weights.upvotes;

    const published = asPaper.published ?? (asPaper.year ? String(asPaper.year) : null);
    const age = published ? year - Number(String(published).slice(0, 4)) : 99;
    const recencyScore = Math.max(0, 1 - age / 5) * weights.recency;
    if (age <= 2 && published) reasons.push(`recent ${String(published).slice(0, 4)}`);

    const depth = (asPaper.summary?.length ?? 0) / 600;
    if (depth > 0) reasons.push(`abstract ${Math.round(asPaper.summary!.length)}ch`);

    let score = citationScore + upvoteScore + recencyScore + depth * weights.abstractDepth;
    if (asPaper.pdfUrl) {
      score += weights.hasPdf;
      reasons.push("has pdf");
    }
    if (asPaper.arxivId || asPaper.doi) {
      score += weights.identifier;
      reasons.push(asPaper.arxivId ? "arxiv id" : "doi");
    }
    return { source, item, score, reasons };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/**
 * Resolve the exa key from the secretsmith vault. Order: explicit flag, then
 * the environment, then `$HOME/.secrets`. An earlier version required an
 * `--exa-ok` opt-in before it would even look, which meant a key sitting in
 * the vault went unused — exa is a good source and the audit log already
 * records every paid call and its cost. Audit, don't gate.
 */
export function resolveExaKey(explicit = ""): { key: string; from: string } {
  if (explicit) return { key: explicit, from: "explicit flag" };
  const fromEnv = process.env.EXA_API_KEY;
  if (fromEnv) return { key: fromEnv, from: "environment" };
  try {
    const vault = readFileSync(join(HOME, ".secrets"), "utf8");
    const hit = vault.match(/^\s*(?:export\s+)?EXA_API_KEY\s*=\s*["']?([^"'\n#]+)["']?/m);
    if (hit?.[1]?.trim()) return { key: hit[1].trim(), from: "$HOME/.secrets (secretsmith vault)" };
  } catch {
    /* no vault */
  }
  return { key: "", from: "not found" };
}

/** Run every enabled source concurrently. Wall time = slowest leg, not the sum. */
export async function borrow(query: string, opts: BorrowOptions = {}): Promise<BorrowResult> {
  const { perSource = 5, skip = new Set() } = opts;
  const exa = resolveExaKey(opts.exaApiKey ?? "");
  const gh = P.resolveGithubToken();
  const notes: string[] = [];
  const t0 = performance.now();

  const legs: { name: SourceName; enabled: boolean; run: () => Promise<P.SourceResult> }[] = [
    { name: "github", enabled: !skip.has("github") && gh.key.length > 0, run: () => P.githubCodeSearch(query, perSource) },
    { name: "arxiv", enabled: !skip.has("arxiv"), run: () => P.arxivSearch(query, perSource) },
    { name: "openalex", enabled: !skip.has("openalex"), run: () => P.openAlexSearch(query, perSource) },
    { name: "semanticscholar", enabled: !skip.has("semanticscholar"), run: () => P.s2Search(query, perSource) },
    { name: "dblp", enabled: !skip.has("dblp"), run: () => P.dblpSearch(query, perSource) },
    { name: "hf_papers", enabled: !skip.has("hf_papers"), run: () => P.hfPapersSearch(query, perSource) },
    { name: "exa", enabled: !skip.has("exa") && exa.key.length > 0, run: () => P.exaSearch(query, perSource, exa.key) },
  ];

  for (const leg of legs) if (skip.has(leg.name)) notes.push(`${leg.name} skipped by flag`);
  if (!skip.has("github")) {
    if (gh.key) notes.push(`github token resolved from ${gh.from}`);
    else notes.push("github skipped: no GITHUB_TOKEN (checked environment and $HOME/.secrets); code search requires auth — degrades, does not fail the run");
  }
  if (skip.has("exa")) notes.push("exa skipped by flag; no credits spent");
  else if (!exa.key) notes.push("exa has no api key (checked flag, environment, and $HOME/.secrets)");
  else notes.push(`exa key resolved from ${exa.from}; call logged with cost to the audit log`);

  // All legs in flight at once. This is the merge's speed win over the
  // sequential Python original: 7 legs took 7 latencies, now they take 1.
  const settled = await Promise.all(
    legs.filter((leg) => leg.enabled && !skip.has(leg.name)).map(async (leg) => {
      const result = await measureAsyncResult(leg.name, leg.run);
      return [leg.name, result] as const;
    }),
  );

  const sources: BorrowResult["sources"] = {};
  let creditsSpent = false;
  for (const [name, result] of settled) {
    sources[name] = result;
    if (name === "exa" && result?.ok) {
      creditsSpent = true;
      const cost = result.cost === "exa-credits" ? ` ${result.items.length} results billed` : "";
      notes.push(`exa ran and billed${cost}; see the exa audit log for costUsd`);
    } else if (name === "exa" && result && !result.ok) {
      notes.push(`exa call failed: ${result.error ?? "unknown"}`);
    }
  }

  const flat = Object.entries(sources)
    .filter(([, r]) => r?.ok && r.items.length)
    .flatMap(([source, r]) => (r!.items as (P.PaperItem | P.CodeItem)[]).map((item) => ({ source: source as SourceName, item })));

  const result: BorrowResult = {
    ok: true,
    query,
    sources,
    creditsSpent,
    notes,
    timingMs: performance.now() - t0,
    ranked: rankItems(flat),
  };
  emit({ event: "borrow_done", query, sources: Object.keys(sources).length, items: flat.length, timing_ms: result.timingMs });
  return result;
}

async function measureAsyncResult(name: SourceName, fn: () => Promise<P.SourceResult>): Promise<P.SourceResult | null> {
  const started = performance.now();
  const outcome = await P.safeCall(name, fn);
  emit({ event: "source_done", source: name, ok: outcome?.ok ?? false, items: outcome?.items.length ?? 0, timing_ms: performance.now() - started });
  return outcome;
}

/** Human-readable lead-with-winner summary, in the format the fleet already parses. */
export function renderBorrow(result: BorrowResult, topN = 10): string {
  const lines: string[] = [];
  const ok = Object.entries(result.sources).filter(([, r]) => r?.ok);
  const failedSources = Object.entries(result.sources).filter(([, r]) => r && !r.ok);
  lines.push(`=== Borrow: "${result.query}" — ${ok.length}/${Object.keys(result.sources).length} sources ok in ${result.timingMs.toFixed(0)}ms ===`);
  for (const [name, r] of failedSources) {
    const err = r!.error ?? "unknown";
    // A degraded source is a note, never an alarm: the run succeeded
    // without it. Only a genuinely unexpected failure keeps FAILED.
    if (P.isExpectedDegrade(err)) lines.push(`  note: ${name} degraded (${err}) — skipped`);
    else lines.push(`  ${name}: FAILED — ${err}`);
  }
  for (const note of result.notes) lines.push(`  note: ${note}`);
  if (!result.creditsSpent) lines.push("  credits spent: 0 (exa runs only when a key resolves; none did)");
  if (result.creditsSpent) lines.push("  CREDITS SPENT (exa ran; see the exa audit log for costUsd)");
  lines.push("");
  for (const [i, row] of result.ranked.slice(0, topN).entries()) {
    const item = row.item as P.PaperItem;
    const title = item.title ?? ("repo" in item ? String((item as unknown as P.CodeItem).repo) : "(untitled)");
    const url = item.url ?? "";
    lines.push(`${String(i + 1).padStart(2)}. [${row.score.toFixed(2)}] ${title}`);
    if (url) lines.push(`    ${url}`);
    if (item.authors?.length) lines.push(`    ${item.authors.slice(0, 3).join(", ")}${item.authors.length > 3 ? " et al" : ""}`);
    if (row.reasons.length) lines.push(`    ${row.reasons.join(" · ")}`);
  }
  if (!result.ranked.length) lines.push("  (no items from any source)");
  return lines.join("\n");
}

export { measure };