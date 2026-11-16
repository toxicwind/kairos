# kairos bash glue — GENERATED from pens/flux/products/kairos/src/policy.ts (bun SSOT).
# Regenerate: bun run pens/flux/products/kairos/src/cli.ts init > pens/flux/products/kairos/shim.sh
_2S_GUARD_SRC="/home/toxic/pens/flux/products/kairos/src/init.ts"
# rg agent-first defaults (dots file sat empty+unwired since 2026-10-19 —
# kappa 2026-10-27: raw rg defaults caused megabyte line dumps on binaries
# and inconsistent case handling across every agent shell)
export RIPGREP_CONFIG_PATH="${RIPGREP_CONFIG_PATH:-$HOME/.config/ripgrep/config}"
# 2026-11-08: /usr/bin/python3 -> python3.14 has a NON-EXECUTABLE target on
# this box (EACCES on exec, bash exit 126 — reproduced in agent shells and by
# bare spawn). Pin the working mise python (3.14.7) ahead of /usr/bin so that
# python3 in every agent/interactive shell resolves to a real interpreter.
# Verified: /home/toxic/.local/share/mise/installs/python/3.14.7/bin/python3.14
export PATH="$HOME/.local/share/mise/installs/python/3/bin:$PATH"

# kairos guards AGENT tool shells (non-interactive, sourced via BASH_ENV) but
# must NOT hijack an interactive human's bash: the DEBUG trap fires before
# every command, so leaking it into ~/.bashrc breaks interactive use.
#
# Mode is a single explicit switch, defaulting to the shell's role: interactive
# -> idle (no trap, real binaries), non-interactive -> enforce.
# Set KAIROS_ENFORCE explicitly (0 idle / 1 enforce) to override.
if [ -z "${KAIROS_ENFORCE:-}" ]; then
  if [[ $- == *i* ]]; then export KAIROS_ENFORCE=0; else export KAIROS_ENFORCE=1; fi
fi
if [ "$KAIROS_ENFORCE" != "1" ]; then
  export KAIROS_SHIM_MODE=interactive
  trap - DEBUG 2>/dev/null || true
  unset -f _2s_guard _2s_urgent 2>/dev/null || true
  return 0 2>/dev/null || true
fi
export KAIROS_SHIM_MODE=agent

_2s_urgent() {
  # MOSTLY INVISIBLE: kairos fixes, it doesn't scold. The banner only shows in
  # diagnostics (KAIROS_DEBUG=1). Default: silent.
  [ "${KAIROS_DEBUG:-0}" = "1" ] || return 0
  echo "════ [kairos GUARD — URGENT, CANCELLED] ════"
  echo "  $1"
  echo "  MUST DO: $2"
}

_2s_guard() {
  local _c="${1:-$BASH_COMMAND}"
  case "$_c" in
    _2s_*|*kairos*) return 0 ;;
  *">/dev/null"*|*"> /dev/null"*|*"2>/dev/null"*|*"2> /dev/null"*|*"1>/dev/null"*|*"1> /dev/null"*|*"&>/dev/null"*)
      _2s_urgent "output discarded to /dev/null" "drop the redirect — full output or bust"; return 1 ;;
  *"| true"*|*"|true"*|*"|  true"*)
      _2s_urgent "'| true' swallows the exit code" "handle the failure explicitly"; return 1 ;;
  *"| false"*|*"|false"*|*"|  false"*)
      _2s_urgent "'| false' discards output and fabricates failure" "capture real output — never pipe to a sink that discards it"; return 1 ;;
  *"2>&1"*)
      _2s_urgent "'2>&1' merges stderr into stdout" "keep streams separate — no &2 merges"; return 1 ;;
  *[[:space:]]sleep[[:space:]][0-9]*|sleep[[:space:]][0-9]*)
      _2s_urgent "blocking sleep" "readiness-check or background it — never sleep to wait"; return 1 ;;
  *[[:space:]]head[[:space:]]*|head[[:space:]]*)
      _2s_urgent "'head' truncates output" "read the whole file with the read tool, or persist full output and read it back"; return 1 ;;
  *[[:space:]]tail[[:space:]]*|tail[[:space:]]*)
      _2s_urgent "'tail' truncates output" "read the whole file with the read tool, or persist full output and read it back"; return 1 ;;
  *"|"*[[:space:]]head[[:space:]]*|*"|"*[[:space:]]tail[[:space:]]*)
      _2s_urgent "'| head' / '| tail' truncate output" "persist full output to a file and read it back; never pipe through head/tail"; return 1 ;;
  esac
  return 0
}

set -o pipefail
if [ -z "${_2S_TRAP_ARMED:-}" ]; then
  export _2S_TRAP_ARMED=1
  trap '_2s_guard' DEBUG
fi

# No wrapper functions, no run-fast routing, no deadlines. The guard above is
# the ONLY behavior: banned truncation patterns cancel, everything else runs
# the real binary untouched.
export BASH_2S_SHIM=1
