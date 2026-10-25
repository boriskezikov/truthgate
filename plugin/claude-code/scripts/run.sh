#!/bin/sh
# Runs the TruthGate hook from the repository root (the nearest parent of the plugin with a package.json), where
# `npx tsx` resolves.
ROOT="$CLAUDE_PLUGIN_ROOT"
while [ ! -f "$ROOT/package.json" ] && [ "$ROOT" != "/" ]; do ROOT="$(dirname "$ROOT")"; done
[ -f "$ROOT/package.json" ] || exit 0
cd "$ROOT" && exec npx tsx "$CLAUDE_PLUGIN_ROOT/scripts/hook.ts"
