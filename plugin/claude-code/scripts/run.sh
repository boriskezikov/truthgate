#!/bin/sh
# Runs the TruthGate hook from the repository root (the nearest parent of this script with a package.json), where
# `tsx` resolves. Claude Code installs the dependencies when it installs the plugin; a checkout without them gets the
# one runtime dependency here on first use. A failure never blocks the turn: it is shown, and the turn goes on
# unaudited.
fail() { printf '{"systemMessage":"TrustCheck could not run: %s"}\n' "$(printf '%s' "$1" | sed 's/[\\"]/\\&/g')"; exit 0; }
HERE="$(cd "$(dirname "$0")" && pwd)" || fail "its script directory cannot be resolved"
ROOT="$HERE"
while [ ! -f "$ROOT/package.json" ] && [ "$ROOT" != "/" ]; do ROOT="$(dirname "$ROOT")"; done
[ -f "$ROOT/package.json" ] || fail "no package.json above $HERE"
cd "$ROOT" || fail "cannot enter $ROOT"
if [ ! -x node_modules/.bin/tsx ]; then
  # ponytail: sessions that install at the same moment share one tree; install into a temporary directory and move
  # it into place if a plugin install ever arrives without node_modules.
  npm install --omit=dev --no-audit --no-fund >truthgate-install.log 2>&1 || fail "npm install failed in $ROOT, see truthgate-install.log"
  rm -f truthgate-install.log
fi
exec node_modules/.bin/tsx "$HERE/hook.ts"
