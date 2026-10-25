#!/bin/sh
# Runs the TruthGate hook from the repository root (the nearest parent of the plugin with a package.json), where
# `tsx` resolves; installs the one runtime dependency on first use (a marketplace install clones the repository
# without node_modules).
ROOT="$CLAUDE_PLUGIN_ROOT"
while [ ! -f "$ROOT/package.json" ] && [ "$ROOT" != "/" ]; do ROOT="$(dirname "$ROOT")"; done
[ -f "$ROOT/package.json" ] || exit 0
cd "$ROOT" || exit 0
[ -x node_modules/.bin/tsx ] || npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || exit 0
exec node_modules/.bin/tsx "$CLAUDE_PLUGIN_ROOT/scripts/hook.ts"
