/**
 * Free-first literature and code search, ported to Bun.
 *
 * Source of truth: emergent-enrich/bin/route.py (1014 lines), recovered from
 * __pycache__ because the .py itself had been deleted.
 *
 * Two rules are inherited deliberately and must not be "simplified":
 *
 *   1. EXA COSTS CREDITS and is audited, not gated: the orchestrator resolves
 *      the key (explicit flag -> EXA_API_KEY env -> $HOME/.secrets) and runs
 *      the leg when one resolves. Every paid call is logged with its costUsd.
 *      Crippling a good source to avoid an observable bill is the wrong trade.
 *   2. Every leg is free and keyless except GitHub, so one dead source is
 *      never fatal. `safeCall` is what makes that true; the orchestrator in
 *      borrow.ts races all of them at once.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emit } from "./concurrent";

export const ARXIV_BASE = "https://export.arxiv.org";
export const OPENALEX_BASE = "https://api.openalex.org";
export const S2_BASE = "https://api.semanticscholar.org";
export const DBLP_BASE = "https://dblp.org/search/publ/api";
export const HF_PAPERS_BASE = "https://huggingface.co/api/papers/search";
export const EXA_BASE = "https://api.exa.ai/search";
export const USER_AGENT = "pattern-forge/1.0";
/** Polite pool: better latency, no key. */
export const POLITE_MAILTO = "pattern-forge@localhost";

export const SHINGLE_CACHE = join(homedir(), ".cache", "pattern-forge");

/** Light per-host client throttle, persisted across invocations. */
export function throttle(key: string, minIntervalMs = 1000): void {
  const stateFile = join(SHINGLE_CACHE, `lit_${key}.json`);
  let last = 0;
  try {
    last = (JSON.parse(readFileSync(stateFile, "utf8")) as { last?: number }).last ?? 0;
  } catch {
    last = 0;
  }
  const wait = minIntervalMs - (Date.now() / 1000 - last);
  if (wait > 0) Bun.sleep(wait);
  try {
    mkdirSync(SHINGLE_CACHE, { recursive: true });
    const tmp = `${stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ last: Date.now() / 1000 }), "utf8");
    renameSync(tmp, stateFile);
  } catch {
    /* the throttle is politeness, not correctness */
  }
}

export type PaperItem = {
  title: string | null;
  authors?: string[];
  year?: number | string | null;
  published?: string | null;
  venue?: string | null;
  citationCount?: number | null;
  citedByCount?: number | null;
  upvotes?: number | null;
  arxivId?: string | null;
  doi?: string | null;
  url?: string | null;
  pdfUrl?: string | null;
  summary?: string;
  openAlexId?: string | null;
};

export type CodeItem = {
  name: string | null;
  path: string | null;
  repo: string | null;
  html_url: string | null;
  score: number | null;
};

export type SourceResult = {
  ok: boolean;
  items: (PaperItem | CodeItem)[];
  cost: "free" | "exa-credits";
  ranking?: string;
  note?: string;
  timingMs?: number;
  totalCount?: number | null;
  retries?: number;
  error?: string;
};

const failed = (error: unknown): SourceResult => ({
  ok: false,
  items: [],
  cost: "free",
  error: String((error as Error)?.message ?? error).slice(0, 160),
});

async function fetchJson(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ data: unknown; ms: number }> {
  const t0 = performance.now();
  const { timeoutMs = 15_000, ...rest } = init;
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return { data: await res.json(), ms: performance.now() - t0 };
}

/**
 * Resolve the GitHub token. Order: the environment, then `$HOME/.secrets`
 * (secretsmith vault). GitHub's code-search endpoint requires authentication;
 * without a token the call 401s, so callers skip the leg instead of trying.
 */
export function resolveGithubToken(): { key: string; from: string } {
  const fromEnv = process.env.GITHUB_TOKEN;
  if (fromEnv?.trim()) return { key: fromEnv.trim(), from: "environment" };
  try {
    const vault = readFileSync(join(homedir(), ".secrets"), "utf8");
    const hit = vault.match(/^\s*(?:export\s+)?GITHUB_TOKEN\s*=\s*["']?([^"'\n#]+)["']?/m);
    if (hit?.[1]?.trim()) return { key: hit[1].trim(), from: "$HOME/.secrets (secretsmith vault)" };
  } catch {
    /* no vault */
  }
  return { key: "", from: "not found" };
}

/**
 * GitHub code search. No `sort` param on purpose: GitHub then returns
 * best-match relevance order, not star order.
 *
 * Authentication is mandatory for this endpoint — unauthenticated calls get
 * HTTP 401. The token resolves from the environment or the secretsmith
 * vault; when none resolves the leg reports a clear error instead of
 * attempting the call, and the borrow orchestrator skips it outright.
 */
export async function githubCodeSearch(query: string, perPage = 5): Promise<SourceResult> {
  const token = resolveGithubToken();
  if (!token.key) {
    return {
      ok: false, items: [], cost: "free",
      error: "no GITHUB_TOKEN (checked environment and $HOME/.secrets); GitHub code search requires authentication",
    };
  }
  const url = `https://api.github.com/search/code?${new URLSearchParams({ q: query, per_page: String(perPage) })}`;
  const { data, ms } = await fetchJson(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token.key}`,
    },
    timeoutMs: 25_000,
  });
  const body = data as { total_count?: number; items?: Record<string, unknown>[] };
  const items: CodeItem[] = (body.items ?? []).map((it) => ({
    name: (it.name as string) ?? null,
    path: (it.path as string) ?? null,
    repo: ((it.repository as { full_name?: string })?.full_name ?? null) as string | null,
    html_url: (it.html_url as string) ?? null,
    score: (it.score as number) ?? null,
  }));
  return { ok: true, items, cost: "free", totalCount: body.total_count ?? null, timingMs: ms, ranking: "best-match relevance (not stars)" };
}

/** arXiv Atom, parsed without an XML dependency. Entries only — that is all we use. */
function parseAtom(xml: string): PaperItem[] {
  const entries = xml.split("<entry>").slice(1);
  const tag = (entry: string, name: string): string => {
    const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry);
    return m ? decodeEntities(m[1]!.replace(/\s+/g, " ").trim()) : "";
  };
  return entries.map((entry) => ({
    title: tag(entry, "title"),
    authors: [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g)].map((m) => decodeEntities(m[1]!.trim())),
    published: tag(entry, "published").slice(0, 10),
    url: tag(entry, "id") || null,
    summary: tag(entry, "summary").slice(0, 500),
  }));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

/**
 * arXiv: free, no auth, relevance-sorted. Throttles aggressively, so the
 * interval is enforced across invocations and 429/503 back off honouring
 * Retry-After. Every attempt lands in a JSONL timing audit.
 */
export async function arxivSearch(query: string, maxResults: number, opts: { timeoutMs?: number; maxRetries?: number } = {}): Promise<SourceResult> {
  const { timeoutMs = 12_000, maxRetries = 3 } = opts;
  const url = `${ARXIV_BASE}/api/query?${new URLSearchParams({
    search_query: `all:${query}`, start: "0", max_results: String(maxResults), sortBy: "relevance", sortOrder: "descending",
  })}`;
  throttle("arxiv", 3500);

  let lastError = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const t0 = performance.now();
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status === 503) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "0");
        auditArxiv({ t_ms: performance.now() - t0, attempt, ok: false, status: res.status, query });
        Bun.sleep(retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000);
        lastError = `HTTP ${res.status}`;
        continue;
      }
      if (!res.ok) {
        auditArxiv({ t_ms: performance.now() - t0, attempt, ok: false, status: res.status, query });
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const xml = await res.text();
      const ms = performance.now() - t0;
      auditArxiv({ t_ms: ms, attempt, ok: true, status: 200, query });
      return { ok: true, items: parseAtom(xml), cost: "free", ranking: "relevance", timingMs: ms, retries: attempt };
    } catch (e) {
      lastError = String((e as Error).message);
      auditArxiv({ t_ms: performance.now() - t0, attempt, ok: false, status: 0, query, error: lastError });
    }
  }
  return { ok: false, items: [], cost: "free", error: lastError || "arxiv exhausted retries" };
}

type ArxivAudit = { t_ms: number; attempt: number; ok: boolean; status: number; query: string; error?: string };

/** Timing audit — shared budget visibility across every skill that hits arXiv. */
export function auditArxiv(record: ArxivAudit): void {
  try {
    mkdirSync(SHINGLE_CACHE, { recursive: true });
    appendFileSync(join(SHINGLE_CACHE, "arxiv_audit.jsonl"), `${JSON.stringify({ ts: Date.now() / 1000, ...record })}\n`, "utf8");
  } catch {
    /* audit is best-effort */
  }
}

/** Reconstruct abstract text from OpenAlex's inverted index. */
export function abstractFromInvertedIndex(inv: Record<string, number[]> | null | undefined): string {
  if (!inv) return "";
  const positions: [number, string][] = [];
  for (const [word, idxs] of Object.entries(inv)) for (const i of idxs) positions.push([i, word]);
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map(([, w]) => w).join(" ").slice(0, 600);
}

/** Surface a real arXiv id so dedupe across legs works instead of title-matching. */
function arxivIdFrom(ids: Record<string, string> | null | undefined): string | null {
  const m = /arxiv\.org\/(?:abs|pdf)\/([^\s"'<>]+)/.exec(ids?.arxiv ?? "");
  return m ? m[1]! : null;
}

const OA_SELECT = "id,doi,ids,title,publication_year,authorships,abstract_inverted_index,cited_by_count,primary_location";

type OaWork = {
  id?: string; doi?: string | null; ids?: Record<string, string>; title?: string | null;
  publication_year?: number | null; authorships?: { author?: { display_name?: string } }[];
  abstract_inverted_index?: Record<string, number[]> | null; cited_by_count?: number | null;
  primary_location?: { source?: { display_name?: string } | null } | null;
};

export function openAlexWorkToItem(w: OaWork): PaperItem {
  const doi = w.doi ?? null;
  return {
    title: w.title ?? null,
    authors: (w.authorships ?? []).slice(0, 6).map((a) => a.author?.display_name ?? "").filter(Boolean),
    year: w.publication_year ?? null,
    citedByCount: w.cited_by_count ?? null,
    venue: w.primary_location?.source?.display_name ?? null,
    arxivId: arxivIdFrom(w.ids),
    doi: (doi ?? "").replace("https://doi.org/", "") || null,
    url: doi ?? w.id ?? null,
    openAlexId: w.id ?? null,
    summary: abstractFromInvertedIndex(w.abstract_inverted_index),
  };
}

/** OpenAlex: 250M+ works incl. arXiv content. The unblinded fallback when arXiv throttles. */
export async function openAlexSearch(query: string, maxResults: number): Promise<SourceResult> {
  throttle("openalex", 1000);
  const url = `${OPENALEX_BASE}/works?${new URLSearchParams({
    search: query, "per-page": String(Math.max(1, Math.min(25, maxResults))), mailto: POLITE_MAILTO, select: OA_SELECT,
  })}`;
  const { data, ms } = await fetchJson(url, { headers: { "User-Agent": USER_AGENT } });
  const body = data as { results?: OaWork[] };
  return { ok: true, items: (body.results ?? []).map(openAlexWorkToItem), cost: "free", ranking: "relevance", timingMs: ms, note: "covers arXiv + journals + preprints" };
}

/** Exact DOI lookup, not a search — the right call for --id mode. */
export async function openAlexLookupDoi(doi: string): Promise<SourceResult> {
  throttle("openalex", 1000);
  const bare = doi.trim().replace(/^doi:/i, "");
  const url = `${OPENALEX_BASE}/works/doi:${encodeURIComponent(bare)}?${new URLSearchParams({ mailto: POLITE_MAILTO, select: OA_SELECT })}`;
  try {
    const { data, ms } = await fetchJson(url, { headers: { "User-Agent": USER_AGENT }, timeoutMs: 10_000 });
    const work = data as OaWork;
    if (!work.id) return { ok: false, items: [], cost: "free", error: "not found" };
    return { ok: true, items: [openAlexWorkToItem(work)], cost: "free", timingMs: ms, note: "exact DOI lookup" };
  } catch (e) {
    return failed(e);
  }
}

type S2Paper = {
  title?: string | null; abstract?: string | null; authors?: { name?: string }[]; year?: number | null;
  url?: string | null; openAccessPdf?: { url?: string } | null; citationCount?: number | null;
  externalIds?: Record<string, string>;
};

function s2ToItem(p: S2Paper): PaperItem {
  return {
    title: p.title ?? null,
    authors: (p.authors ?? []).slice(0, 6).map((a) => a.name ?? ""),
    year: p.year ?? null,
    citationCount: p.citationCount ?? null,
    arxivId: p.externalIds?.ArXiv ?? null,
    doi: p.externalIds?.DOI ?? null,
    url: p.url ?? null,
    pdfUrl: p.openAccessPdf?.url ?? null,
    summary: (p.abstract ?? "").slice(0, 600),
  };
}

/** Semantic Scholar: 200M+ papers, free anonymous tier, strictly more signal than arXiv. */
export async function s2Search(query: string, maxResults: number): Promise<SourceResult> {
  throttle("semanticscholar", 1000);
  const url = `${S2_BASE}/graph/v1/paper/search?${new URLSearchParams({
    query, limit: String(Math.max(1, Math.min(25, maxResults))),
    fields: "title,abstract,authors,year,url,openAccessPdf,citationCount,externalIds",
  })}`;
  const { data, ms } = await fetchJson(url, { headers: { "User-Agent": USER_AGENT } });
  const body = data as { data?: S2Paper[] };
  return { ok: true, items: (body.data ?? []).map(s2ToItem), cost: "free", ranking: "relevance", timingMs: ms };
}

/** DBLP: CS-only, no abstracts, CC0 metadata. Best for venue-aware CS work. */
export async function dblpSearch(query: string, maxResults: number): Promise<SourceResult> {
  throttle("dblp", 1000);
  const url = `${DBLP_BASE}?${new URLSearchParams({ q: query, format: "json", h: String(Math.max(1, Math.min(30, maxResults))), c: "0" })}`;
  const { data, ms } = await fetchJson(url, { headers: { "User-Agent": USER_AGENT } });
  const body = data as { result?: { hits?: { hit?: { info?: Record<string, unknown> }[] } } };
  const hits = body.result?.hits?.hit ?? [];
  const items = hits.map((h): PaperItem => {
    const info = h.info ?? {};
    const raw = (info.authors as { author?: unknown })?.author ?? [];
    const list = Array.isArray(raw) ? raw : [raw];
    return {
      title: (info.title as string) ?? null,
      authors: list.filter((a): a is { text?: string } => typeof a === "object" && a !== null).slice(0, 6).map((a) => a.text ?? ""),
      venue: (info.venue as string) ?? null,
      year: (info.year as string) ?? null,
      url: (info.url as string) ?? null,
    };
  });
  return { ok: true, items, cost: "free", ranking: "relevance", timingMs: ms, note: "CS-only, no abstracts, CC0" };
}

/** HF Papers: hybrid semantic + keyword over arXiv-indexed AI/ML, no token needed. */
export async function hfPapersSearch(query: string, maxResults: number): Promise<SourceResult> {
  throttle("hf_papers", 1000);
  const url = `${HF_PAPERS_BASE}?${new URLSearchParams({ q: query })}`;
  const { data, ms } = await fetchJson(url, { headers: { "User-Agent": USER_AGENT } });
  const raw = Array.isArray(data) ? data : ((data as { papers?: unknown[]; results?: unknown[] }).papers ?? (data as { results?: unknown[] }).results ?? []);
  const items = (raw as Record<string, unknown>[])
    .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
    .slice(0, maxResults)
    .map((p): PaperItem => ({
      title: (p.title as string) ?? null,
      authors: ((p.authors as unknown[]) ?? []).slice(0, 6).map((a) => (typeof a === "object" && a !== null ? ((a as { name?: string }).name ?? "") : String(a))),
      published: (p.publishedAt as string) ?? (p.published_at as string) ?? null,
      arxivId: (p.id as string) ?? null,
      url: p.id ? `https://huggingface.co/papers/${String(p.id)}` : null,
      summary: ((p.summary as string) ?? (p.abstract as string) ?? "").slice(0, 600),
      upvotes: (p.upvotes as number) ?? null,
    }));
  return { ok: true, items, cost: "free", ranking: "relevance", timingMs: ms, note: "HF paper search, AI/ML focused" };
}

/**
 * Exa. COSTS CREDITS.
 *
 * The orchestrator constructs this leg only when a key resolved (explicit
 * flag, environment, or the secretsmith vault) and the caller did not skip
 * it. Usage is logged locally because Exa exposes no usage endpoint.
 */
export async function exaSearch(query: string, numResults: number, apiKey: string): Promise<SourceResult> {
  const t0 = performance.now();
  try {
    const res = await fetch(EXA_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT, "x-api-key": apiKey },
      body: JSON.stringify({ query, type: "auto", numResults }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = (await res.json()) as { results?: { title?: string; url?: string; publishedDate?: string; score?: number }[]; costDollars?: { total?: number } };
    logExaCall({ ok: true, ms: performance.now() - t0, query, resultsReturned: data.results?.length ?? 0, costUsd: data.costDollars?.total ?? null });
    return {
      ok: true,
      cost: "exa-credits",
      timingMs: performance.now() - t0,
      items: (data.results ?? []).map((r) => ({ title: r.title ?? null, url: r.url ?? null, publishedDate: r.publishedDate ?? null, score: r.score ?? null })),
    };
  } catch (e) {
    logExaCall({ ok: false, ms: performance.now() - t0, query, error: String((e as Error).message) });
    throw e;
  }
}

export type ExaCall = { ok: boolean; ms: number; query: string; resultsReturned?: number; costUsd?: number | null; error?: string };

export function logExaCall(call: ExaCall): void {
  try {
    mkdirSync(SHINGLE_CACHE, { recursive: true });
    appendFileSync(join(SHINGLE_CACHE, "exa_audit.jsonl"), `${JSON.stringify({ ts: Date.now() / 1000, ...call })}\n`, "utf8");
  } catch {
    /* audit is best-effort */
  }
}

/** Failures that are the network's normal weather, not bugs: rate limits,
 * bot-check walls serving HTML to a JSON parser, DNS/connection/timeout
 * errors. These degrade a source quietly instead of presenting as an error —
 * one dead route never fails the run and never looks like it did. */
const EXPECTED_DEGRADE_PATTERNS = [
  /HTTP 429/, // rate limited — try again later
  /Unrecognized token '<'/, // bot wall served HTML to a JSON parser
  /bot[-\s]?check/i,
  /captcha/i,
  /cloudflare/i,
  /ENOTFOUND/,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /EAI_AGAIN/,
  /socket hang up/i,
  /fetch failed/i,
];

export function isExpectedDegrade(error: string): boolean {
  return EXPECTED_DEGRADE_PATTERNS.some((re) => re.test(error));
}

/** A source that fails must never kill the run — this is what guarantees that.
 *
 * Every per-route failure emits `source_degraded`, never `source_failed`:
 * a single route's failure is degradation, not an error. The `expected`
 * flag preserves the diagnostic classification (transient/bot-wall vs
 * unexpected provider bug) without surfacing an error. A true error is
 * reserved for whole-run failure.
 */
export async function safeCall(name: string, fn: () => Promise<SourceResult>): Promise<SourceResult | null> {
  try {
    const result = await fn();
    if (!result.ok) {
      emit({ event: "source_degraded", source: name, error: result.error,
             expected: isExpectedDegrade(result.error ?? "") });
    }
    return result;
  } catch (e) {
    const message = String((e as Error).message);
    emit({ event: "source_degraded", source: name, error: message,
           expected: isExpectedDegrade(message) });
    return { ok: false, items: [], cost: "free", error: message.slice(0, 160) };
  }
}

/** Extractive TL;DR: first-sentence + keyword-density compression. Never invents. */
export function tldrExtractive(abstract: string, title: string | null = null, maxChars = 320): string {
  if (!abstract.trim()) return title ?? "";
  const sentences = abstract.match(/[^.!?]+[.!?]*/g) ?? [abstract];
  const words = new Set((title ?? "").toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  let best = sentences[0] ?? "";
  let bestScore = -1;
  for (const sentence of sentences.slice(0, 6)) {
    const score = sentence.split(/\W+/).filter((w) => words.has(w.toLowerCase())).length;
    if (score > bestScore) {
      bestScore = score;
      best = sentence;
    }
  }
  const text = best.trim().replace(/\s+/g, " ");
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
