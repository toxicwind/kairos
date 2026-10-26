/**
 * Dynamic subgraph inducer — from a traceback to the files that matter.
 *
 * Ported from emergent-mcts-graph/scripts/dynamic_subgraph_inducer.py
 * (70 lines): extract_traceback_frames(pytest_output), induce_subgraph(frames).
 *
 * The trick that made the Python version useful: parse the stack for file
 * paths AND module names, then walk the import graph from the deepest frame
 * outward. That surfaces the callers who are the actual suspect even when
 * they never appear in the traceback.
 */

import { existsSync } from "node:fs";
import { join, relative, dirname, resolve as resolvePath } from "node:path";
import { collectFiles } from "./repo-index";
import { CODE_EXTS, PY_EXTS, extract, extname } from "./extract";
import { emit } from "./concurrent";
import { readFileSync } from "node:fs";
import { isRepoRoot } from "./paths";

export type Frame = { file: string; line: number; symbol: string | null };

const TRACEBACK_FRAME = /^\s*File "([^"]+)", line (\d+), in (.+)$/;
const PY_TEST_FRAME = /^([^\s:]+\.py):(\d+):(?:\s+(\S+))?/;
const TS_FRAME = /at\s+(?:[\w.$<> ]+\s+\()?([^\s()]+):(\d+):(\d+)\)?/;

/** Pull frames out of pytest, CPython, or Node/Vitest output. */
export function extractTracebackFrames(output: string): Frame[] {
  const frames: Frame[] = [];
  for (const line of output.split("\n")) {
    let m = TRACEBACK_FRAME.exec(line);
    if (m) {
      frames.push({ file: m[1]!, line: Number(m[2]), symbol: m[3] });
      continue;
    }
    m = TS_FRAME.exec(line);
    if (m) {
      frames.push({ file: m[1]!, line: Number(m[2]), symbol: m[3] ?? null });
      continue;
    }
    m = PY_TEST_FRAME.exec(line);
    if (m) {
      frames.push({ file: m[1]!, line: Number(m[2]), symbol: m[3] ?? null });
    }
  }
  return frames;
}

export type SubgraphNode = {
  path: string;
  depth: number;
  symbols: string[];
  /** Set when the node came straight from the traceback rather than an import. */
  inTraceback: boolean;
};

export type Subgraph = {
  nodes: SubgraphNode[];
  edges: { from: string; to: string }[];
  /** How many callers each traceback file has. High fan-in = likely root cause. */
  fanIn: Map<string, number>;
};

/**
 * Induce the subgraph around the traceback frames.
 *
 * Only files reachable by import from a traceback frame, or that import a
 * traceback frame, are included — that is what keeps this from returning the
 * entire repository.
 */
export class DynamicSubgraphInducer {
  constructor(private readonly rootDir: string) {
    if (!existsSync(rootDir)) throw new Error(`root dir does not exist: ${rootDir}`);
    if (!isRepoRoot(rootDir)) emit({ event: "inducer_unusual_root", root: rootDir });
  }

  induce(frames: readonly Frame[], opts: { maxDepth?: number; maxNodes?: number } = {}): Subgraph {
    const { maxDepth = 3, maxNodes = 200 } = opts;
    const files = collectFiles(this.rootDir, { extensions: [...CODE_EXTS, ...PY_EXTS] }).files;

    const importsOf = new Map<string, Set<string>>();
    const importedBy = new Map<string, Set<string>>();
    for (const file of files) {
      const { imports } = extract(file, readText(file));
      importsOf.set(file, new Set());
      for (const spec of imports) {
        const target = resolveImport(file, spec, files);
        if (!target) continue;
        importsOf.get(file)!.add(target);
        const importers = importedBy.get(target) ?? new Set<string>();
        importers.add(file);
        importedBy.set(target, importers);
      }
    }

    const roots = frames
      .map((f) => resolveFrameFile(f.file, this.rootDir, files))
      .filter((p): p is string => p !== null);
    const tracebackSet = new Set(roots);

    const nodes = new Map<string, SubgraphNode>();
    const edges: { from: string; to: string }[] = [];
    const fanIn = new Map<string, number>();

    for (const root of roots) {
      // Downward: what the failing file pulls in.
      const down = walk(root, importsOf, maxDepth, maxNodes);
      // Upward: who calls it — these are the usual root causes.
      const up = walk(root, importedBy, maxDepth, maxNodes);
      for (const [path, depth] of [...down, ...up]) {
        const existing = nodes.get(path);
        if (existing) {
          existing.depth = Math.min(existing.depth, depth);
          continue;
        }
        nodes.set(path, { path, depth, symbols: [], inTraceback: tracebackSet.has(path) });
      }
      for (const [from, tos] of importsOf) {
        for (const to of tos) if (nodes.has(from) && nodes.has(to)) edges.push({ from, to });
      }
    }

    for (const [path, node] of nodes) {
      if (node.symbols.length) continue;
      try {
        node.symbols = extract(path, readText(path)).symbols;
      } catch {
        continue;
      }
      fanIn.set(path, importedBy.get(path)?.size ?? 0);
    }

    const ordered = [...nodes.values()].sort((a, b) => {
      if (a.inTraceback !== b.inTraceback) return a.inTraceback ? -1 : 1;
      const f = (fanIn.get(b.path) ?? 0) - (fanIn.get(a.path) ?? 0);
      return f !== 0 ? f : a.depth - b.depth;
    });

    emit({ event: "subgraph_induced", roots: roots.length, nodes: ordered.length, edges: edges.length });
    return { nodes: ordered, edges, fanIn };
  }
}

function walk(
  start: string,
  adjacency: Map<string, Set<string>>,
  maxDepth: number,
  maxNodes: number,
): Map<string, number> {
  const out = new Map<string, number>([[start, 0]]);
  let frontier = [start];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbour of adjacency.get(node) ?? []) {
        if (out.has(neighbour)) continue;
        if (out.size >= maxNodes) return out;
        out.set(neighbour, depth);
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  return out;
}

/** Turn an import specifier into a real file on disk. */
export function resolveImport(from: string, spec: string, files: readonly string[]): string | null {
  if (!spec.startsWith(".")) return null;
  const base = join(dirname(from), spec);
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.py`,
    join(base, "index.ts"), join(base, "index.tsx"), join(base, "index.js"),
  ];
  for (const candidate of candidates) {
    const normalised = resolvePath(candidate);
    if (files.includes(normalised)) return normalised;
  }
  return null;
}

function resolveFrameFile(framePath: string, rootDir: string, files: readonly string[]): string | null {
  if (existsSync(framePath) && files.includes(resolvePath(framePath))) return resolvePath(framePath);
  const joined = resolvePath(join(rootDir, framePath));
  if (files.includes(joined)) return joined;
  const tail = relative(rootDir, resolvePath(framePath));
  const bySuffix = files.find((f) => f.endsWith(tail));
  return bySuffix ?? null;
}

/** Unreadable files are simply not part of the graph. */
function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export { extname };