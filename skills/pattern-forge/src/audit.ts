/**
 * audit — verify claims about code against the AST, via ast-grep.
 *
 * A claim like "sovereign router listens on port 25104" or "function X calls Y"
 * is routed to structural queries. The verdict is VERIFIED only when an AST
 * node is quoted: file, line range, matched text, captured meta-variables.
 * Zero hits => NOT-FOUND (never "refuted" from a miss). A malformed or
 * unroutable claim => INCONCLUSIVE with guidance.
 *
 * Binary resolution: $AST_GREP_BIN, then well-known install locations
 * ($HOME/.local/bin, yote's mise shims), then `ast-grep` on PATH. Never `sg`
 * (on Linux that's util-linux setgroups; ast-grep deprecates the alias).
 */

export type Verdict = "VERIFIED" | "NOT-FOUND" | "INCONCLUSIVE";

export interface Evidence {
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  text: string;
  language: string;
  meta: Record<string, string>;
}

export interface AuditQuery {
  label: string;
  pattern?: string;
  rule?: string;
  lang: string;
  globs: string[];
  hits: number;
  note?: string;
}

export interface AuditResult {
  claim: string;
  claimType: string;
  verdict: Verdict;
  confidence: "high" | "medium" | "low";
  queries: AuditQuery[];
  evidence: Evidence[];
  notes: string[];
}

interface SgMatch {
  file: string;
  range: { start: { line: number; column: number }; end: { line: number; column: number } };
  text: string;
  lines: string;
  language: string;
  metaVariables?: { single?: Record<string, { text: string }> };
}

let cachedBin: string | null | undefined;

/**
 * Resolve the ast-grep binary. Order: $AST_GREP_BIN, then well-known install
 * locations ($HOME/.local/bin on the cell, the mise shims dir on yote),
 * then `ast-grep` on PATH. Probed with an executable check, never assumed.
 * Never `sg` (on Linux that's util-linux setgroups; ast-grep deprecates it).
 */
export function resolveAstGrep(): string | null {
  if (cachedBin !== undefined) return cachedBin;
  const env = process.env["AST_GREP_BIN"];
  const candidates = [
    ...(env ? [env] : []),
    join(homedir(), ".local", "bin", "ast-grep"),
    join(homedir(), ".local", "share", "mise", "shims", "ast-grep"),
  ];
  for (const c of candidates) {
    if (isExecutable(c)) {
      cachedBin = c;
      return cachedBin;
    }
  }
  const probe = Bun.spawnSync(["sh", "-c", "command -v ast-grep"], { stdout: "pipe" });
  cachedBin = probe.exitCode === 0 ? new TextDecoder().decode(probe.stdout).trim() : null;
  return cachedBin;
}

function runSg(bin: string, args: string[], cwd: string): SgMatch[] {
  const proc = Bun.spawnSync([bin, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = new TextDecoder().decode(proc.stdout).trim();
  // ast-grep exits 1 with valid `[]` on zero matches — that is a result, not
  // an error. Only treat non-JSON stdout as a failure.
  if (out) {
    try {
      return JSON.parse(out) as SgMatch[];
    } catch {
      /* fall through to the error below */
    }
  }
  const err = new TextDecoder().decode(proc.stderr).trim();
  throw new Error(err.split("\n")[0] || `ast-grep exit ${proc.exitCode} (no JSON stdout)`);
}

function toEvidence(m: SgMatch): Evidence {
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.metaVariables?.single ?? {})) meta[k] = v.text;
  return {
    file: m.file,
    line: m.range.start.line,
    col: m.range.start.column,
    endLine: m.range.end.line,
    endCol: m.range.end.column,
    text: (m.lines || m.text).trim().slice(0, 300),
    language: m.language,
    meta,
  };
}

interface BuiltQuery {
  label: string;
  pattern?: string;
  rule?: string;
  lang: string;
}

/** Claim router: natural-language claim -> structural queries. */
function routeClaim(claim: string): { type: string; queries: BuiltQuery[]; check: (ev: Evidence[]) => { verdict: Verdict; confidence: AuditResult["confidence"]; notes: string[] } } | null {
  // --- "X listens on / serves port N" ---
  const portRe = /(?:port\s+(\d+))[^.]{0,50}?\b(serves?|listens?(?:\s+on)?|hosts?|runs?)\b\s+([A-Za-z0-9_.\-/]+)|([A-Za-z0-9_.\-/]+)[^.]{0,50}?\b(listens?\s+on|serves?|runs?\s+on|hosts?)\b[^.]{0,20}?port\s+(\d+)/i;
  const pm = claim.match(portRe);
  if (pm) {
    const port = pm[1] ?? pm[6];
    const name = (pm[3] ?? pm[4] ?? "").toLowerCase();
    const queries: BuiltQuery[] = [
      { label: "ts listen", pattern: "$APP.listen($PORT, $$$)", lang: "ts" },
      { label: "ts listen (tsx)", pattern: "$APP.listen($PORT, $$$)", lang: "tsx" },
      { label: "bun serve", pattern: "Bun.serve({ $$$ })", lang: "ts" },
      { label: "py listen", pattern: "$APP.listen($PORT)", lang: "py" },
      { label: "py uvicorn", pattern: "uvicorn.run($$$, port=$PORT, $$$)", lang: "py" },
      { label: "go http", pattern: "http.ListenAndServe($ADDR, $$$)", lang: "go" },
      { label: "go net listen", pattern: "net.Listen($$$, $ADDR)", lang: "go" },
      { label: "rs axum bind", pattern: "axum::Server::bind($ADDR)", lang: "rs" },
      { label: "rs tcp bind", pattern: "TcpListener::bind($ADDR)", lang: "rs" },
    ];
    return {
      type: `port-bind (port ${port}${name ? `, service "${name}"` : ""})`,
      queries,
      check: (ev) => {
        const hits = ev.filter((e) => {
          const vals = Object.values(e.meta).join(" ");
          return new RegExp(`\\b${port}\\b`).test(vals) || new RegExp(`\\b${port}\\b`).test(e.text);
        });
        if (hits.length) {
          return {
            verdict: "VERIFIED",
            confidence: hits.some((h) => new RegExp(`\\b${port}\\b`).test(Object.values(h.meta).join(" "))) ? "high" : "medium",
            notes: [`port literal ${port} captured in bind call${name ? ` (claim names "${name}" — confirm the file/service matches)` : ""}`],
          };
        }
        return { verdict: "NOT-FOUND", confidence: "medium", notes: [`no bind site captures port ${port}; the port may live in config (use rg) or env`] };
      },
    };
  }

  // --- "X calls Y" ---
  const callsRe = /\b([A-Za-z_]\w*)\s+calls?\s+([A-Za-z_]\w*)\b/i;
  const cm = claim.match(callsRe);
  if (cm) {
    const [, x, y] = cm;
    return {
      type: `call-edge (${x} -> ${y})`,
      queries: [{ label: `call sites of ${y} (filtered to ${x}'s body)`, pattern: `${y}($$$)`, lang: "ts", }],
      check: () => ({ verdict: "INCONCLUSIVE", confidence: "low", notes: ["call-edge needs the two-pass path — handled by auditCallEdge()"] }),
    };
  }

  // --- "A imports B" ---
  // Specifier matching is substring-based: ast-grep string literals match
  // exactly, so we capture the specifier as $SPEC/$MOD and filter in check().
  const impRe = /\b([A-Za-z0-9_@.\-/]+)\s+imports?\s+([A-Za-z0-9_@.\-/]+)\b/i;
  const im = claim.match(impRe);
  if (im) {
    const [, , b] = im;
    const queries: BuiltQuery[] = [
      // NOTE: $SPEC must be quoted in the pattern — unquoted, ast-grep binds
      // it to the import clause instead of the module specifier (verified).
      { label: "es named import", pattern: `import { $$$ } from "$SPEC"`, lang: "ts" },
      { label: "es default import", pattern: `import $DEF from "$SPEC"`, lang: "ts" },
      { label: "es namespace import", pattern: `import * as $NS from "$SPEC"`, lang: "ts" },
      { label: "es side-effect import", pattern: `import "$SPEC"`, lang: "ts" },
      { label: "py from-import", pattern: `from $MOD import $$$`, lang: "py" },
      { label: "py import", pattern: `import $MOD`, lang: "py" },
      { label: "require", pattern: `require("$SPEC")`, lang: "ts" },
      { label: "go import", pattern: `import ( $$$ $SPEC $$$ )`, lang: "go" },
    ];
    return {
      type: `import-edge (-> ${b})`,
      queries,
      check: (ev) => {
        const hits = ev.filter((e) => {
          const spec = (e.meta["SPEC"] ?? e.meta["MOD"] ?? "").replace(/['"]/g, "");
          return spec.includes(b);
        });
        return hits.length
          ? { verdict: "VERIFIED", confidence: "high", notes: [`${hits.length} structural import hit(s); specifier contains "${b}"`] }
          : { verdict: "NOT-FOUND", confidence: "medium", notes: [`no import specifier containing "${b}" found`] };
      },
    };
  }

  // --- "function|class|method X ..." (symbol definition) ---
  const defRe = /\b(function|class|method|struct|interface)\s+([A-Za-z_]\w*)/i;
  const dm = claim.match(defRe);
  if (dm) {
    const [, kind, name] = dm;
    const k = kind.toLowerCase();
    const patterns: Record<string, BuiltQuery[]> = {
      function: [
        { label: "ts function", pattern: `function ${name}($$$)`, lang: "ts" },
        { label: "py def", pattern: `def ${name}($$$)`, lang: "py" },
        { label: "go func", pattern: `func ${name}($$$)`, lang: "go" },
        { label: "rs fn", pattern: `fn ${name}($$$)`, lang: "rs" },
      ],
      class: [
        { label: "ts class", pattern: `class ${name} $$$`, lang: "ts" },
        { label: "py class", pattern: `class ${name}($$$)`, lang: "py" },
      ],
      method: [
        { label: "ts method", pattern: `${name}($$$) { $$$ }`, lang: "ts" },
        { label: "py method", pattern: `def ${name}($$$)`, lang: "py" },
      ],
      struct: [{ label: "go struct", pattern: `type ${name} struct { $$$ }`, lang: "go" }],
      interface: [
        { label: "ts interface", pattern: `interface ${name} { $$$ }`, lang: "ts" },
        { label: "go interface", pattern: `type ${name} interface { $$$ }`, lang: "go" },
      ],
    };
    return {
      type: `symbol-definition (${k} ${name})`,
      queries: patterns[k] ?? [],
      check: (ev) => ev.length
        ? { verdict: "VERIFIED", confidence: "high", notes: [`${ev.length} definition site(s) for ${k} "${name}"`] }
        : { verdict: "NOT-FOUND", confidence: "medium", notes: [`no ${k} "${name}" defined in the searched tree`] },
    };
  }

  return null;
}

/**
 * Definition patterns per language. ast-grep 0.45.x matches structurally: a
 * pattern must account for the function body (and the return-type annotation
 * where the grammar keeps it as a child), so the bare `function $X($$$)`
 * shape matches nothing. Variants are tried in order and merged; py and go
 * are lenient, ts/js need the body wildcard, rs needs both body and return.
 */
const DEF_PATTERNS: Record<string, string[]> = {
  ts: ["function $X($$$): $RT { $$$ }", "function $X($$$) { $$$ }"],
  tsx: ["function $X($$$): $RT { $$$ }", "function $X($$$) { $$$ }"],
  js: ["function $X($$$) { $$$ }"],
  py: ["def $X($$$)"],
  go: ["func $X($$$)"],
  rs: ["fn $X($$$) -> $RT { $$$ }", "fn $X($$$) { $$$ }"],
};

const LANGS = ["ts", "tsx", "js", "py", "go", "rs"];

import { join, relative, resolve } from "node:path";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";

/** Executable-file probe — no shell, no quoting games. */
function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Two-pass call-edge: find X's definition range, then Y() calls inside it. */
function auditCallEdge(bin: string, root: string, globs: string[], x: string, y: string, qlog: AuditQuery[]): Evidence[] {
  const out: Evidence[] = [];
  for (const lang of LANGS) {
    const defPats = DEF_PATTERNS[lang];
    if (!defPats) continue;
    const defs: SgMatch[] = [];
    const seen = new Set<string>();
    for (const defPat of defPats) {
      const pat = defPat.replace("$X", x);
      const args = ["run", "-p", pat, "--lang", lang, "--json=compact", ...globs.flatMap((g) => ["--globs", g]), root];
      let found: SgMatch[];
      try {
        found = runSg(bin, args, root);
      } catch (e) {
        qlog.push({ label: `def ${x} (${lang})`, pattern: pat, lang, globs, hits: 0, note: String(e) });
        continue;
      }
      qlog.push({ label: `def ${x} (${lang})`, pattern: pat, lang, globs, hits: found.length });
      for (const d of found) {
        const key = `${d.file}:${d.range.start.line}:${d.range.start.column}`;
        if (!seen.has(key)) {
          seen.add(key);
          defs.push(d);
        }
      }
    }
    for (const d of defs) {
      // ast-grep globs match relative paths — absolute paths never match.
      const rel = relative(root, d.file) || d.file;
      const callArgs = ["run", "-p", `${y}($$$)`, "--lang", lang, "--json=compact", "--globs", rel, root];
      let calls: SgMatch[];
      try {
        calls = runSg(bin, callArgs, root);
      } catch {
        continue;
      }
      qlog.push({ label: `calls to ${y} in ${d.file} (${lang})`, pattern: `${y}($$$)`, lang, globs: [d.file], hits: calls.length });
      for (const c of calls) {
        if (c.range.start.line >= d.range.start.line && c.range.start.line <= d.range.end.line) {
          out.push(toEvidence(c));
        }
      }
    }
  }
  return out;
}

export interface AuditOptions {
  root: string;
  globs: string[];
  top: number;
  claim?: string;
  pattern?: string;
  lang?: string;
  rule?: string;
}

export function audit(opts: AuditOptions): AuditResult {
  const bin = resolveAstGrep();
  if (!bin) {
    return {
      claim: opts.claim ?? opts.pattern ?? opts.rule ?? "",
      claimType: "none",
      verdict: "INCONCLUSIVE",
      confidence: "low",
      queries: [],
      evidence: [],
      notes: ["ast-grep binary not found. Install: download the release zip from github.com/ast-grep/ast-grep and put `ast-grep` on PATH (or set AST_GREP_BIN). Do NOT use `sg` — on Linux that's util-linux setgroups."],
    };
  }

  const qlog: AuditQuery[] = [];
  const evidence: Evidence[] = [];
  const notes: string[] = [];
  let claimType = "direct";

  // runSg uses the root as BOTH the ast-grep path argument and the spawn
  // cwd. A relative root ("src") resolves the path arg against the cwd and
  // points at root/root — a silent zero-hit NOT-FOUND. Absolutize once so
  // both roles resolve the same directory.
  const root = resolve(opts.root);

  const runQuery = (q: BuiltQuery): void => {
    const args = q.rule
      ? ["scan", "--rule", q.rule!, "--json=compact", ...opts.globs.flatMap((g) => ["--globs", g]), root]
      : ["run", "-p", q.pattern!, "--lang", q.lang, "--json=compact", ...opts.globs.flatMap((g) => ["--globs", g]), root];
    try {
      const hits = runSg(bin, args, root);
      qlog.push({ label: q.label, pattern: q.pattern, rule: q.rule, lang: q.lang, globs: opts.globs, hits: hits.length });
      for (const h of hits.slice(0, opts.top * 4)) evidence.push(toEvidence(h));
    } catch (e) {
      qlog.push({ label: q.label, pattern: q.pattern, rule: q.rule, lang: q.lang, globs: opts.globs, hits: 0, note: String(e) });
    }
  };

  if (opts.claim) {
    const routed = routeClaim(opts.claim);
    if (!routed) {
      return {
        claim: opts.claim, claimType: "unrouted", verdict: "INCONCLUSIVE", confidence: "low",
        queries: [], evidence: [],
        notes: [
          "claim didn't match a known shape (port-bind, call-edge, import-edge, symbol-definition).",
          "Restate it in one of those shapes, or pass --pattern '<ast-grep pattern>' --lang <l> directly.",
          "Config values (key = value in yml/toml/ini) are text, not structure — use rg for those.",
        ],
      };
    }
    claimType = routed.type;
    if (routed.type.startsWith("call-edge")) {
      const m = opts.claim.match(/\b([A-Za-z_]\w*)\s+calls?\s+([A-Za-z_]\w*)\b/i)!;
      const hits = auditCallEdge(bin, root, opts.globs, m[1], m[2], qlog);
      for (const h of hits.slice(0, opts.top)) evidence.push(h);
      const verdict = hits.length ? "VERIFIED" as const : "NOT-FOUND" as const;
      return {
        claim: opts.claim, claimType, verdict,
        confidence: hits.length ? "high" : "medium",
        queries: qlog, evidence: evidence.slice(0, opts.top),
        notes: hits.length
          ? [`${hits.length} call site(s) of "${m[2]}" inside "${m[1]}"'s body`]
          : [`no call to "${m[2]}" inside "${m[1]}"'s definition range`],
      };
    }
    for (const q of routed.queries) runQuery(q);
    const { verdict, confidence, notes: n } = routed.check(evidence);
    return { claim: opts.claim, claimType, verdict, confidence, queries: qlog, evidence: evidence.slice(0, opts.top), notes: [...notes, ...n] };
  }

  if (opts.pattern) {
    claimType = "direct-pattern";
    const langs = opts.lang ? [opts.lang] : LANGS;
    for (const lang of langs) runQuery({ label: `pattern (${lang})`, pattern: opts.pattern, lang });
    const verdict = evidence.length ? "VERIFIED" : "NOT-FOUND";
    return {
      claim: opts.pattern, claimType, verdict,
      confidence: evidence.length ? "high" : "medium",
      queries: qlog, evidence: evidence.slice(0, opts.top),
      notes: evidence.length ? [`${evidence.length} structural hit(s)`] : ["pattern matched nothing — check references/pitfalls.md §2 (pattern must be valid code)"],
    };
  }

  if (opts.rule) {
    claimType = "yaml-rule";
    runQuery({ label: `rule ${opts.rule}`, rule: opts.rule, lang: opts.lang ?? "ts" });
    const verdict = evidence.length ? "VERIFIED" : "NOT-FOUND";
    return {
      claim: opts.rule, claimType, verdict,
      confidence: evidence.length ? "high" : "medium",
      queries: qlog, evidence: evidence.slice(0, opts.top),
      notes: evidence.length ? [`${evidence.length} rule hit(s)`] : ["rule matched nothing"],
    };
  }

  return {
    claim: "", claimType: "none", verdict: "INCONCLUSIVE", confidence: "low",
    queries: [], evidence: [],
    notes: ["audit needs one of: --claim \"...\", --pattern '<p>' [--lang l], --rule <file.yml>"],
  };
}

export function renderAudit(r: AuditResult): string {
  const lines = [`=== audit: "${r.claim}" [${r.claimType}] -> ${r.verdict} (confidence: ${r.confidence}) ===`];
  for (const q of r.queries) {
    lines.push(`  query [${q.label}] lang=${q.lang} hits=${q.hits}${q.note ? ` !! ${q.note}` : ""}`);
  }
  if (!r.evidence.length) lines.push("  (no evidence)");
  for (const e of r.evidence) {
    // ast-grep JSON lines are 0-based; humans read 1-based.
    lines.push(`  ${e.file}:${e.line + 1}:${e.col}-${e.endLine + 1}:${e.endCol}  ${e.text}`);
    const mv = Object.entries(e.meta).map(([k, v]) => `$${k}="${v}"`).join(" ");
    if (mv) lines.push(`    captures: ${mv}`);
  }
  for (const n of r.notes) lines.push(`  note: ${n}`);
  return lines.join("\n");
}
