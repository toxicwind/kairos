/**
 * Symbol extraction — pure Bun, zero dependencies.
 *
 * TypeScript/JavaScript get a REAL AST via Bun.Transpiler.scan().
 * Python has no native parser in Bun, so it falls back to a lexical
 * extractor. That asymmetry is deliberate and documented: a dependency-free
 * AST for TS/JS beats a dependency-heavy tree-sitter for both.
 *
 * Ported from ast-bm25-racer/ast_bm25_racer.py (extract_py_symbols,
 * extract_ts_symbols) and the ast_indexer.py family.
 */

export const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
export const PY_EXTS = new Set([".py"]);

export type Extract = {
  symbols: string[];
  imports: string[];
  asyncCount: number;
};

const transpilerCache = new Map<string, Bun.Transpiler>();

function transpilerFor(loader: "ts" | "tsx" | "js" | "jsx"): Bun.Transpiler {
  const cached = transpilerCache.get(loader);
  if (cached) return cached;
  const made = new Bun.Transpiler({ loader });
  transpilerCache.set(loader, made);
  return made;
}

function loaderFor(path: string): "ts" | "tsx" | "js" | "jsx" {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".jsx")) return "jsx";
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return "ts";
  return "js";
}

/** TS/JS: real AST scan. Never throws. */
export function extractTsSymbols(path: string, source: string): Extract {
  try {
    const t = transpilerFor(loaderFor(path));
    const scanned = t.scan(source) as { exports?: string[]; imports?: { path: string }[] };
    const symbols = scanned.exports ?? [];
    const imports = (scanned.imports ?? []).map((i) => i.path);
    // async defs only surface in Python; for JS count exported async arrow fns.
    const asyncCount = (source.match(/\basync\s+(?:function|\()/g) ?? []).length;
    return { symbols, imports, asyncCount };
  } catch {
    return { symbols: [], imports: [], asyncCount: 0 };
  }
}

const PY_CLASS = /^[ \t]*class[ \t]+([A-Za-z_]\w*)/gm;
const PY_FUNC = /^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/gm;
const PY_ASSIGN = /^(?:async[ \t]+)?def[ \t]+/gm;

/** Python: lexical extractor. Never throws. */
export function extractPySymbols(source: string): Extract {
  const symbols: string[] = [];
  for (const m of source.matchAll(PY_CLASS)) symbols.push(m[1]!);
  for (const m of source.matchAll(PY_FUNC)) symbols.push(m[1]!);
  const imports: string[] = [];
  for (const m of source.matchAll(/^[ \t]*import[ \t]+([A-Za-z_][\w.]*)/gm)) imports.push(m[1]!);
  for (const m of source.matchAll(/^[ \t]*from[ \t]+([A-Za-z_][\w.]*)[ \t]+import/gm)) imports.push(m[1]!);
  const asyncCount = (source.match(PY_ASSIGN) && source.match(/^[ \t]*async[ \t]+def[ \t]+/gm)?.length) || 0;
  return { symbols: [...new Set(symbols)], imports, asyncCount };
}

export function extract(path: string, source: string): Extract {
  return PY_EXTS.has(extname(path)) ? extractPySymbols(source) : extractTsSymbols(path, source);
}

export function extname(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}