#!/usr/bin/env bash
# install-forge.sh — put the `forge` launcher on PATH.
#
# No host paths are hardcoded: the skill directory is resolved from this
# script's own location, so the same installer works on any checkout
# (yote, the hatch cell, a laptop). It symlinks <prefix>/forge at the
# repo's bin/forge.ts entry point, which carries a `#!/usr/bin/env bun`
# shebang and is the package.json "bin" target.
#
# Usage: scripts/install-forge.sh [--prefix DIR]
#   Default prefix: $HOME/.local/bin when it is on PATH, else /usr/local/bin
#   when writable, else $HOME/.local/bin (created) with a PATH hint.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
SKILL_DIR="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"
ENTRY="$SKILL_DIR/bin/forge.ts"

PREFIX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="${2:?--prefix needs a directory}"; shift 2 ;;
    --prefix=*) PREFIX="${1#--prefix=}"; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "$ENTRY" ]; then
  echo "install-forge: entry point missing: $ENTRY" >&2
  exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "install-forge: 'bun' is not on PATH — install Bun first (https://bun.sh)" >&2
  exit 1
fi

if [ -z "$PREFIX" ]; then
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) PREFIX="$HOME/.local/bin" ;;
    *)
      if [ -w /usr/local/bin ]; then PREFIX="/usr/local/bin";
      else PREFIX="$HOME/.local/bin"; fi ;;
  esac
fi
mkdir -p "$PREFIX"
chmod +x "$ENTRY"
ln -sfn "$ENTRY" "$PREFIX/forge"

if command -v forge >/dev/null 2>&1; then
  echo "install-forge: forge -> $(command -v forge)"
  forge --help >/dev/null 2>&1 && echo "install-forge: 'forge --help' runs"
else
  echo "install-forge: linked $PREFIX/forge but it is not on PATH." >&2
  echo "install-forge: add $PREFIX to PATH, or re-run with --prefix <dir-on-path>." >&2
  exit 1
fi
