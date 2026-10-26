/**
 * Repository indexing — the crawl that makes retrieval usable at estate scale.
 *
 * The Python original walked with `Path.rglob("*.ts")` and then filtered out
 * `node_modules`, `.git`, `.venv`, `dist`, `build`. That filter ran AFTER
 * traversal, so it saved tokenization but not I/O: pointing the racer at the
 * estate root spent 65 seconds crawling 400GB of build artifacts before I
 * killed it. Here the directory names are pruned at the directory level, so a
 * pruned subtree is never entered and its inodes are never stat'd.
 *
 * Truncation is never silent. If maxFiles is hit, the build reports it.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Bm25Index, countTerms, normalizeImport, tokenize } from "./bm25";
import { CODE_EXTS, PY_EXTS, extract } from "./extract";

export const SKIP_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build",
  "target", ".next", ".turbo", ".cache", "vendor", ".jj", ".pytest_cache",
  "coverage", "out", ".output", ".svelte-kit", "bower_components", "site-packages",
]);

/** Directories that are legitimately indexed but expensive; prune by default. */
export const HEAVY_DIRS = new Set(["rancher-desktop", "snap", "go", "rustlib", ".rustup", ".cargo"]);

export type BuildStats = {
  root: string;
  files: number;
  dirsWalked: number;
  dirsPruned: number;
  bytes: number;
  truncated: boolean;
  ms: number;
};

export type ScanOptions = {
  maxFiles?: number;
  includeHeavy?: boolean;
  followHidden?: boolean;
  extensions?: readonly string[];
};

function isHidden(name: string): boolean {
  return name.startsWith(".") && name !== ".";
}

export function collectFiles(root: string, opts: ScanOptions = {}): { files: string[]; stats: Omit<BuildStats, "files" | "bytes" | "ms"> } {
  const { maxFiles = 60000, includeHeavy = false } = opts;
  const files: string[] = [];
  let dirsWalked = 0;
  let dirsPruned = 0;
  const stack: string[] = [root];

  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    dirsWalked++;
    for (const entry of entries) {
      const name = entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) {
          dirsPruned++;
          continue;
        }
        if (!includeHeavy && HEAVY_DIRS.has(name)) {
          dirsPruned++;
          continue;
        }
        if (isHidden(name)) continue;
        stack.push(join(dir, name));
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (CODE_EXTS.has(extOf(name)) || PY_EXTS.has(extOf(name))) files.push(join(dir, name));
      }
    }
  }
  files.sort();
  return { files: files.slice(0, maxFiles), stats: { root, dirsWalked, dirsPruned, truncated: files.length > maxFiles } };
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/**
 * Build the index. Files are read concurrently; Bun's I/O is the bottleneck
 * at estate scale, so reads are issued in waves rather than awaited one by one.
 */
export async function buildIndex(root: string, opts: ScanOptions = {}): Promise<{ index: Bm25Index; stats: BuildStats }> {
  const started = performance.now();
  const { files, stats } = collectFiles(root, opts);
  const index = new Bm25Index();
  const CONCURRENCY = 256;
  let bytes = 0;

  for (let wave = 0; wave < files.length; wave += CONCURRENCY) {
    const slice = files.slice(wave, wave + CONCURRENCY);
    const sources = await Promise.all(
      slice.map(async (file) => {
        try {
          const text = await Bun.file(file).text();
          bytes += text.length;
          return { file, text };
        } catch {
          return null;
        }
      }),
    );
    for (const got of sources) {
      if (!got) continue;
      const { symbols, imports, asyncCount } = extract(got.file, got.text);
      for (const spec of imports) index.noteImport(spec);
      // Tokens come from the path and the symbol names: the two things a
      // developer actually searches by. Tokenizing whole file bodies made the
      // index several times larger for no ranking gain.
      const terms = tokenize(`${relative(root, got.file)} ${symbols.join(" ")}`);
      index.add(got.file, countTerms(terms), symbols, asyncCount);
    }
  }

  index.seal();
  return {
    index,
    stats: { ...stats, root, files: files.length, bytes, ms: Math.round(performance.now() - started) },
  };
}

export function rankOne(index: Bm25Index, query: string, topK = 10): ReturnType<Bm25Index["hybrid"]> {
  return index.hybrid(query, topK);
}

export function isRepoRoot(path: string): boolean {
  try {
    return statSync(join(path, ".git")).isDirectory() || statSync(join(path, ".git")).isFile();
  } catch {
    return false;
  }
}

export { normalizeImport };