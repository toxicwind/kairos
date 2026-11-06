/**
 * rewrite.ts — the autonomous rewrite policy: banned first-args swapped to their
 * sanctioned 1:1 equivalent (ffs / ast-grep / the read tool). Pure, no I/O.
 *
 * Rewrites are LOSSY-SAFE: only when the arg shape is unambiguous we map to
 * ffs; otherwise the command runs as-is (silently). `KAIROS_STRICT=1` disables
 * autonomy and hard-cancels instead.
 */
export function isStrict(): boolean {
  return process.env.KAIROS_STRICT === "1";
}

/** Banned first-arg: these have a faster/correct replacement that run-fast interposes for. */
export const bannedAsFirst: Set<string> = new Set([
  "find",
  "cat",
  "grep",
  "rg",
  "sed",
  "awk",
  "cut",
  "sort",
  "uniq",
  "less",
  "more",
  "xxd",
  "hexdump",
  "od",
  "base64",
  "tee",
  "tr",
  "paste",
  "join",
  "glob",
]);

/**
 * 1:1 autonomous rewrites for banned commands where the sanctioned semantics
 * are identical. Returns null when no safe rewrite exists — the caller runs
 * the original as-is (silently).
 */
export function rewriteBanned(seg: string[]): string[] | null {
  const base = seg[0]?.split("/").pop() ?? "";
  const args = seg.slice(1);
  const fileArg = args.filter((a) => !a.startsWith("-") && a !== "-").at(-1);
  switch (base) {
    case "cat":
    case "less":
    case "more":
      // <file> → ffs read <file> (same content; less/more are paging on a
      // single file — ffs read is the token-budgeted whole read).
      if (args.length === 1 && !args[0].startsWith("-") && fileArg)
        return ["ffs", "read", fileArg];
      return null;
    case "find":
      // find → ffs find (ffs replaces BOTH `find` AND `fd`). ffs find takes a
      // single positional <NEEDLE> — NO `-name`/`-type`/`-maxdepth` flags. Only
      // the unambiguous bare-needle shape maps 1:1; anything with GNU flags
      // runs as-is (the flags would break the rewrite).
      if (args.length >= 1 && !args.some((a) => a.startsWith("-"))) {
        const needle = args.filter((a) => !a.startsWith("-"));
        return ["ffs", "find", ...needle];
      }
      return null;
    case "glob":
      // glob <pattern> → ffs glob <pattern> (shell-style, gitignore-aware).
      if (args.length >= 1 && !args[0].startsWith("-"))
        return ["ffs", "glob", ...args];
      return null;
    case "grep":
    case "rg":
      // grep/rg <pattern> [path] → argos-grep <pattern> — the argos index
      // returns the exact passage + ax_path for kilobytes instead of a grep
      // line-walk (measured 2.7x fewer output tokens). Architect order
      // 2026-11-06: grep redirects to argos, never a fresh tree walk.
      if (args.length >= 1 && !args[0].startsWith("-")) {
        const pattern = args[0];
        const rest = args.slice(1).filter((a) => !a.startsWith("-"));
        const root = rest.at(-1);
        return root && root !== "."
          ? ["argos-grep", pattern, "--corpus", root]
          : ["argos-grep", pattern];
      }
      return null;
    default:
      return null;
  }
}

const WHY: Record<string, string> = {
  find: "walks the whole tree every time → O(entries), GB of stat calls. fd/ffs use gitignore + an index.",
  grep: "ripgrep-fresh re-scan of a huge tree is wasteful when the ffs index already has the answer.",
  rg: "you invoked it bare — route content search through ffs grep (index) or scope rg to a single dir.",
  cat: "dumps a raw file into the transcript, flooding context. The read tool outlines/budgets.",
  sed: "regex mangle on your source. ast-grep rewrites STRUCTURALLY on syntax, which is the only safe rewrite.",
  awk: "text-destroyer in a shell one-liner. Do the parse in code, or use ast-grep.",
  cut: "you sliced away columns you'll want 3 lines later. Persist full output.",
  sort: "stream-clobbering pipeline. Sort in code, keep the raw evidence.",
  uniq: "collapses the record you'll need. Dedup in code, keep the trail.",
  glob: "shell glob in a bash loop re-walks the tree — ffs glob uses the index.",
  less: "paging hides the full context in a pipe. Read the file.",
  more: "same as less — read the file.",
  xxd: "hex dump pollutes the transcript. Decode the bytes in your debugger.",
  hexdump: "byte-dump noise. Decode in code.",
  od: "octal/float inspect noise. Inspect in code.",
  base64: "obfuscates data in the transcript. Decode in code.",
  tee: "copies output you then inspect only partially. run-fast sessions persist full output.",
  tr: "regex transliterate mangling. Use ast-grep for structural transform.",
  paste: "column-join in a shell is a fragile hack. Do it in code.",
  join: "relation-join in shell is error-prone. Do it in code.",
};

const REPLACEMENTS: Record<string, string> = {
  find: [
    "fd <needle> <dir?>   # fast, gitignore-aware replacement for 'find'",
    "   or: ffs find <needle> --root <dir>  # estate index",
    "NEVER walk the whole disk: scope to a dir, or use the on-disk ffs index.",
  ].join("\n      "),
  grep: [
    "argos-grep <pattern> [--corpus NAME]  # index-backed passage search, file:line hits",
    "   or: ffs grep <regex> --root <dir> + --limit N  # for code-content in one repo",
    "NEVER 'grep -r' a huge tree; argos/ffs indexes already have the answer.",
  ].join("\n      "),
  rg: [
    "argos-grep <pattern>  # use the argos index instead of a fresh walk",
    "   (rg is fine for scoped, single-dir searches).",
  ].join("\n      "),
  cat: "read <path> via the read tool — 1M context, budget-aware outline by default, never truncated.",
  sed: [
    "ast-grep scan -p '<pattern>' --rewrite '<replacement>' -l ts <dir>  # tree-sitter STRUCTURAL rewrite",
    "   ast-grep works on syntax, not regex — it is the only safe in-place rewrite.",
  ].join("\n      "),
  awk: "ast-grep (structural) or the read tool; awk is a text destroyer you must not use.",
  cut: "persist FULL output (run-fast session file); slice columns in code, never in the transcript.",
  sort: "sort in code (JS/Python), not by clobbering the command stream with a pipeline.",
  uniq: "dedupe in code; never pipe the raw stream through uniq.",
  glob: "ffs glob <pattern>  # gitignore-aware, index-backed",
  less: "read the file with the read tool (paging in a pipe hides the full context you need).",
  more: "read the file with the read tool.",
  xxd: "hex-decode in the code you're debugging; never dump bytes into the transcript.",
  hexdump: "hex-decode in code.",
  od: "octal/decimal inspect in code.",
  base64:
    "base64-decode in code; never shell out a decode that pollutes output.",
  tee: [
    "persist FULL output via run-fast's session file (run-fast <cmd> then run-fast logs <id>),",
    "   or the tool's own --output/--outfile flag — never tee a transcript.",
  ].join("\n      "),
  tr: "ast-grep for structural transform; never a regex transliteration pipeline.",
  paste: "do the column-join in code.",
  join: "do the relation join in code.",
};

/** Human-readable WHY for a banned base (debug notices only). */
export function why(base: string): string {
  return WHY[base] ?? "it destroys, truncates, or re-walks output — the lane of slower/wrong tools.";
}

/** Human-readable replacement suggestion for a banned base (debug notices only). */
export function replacementFor(base: string): string {
  return REPLACEMENTS[base] ?? "ffs / ast-grep / the read tool";
}