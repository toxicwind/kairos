# kairos bash glue — GENERATED from pens/olympus/products/kairos/src/policy.ts (bun SSOT).
# Regenerate: bun run pens/olympus/products/kairos/src/cli.ts init > pens/olympus/products/kairos/shim.sh
_2S_GUARD_SRC="/home/toxic/pens/olympus/products/kairos/src/init.ts"
RF_BIN="$HOME/pens/barn/estate-ops/run-fast"
[ -x "$RF_BIN" ] || RF_BIN="$HOME/.local/bin/run-fast"
[ -x "$RF_BIN" ] || return 0
export RF_QUIET="${RF_QUIET:-1}"
export RF_DEADLINE="${RF_DEADLINE:-4.0}"
export DELEND_CODE_RACE="${DELEND_CODE_RACE:-$HOME/pens/barn/estate-ops/delend-code-race}"

_2s_urgent() {
  echo "════ [kairos GUARD — URGENT, CANCELLED] ════"
  echo "  $1"
  echo "  MUST DO: $2"
}

_2s_slow() {
    # Re-entry guard: a run-fast/kairos child marks RUN_FAST_ACTIVE=1; wrappers
    # in that child must use the REAL binary, never re-route to run-fast.
    # Without this, bun run X under run-fast spawns bash (BASH_ENV sources
    # this shim) then bun() routes to run-fast again: unbounded fork storm
    # (observed: 9400 processes of kairos run bun run forge.ts borrow).
    [ -n "${RUN_FAST_ACTIVE:-}" ] && return 1
    case "$1:$2" in
    git:push|git:pull|git:fetch|git:clone|git:merge|git:rebase|git:submodule|git:gc|git:filter-repo) return 0 ;;
    bun:install|bun:add|bun:remove|bun:update|bun:test|bun:build|bun:typecheck|bun:publish|bun:link|bun:run) return 0 ;;
    npm:install|npm:ci|npm:update|npm:build|npm:test|npm:typecheck|npm:publish) return 0 ;;
    tsgo:noEmit|tsgo:check|tsgo:typecheck) return 0 ;;
    turbo:typecheck|turbo:build|turbo:test|turbo:run) return 0 ;;
    tsc:noEmit|tsc:build) return 0 ;;
    pnpm:add|pnpm:install|pnpm:update) return 0 ;;
    pip:install) return 0 ;;
    pip3:install) return 0 ;;
    uv:sync|uv:add|uv:lock) return 0 ;;
    gh:repo|gh:pr|gh:release|gh:api) return 0 ;;
    gitleaks:git|gitleaks:detect) return 0 ;;
    codebase-memory:index_repository|codebase-memory:get_file_outline|codebase-memory:semantic_search) return 0 ;;
    cargo:build|cargo:test|cargo:check) return 0 ;;
    go:build|go:test|go:vet) return 0 ;;
    ffs:index|ffs:map) return 0 ;;
    make:*) return 0 ;;
  *) return 1 ;;
esac
}

_2s_guard() {
  local _c="${1:-$BASH_COMMAND}"
  case "$_c" in
    _2s_*|*two-sec*|*print_doctrine_hint*) return 0 ;;
  *">/dev/null"*|*"> /dev/null"*|*"2>/dev/null"*|*"2> /dev/null"*|*"1>/dev/null"*|*"1> /dev/null"*|*"&>/dev/null"*)
      _2s_urgent "output discarded to /dev/null" "drop the redirect — full output or bust"; return 1 ;;
  *"| true"*|*"|true"*|*"|  true"*)
      _2s_urgent "'| true' swallows the exit code" "handle the failure explicitly"; return 1 ;;
  *"2>&1"*)
      _2s_urgent "'2>&1' merges stderr into stdout" "keep streams separate — no &2 merges"; return 1 ;;
  *"| head"*|*"|head"*|*"| tail"*|*"|tail"*|*"| wc -l"*|*"|wc -l"*)
      _2s_urgent "pipeline truncation (head/tail/wc)" "persist FULL output; read via ffs"; return 1 ;;
  *[[:space:]]sleep[[:space:]][0-9]*)
      _2s_urgent "blocking sleep" "readiness-check or background it — never sleep to wait"; return 1 ;;
  *[[:space:]]head[[:space:]]-[[:space:]]*c*|*[[:space:]]tail[[:space:]]-[[:space:]]*c*)
      _2s_urgent "byte truncation (head/tail -c)" "persist full output; slice in code only"; return 1 ;;
  esac
  return 0
}

set -o pipefail
if [ -z "${_2S_TRAP_ARMED:-}" ]; then
  export _2S_TRAP_ARMED=1
  # notify-only trap: unwrapped binaries (echo, ls…) get ban notices;
  # deterministic CANCEL happens inside the wrappers (extdebug can't cancel
  # function traps on bash 5.3 — tested empirically).
  trap '_2s_guard' DEBUG
fi

_2s_wrap() { # $1=bin, rest=args — guard-check then slow-route
  local b="$1"; shift
  local probe
  probe="$b $*"
  _2s_guard "$probe" || return 126
  if _2s_slow "$b" "$1"; then "$RF_BIN" "$b" "$@"; else command "$b" "$@"; fi
}
git()  { _2s_wrap git "$@"; }
bun()  { _2s_wrap bun "$@"; }
npm()  { _2s_wrap npm "$@"; }
pip()  { _2s_wrap pip "$@"; }
pip3() { _2s_wrap pip3 "$@"; }
uv()   { _2s_wrap uv "$@"; }
gh()   { _2s_wrap gh "$@"; }
gitleaks() { _2s_wrap gitleaks "$@"; }
cargo() { _2s_wrap cargo "$@"; }
go()   { _2s_wrap go "$@"; }
uv()   { if _2s_slow uv "$1";   then "$RF_BIN" uv "$@";   else command uv "$@";   fi; }
gh()   { if _2s_slow gh "$1";   then "$RF_BIN" gh "$@";   else command gh "$@";   fi; }
go()   { if _2s_slow go "$1";   then "$RF_BIN" go "$@";   else command go "$@";   fi; }
timeout() { local _t="${1:-1}"; shift 2>/dev/null; _2s_guard "$*" || return 126; if [ -n "${RUN_FAST_ACTIVE:-}" ]; then command timeout "$_t" "$@"; return; fi; "$RF_BIN" --deadline "$_t" "$@"; }
# head/tail doctrine wrappers: FILE-truncation → route to ffs (full read);
# pipeline truncation (cmd | head, no FILE) → URGENT notice + cancel (126).
# bash's DEBUG trap reports each pipeline element separately (head -N, no
# pipe char), so the trap's | head pattern can never match a real pipeline —
# the deterministic cancel lives HERE in the wrapper, not the trap. -f follow
# is a live stream (monitoring), not truncation, and is passed through.
tail() {
  [ "$1" = "-f" ] && { command tail "$@"; return $?; }
  local _a
  for _a in "$@"; do
    [ "$_a" != "-n" ] && [ "${_a#-}" = "$_a" ] && [ -f "$_a" ] && {
      _2s_urgent "file truncation (tail $_a)" "ffs read $_a --full — full tail is the end of a full read"
      command ffs read "$_a" --full 2>/dev/null || command tail "$@"
      return $?
    }
  done
  if [ -p /dev/stdin ]; then
    _2s_urgent "pipeline truncation (tail) — persist FULL output" "run the upstream fully; read the result via ffs — never pipe tail"
    return 126
  fi
  command tail "$@"
}
head() {
  local _a
  for _a in "$@"; do
    [ "$_a" != "-n" ] && [ "${_a#-}" = "$_a" ] && [ -f "$_a" ] && {
      _2s_urgent "file truncation (head $_a)" "ffs read $_a — reads the FULL file (1M context); no reason to truncate"
      command ffs read "$_a" 2>/dev/null || command head "$@"
      return $?
    }
  done
  if [ -p /dev/stdin ]; then
    _2s_urgent "pipeline truncation (head) — persist FULL output" "run the upstream fully; read the file/result via ffs — never pipe head"
    return 126
  fi
  command head "$@"
}
# wc doctrine wrapper: cmd | wc -l is pipeline truncation (count swallows the
# evidence) → cancel like head/tail. Legit file counting (wc -l FILE) passes.
wc() {
  if [ -p /dev/stdin ]; then
    _2s_urgent "pipeline truncation (wc) — persist FULL output" "run the upstream fully; read the result via ffs — never pipe wc"
    return 126
  fi
  command wc "$@"
}

export -f _2s_slow _2s_guard _2s_urgent _2s_wrap git bun npm pip pip3 uv gh gitleaks cargo go timeout tail head wc 2>/dev/null
export BASH_2S_SHIM=1
