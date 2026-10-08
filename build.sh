#!/usr/bin/env bash
# Builds fleetpilot-install.sh, the one-file installer, from src/
# and server/ with its production dependencies,
# after writing every blueprint file from project.conf and VERSION (blueprint 1.1.1).
#   bash build.sh            render, build, check
set -euo pipefail
cd "$(dirname "$0")"

node .blueprint/tools/blueprint.mjs render

VERSION="$(cat VERSION)"
OUT="fleetpilot-install.sh"
DELIM="__FLEETPILOT_FILE_END__"

# One heredoc per file; binary files (fonts, images) travel as base64
pack_tree() {
  local fn="$1" root="$2"; shift 2
  echo "${fn}() {"
  echo '  local W="$1"'
  (cd "$root" && find "$@" -type f ! -name '.DS_Store' | LC_ALL=C sort) | while read -r rel; do
    local f="${root}/${rel}" dir
    rel="${rel#./}"
    dir="$(dirname "$rel")"
    [ "$dir" != "." ] && echo "  mkdir -p \"\$W/${dir}\""
    if grep -Iq . "$f" 2>/dev/null || [ ! -s "$f" ]; then
      grep -q "$DELIM" "$f" && { echo "The delimiter $DELIM occurs in $f, please change it." >&2; exit 1; }
      echo "  cat > \"\$W/${rel}\" <<'${DELIM}'"
      cat "$f"
      [ -n "$(tail -c1 "$f")" ] && echo
    else
      echo "  base64 -d > \"\$W/${rel}\" <<'${DELIM}'"
      base64 -w 76 "$f"
    fi
    echo "${DELIM}"
  done
  echo '}'
}

# The app's additions to the installer, with its version. The token is written in two parts,
# so that rendering this file does not replace it; no other placeholder may be left over.
APP_HOOKS="$(sed "s/@@VER""SION@@/${VERSION}/g" installer/app.sh)"
if printf '%s' "$APP_HOOKS" | grep -E '@@[A-Z_]+@@' >/dev/null; then echo "installer/app.sh: unknown placeholder $(printf '%s' "$APP_HOOKS" | grep -oE '@@[A-Z_]+@@' | head -1)" >&2; exit 1; fi

# The app server: server/, package.json and only the production dependencies
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -r server package.json package-lock.json "$STAGE/"
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null)
rm -f "$STAGE/package-lock.json"
{
  cat installer/core/head.sh
  echo
  echo '# ------------------------------------------------------------------ App specific (installer/app.sh)'
  printf '%s\n' "$APP_HOOKS"
  echo
  pack_tree write_files src . ! -name package.json
  pack_tree write_app_files "$STAGE" .
  cat installer/core/tail.sh
} > "$OUT"
chmod +x "$OUT"
bash -n "$OUT"
echo "Built: $OUT ($(du -h "$OUT" | cut -f1), version ${VERSION})"
