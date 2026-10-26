/**
 * BM25 over an inverted index, plus the hybrid reweighting that makes this
 * retrieval useful on symbol-heavy code.
 *
 * Ported from ast-bm25-racer/ast_bm25_racer.py (RepoIndex.bm25,
 * RepoIndex.hybrid_search).
 *
 * SPEED IS THE DOCTRINE. The Python original scored every document for every
 * query term: O(n·terms) with a Python dict lookup per term. Here the
 * postings are plain arrays of doc indices and frequencies, so scoring
 * touches only documents that actually contain the term.
 *
 * Three defects in the original are fixed:
 *   1. Tokens shorter than 2 chars were indexed and matched, so the query
 *      token "a" scored against nearly every symbol. Short tokens are dropped.
 *   2. `mod_to_files` was built and never read — dead code, removed.
 *   3. Centrality joined import specifiers ("./gitignore-sync", "fs") against
 *      file stems, so it was almost always 0 and occasionally a false
 *      positive. Imports are normalised to their final segment here.
 */

export type TokenCounter = Map<string, number>;

export function countTerms(terms: readonly string[]): TokenCounter {
  const tf: TokenCounter = new Map();
  for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

const WORD = /[A-Za-z_][A-Za-z0-9_]*/g;
const CAMEL_SPLIT = /_|(?<=[a-z0-9])(?=[A-Z])/;
const HAS_CAMEL = /_|(?<=[a-z0-9])(?=[A-Z])/;

/**
 * Split camelCase and snake_case into sub-tokens; drop 1-char noise.
 * The regexes are non-global on purpose: a `g` flag makes `.test()` stateful
 * via lastIndex, which silently corrupts tokenization across calls.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    const lower = word.toLowerCase();
    if (lower.length >= 2) out.push(lower);
    if (!HAS_CAMEL.test(word)) continue;
    for (const part of word.split(CAMEL_SPLIT)) {
      const sub = part.toLowerCase();
      if (sub.length >= 2 && sub !== lower) out.push(sub);
    }
  }
  return out;
}

/** "./gitignore-sync" -> "gitignore-sync"; "@scope/pkg/x" -> "x". */
export function normalizeImport(spec: string): string {
  const tail = spec.split("/").filter(Boolean).pop();
  return (tail ?? spec).replace(/\.[cm]?[jt]sx?$/, "").toLowerCase();
}

export type Ranked = {
  path: string;
  hybrid: number;
  bm25: number;
  symbols: string[];
  asyncCount: number;
  centrality: number;
};

type Posting = { docIdx: number[]; freq: number[] };

export class Bm25Index {
  private paths: string[] = [];
  private docLen: number[] = [];
  private docAsync: number[] = [];
  private docCent: number[] = [];
  private symbols: string[][] = [];
  private stems: string[] = [];
  private postings = new Map<string, Posting>();
  private totalLen = 0;
  private incoming = new Map<string, number>();
  private n = 0;
  private avgdl = 0;

  get size(): number {
    return this.n;
  }

  /** Record import edges so centrality has something to join against. */
  noteImport(spec: string): void {
    const key = normalizeImport(spec);
    this.incoming.set(key, (this.incoming.get(key) ?? 0) + 1);
  }

  add(path: string, tf: TokenCounter, symbolList: readonly string[], asyncCount: number): void {
    const idx = this.n++;
    this.paths.push(path);
    this.stems.push(normalizeImport(path.replace(/\.[^.]+$/, "")));
    this.symbols.push([...symbolList]);
    let len = 0;
    for (const [t, f] of tf) {
      len += f;
      const p = this.postings.get(t);
      if (p) {
        p.docIdx.push(idx);
        p.freq.push(f);
      } else {
        this.postings.set(t, { docIdx: [idx], freq: [f] });
      }
    }
    this.docLen[idx] = len;
    this.docAsync[idx] = asyncCount;
    this.totalLen += len;
  }

  /**
   * Resolve centrality once at build time. The original recomputed this per
   * query per document with a string comparison.
   */
  seal(): void {
    this.avgdl = this.n ? this.totalLen / this.n : 0;
    for (let i = 0; i < this.n; i++) {
      const own = this.incoming.get(this.stems[i]!) ?? 0;
      const viaSymbol = this.symbols[i]!.reduce(
        (best, s) => Math.max(best, this.incoming.get(normalizeImport(s)) ?? 0),
        0,
      );
      this.docCent[i] = Math.max(own, viaSymbol);
    }
  }

  /**
   * BM25 over the postings. Only documents containing a query term are
   * touched, so cost tracks the posting lists, not the corpus size.
   */
  bm25(queryTerms: readonly string[], k1 = 1.2, b = 0.75): Map<number, number> {
    const scores = new Map<number, number>();
    if (!this.n) return scores;
    const k1b = k1 * (1 - b);
    for (const t of new Set(queryTerms)) {
      const posting = this.postings.get(t);
      if (!posting) continue;
      const { docIdx, freq } = posting;
      const df = docIdx.length;
      if (!df) continue;
      const idf = Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
      for (let i = 0; i < df; i++) {
        const d = docIdx[i]!;
        const f = freq[i]!;
        const norm = k1b + b * (this.docLen[d]! / (this.avgdl || 1));
        scores.set(d, (scores.get(d) ?? 0) + (idf * f * (k1 + 1)) / norm);
      }
    }
    return scores;
  }

  hybrid(
    query: string,
    topK = 10,
    opts: { alpha?: number; beta?: number; gamma?: number; eps?: number } = {},
  ): Ranked[] {
    // Centrality is resolved at seal time. Forgetting to seal silently yielded
    // undefined weights instead of an error, so the index seals itself whenever
    // the corpus has grown since the last seal.
    if (this.docCent.length !== this.n) this.seal();
    const { alpha = 0.6, beta = 0.4, gamma = 0.15, eps = 1e-6 } = opts;
    const qTerms = tokenize(query);
    const qSet = new Set(qTerms);
    const base = this.bm25(qTerms);
    const wantsAsync = qSet.has("async") || qSet.has("coroutine") || qSet.has("await");

    let maxCent = 0;
    for (const i of base.keys()) maxCent = Math.max(maxCent, this.docCent[i] ?? 0);
    if (maxCent < 1) maxCent = 1;

    const ranked: Ranked[] = [];
    for (const [i, bm25] of base) {
      const symbols = this.symbols[i]!;
      let symMatch = 0;
      for (const s of symbols) {
        const lower = s.toLowerCase();
        if (qSet.has(lower)) symMatch++;
        else {
          for (const q of qSet) {
            if (q.length >= 3 && lower.includes(q)) {
              symMatch++;
              break;
            }
          }
        }
      }
      const symNorm = symMatch / 5;
      const asyncNorm = wantsAsync ? Math.min(this.docAsync[i]! / 3, 1) : 0;
      const centNorm = this.docCent[i]! / maxCent;
      ranked.push({
        path: this.paths[i]!,
        hybrid: (bm25 + eps) * (1 + alpha * symNorm + beta * asyncNorm + gamma * centNorm),
        bm25,
        symbols: symbols.length > 12 ? symbols.slice(0, 12) : symbols,
        asyncCount: this.docAsync[i]!,
        centrality: this.docCent[i]!,
      });
    }

    ranked.sort((a, b) => b.hybrid - a.hybrid || b.bm25 - a.bm25);
    return ranked.length > topK ? ranked.slice(0, topK) : ranked;
  }
}