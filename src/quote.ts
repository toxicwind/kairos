/**
 * quote.ts — lossless shell quoting and secret redaction. Pure functions, no I/O.
 *
 * shellQuoteCmd / segmentsToCmd build a re-runnable bash line that preserves
 * every argument boundary (quotes, globs, inline env, `-c` programs) so a
 * fragmented command survives a `bash -c` round-trip. redactCmd masks secrets
 * for any notice/log — never for execution.
 */
export const REDACT = "*****";

/**
 * Losslessly quote an argv array back into a single re-runnable shell line.
 *
 * Unlike `redactCmd` (a flattened, truncated, secret-masked DIAGNOSTIC string),
 * this preserves every argument boundary so a fragmented `-c` program, inline
 * `FOO=bar` env assignment, glob, or quoted substring survives a `bash -c`
 * round-trip. run-fast hands THIS to delend-code-race so the auto-racer races
 * the real failing command, not a phantom.
 */
export function shellQuoteCmd(args: string[]): string {
  return args
    .map((a) =>
      /^[A-Za-z0-9_./:=-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`,
    )
    .join(" ");
}

/**
 * Quote a full pipeline (segments + operators) into one lossless bash line.
 *
 * The naive `a.includes(" ") ? '"'+a+'"' : a` join destroyed arguments
 * containing double quotes (e.g. `--jq '.x + "|"'`) by stripping the inner
 * quotes, and expanded `$`/backticks inside double-quoted args. Every
 * execution path must build its bash line through THIS, never by hand.
 */
export function segmentsToCmd(
  segments: string[][],
  ops: Array<"&" | "&&" | ";" | "|"> = [],
): string {
  if (!segments.length) return "true";
  let line = shellQuoteCmd(segments[0]);
  for (let i = 1; i < segments.length; i++) {
    line += ` ${ops[i - 1] ?? "|"} ${shellQuoteCmd(segments[i])}`;
  }
  return line;
}

export function redactCmd(args: string[]): string {
  return (
    args
      .map((a) => {
        // KEY=value or api_key=value / token=… / secret=… / password=… / _key=…
        const kv =
          /^([A-Za-z_][A-Za-z0-9_-]*(?:api[_k]ey|token|secret|password|_key)=)(.+)$/i.exec(
            a,
          );
        if (kv) return `${kv[1]}${REDACT}`;
        // Header-style: Authorization: Bearer … / X-API-Key: … / x-api-key: …
        const hdr =
          /^(Authorization|Bearer|X-API-Key|x-api-key)\s*:\s*\S.+$/i.exec(a);
        if (hdr)
          return a.replace(/^(.*?)(:|Bearer)\s*\S.+$/i, `$1$2 ${REDACT}`);
        // Bare atr_/sk-/sk_/ghp_/gho_/gsk_/key_ style key tokens (Atria, OpenAI, etc.)
        if (/^(atr|sk|ghp|gho|gsk|key)[_-][A-Za-z0-9]+$/.test(a)) return REDACT;
        return a;
      })
      .slice(0, 8)
      .join(" ")
      // Sweep any leftovers anywhere in the joined line.
      .replace(/Bearer\s+\S+/gi, `Bearer ${REDACT}`)
      .replace(
        /(api_key|apiKey|token|secret|password)=[^\s"']+/gi,
        `$1=${REDACT}`,
      )
  );
}