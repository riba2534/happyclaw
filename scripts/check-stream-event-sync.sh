#!/usr/bin/env bash
# Verify that all shared type copies are in sync with the canonical sources.
# Returns non-zero if any copy diverges.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

FAIL=0

check_sync() {
  local src="$1"
  shift
  for target in "$@"; do
    if [ ! -f "$target" ]; then
      echo "MISSING: $target"
      echo "  Run 'make sync-types' to generate it."
      FAIL=1
    elif ! diff -q "$src" "$target" > /dev/null 2>&1; then
      echo "OUT OF SYNC: $target"
      diff "$src" "$target" || true
      FAIL=1
    fi
  done
}

# StreamEvent types
check_sync "$ROOT/shared/stream-event.ts" \
  "$ROOT/container/agent-runner/src/stream-event.types.ts" \
  "$ROOT/src/stream-event.types.ts" \
  "$ROOT/web/src/stream-event.types.ts"

# Image detector
check_sync "$ROOT/shared/image-detector.ts" \
  "$ROOT/src/image-detector.ts" \
  "$ROOT/container/agent-runner/src/image-detector.ts"

# Channel prefixes
check_sync "$ROOT/shared/channel-prefixes.ts" \
  "$ROOT/src/channel-prefixes.ts" \
  "$ROOT/container/agent-runner/src/channel-prefixes.ts"

# Claude environment HappyClaw owns
check_sync "$ROOT/shared/claude-provider-env.ts" \
  "$ROOT/src/claude-provider-env.ts" \
  "$ROOT/container/agent-runner/src/claude-provider-env.ts"

# Reply step list + reasoning text helpers
for name in thinking-text stream-steps; do
  check_sync "$ROOT/shared/$name.ts" \
    "$ROOT/src/$name.ts" \
    "$ROOT/web/src/lib/$name.ts"
done

# Session list order
check_sync "$ROOT/shared/session-order.ts" \
  "$ROOT/src/session-order.ts" \
  "$ROOT/web/src/lib/session-order.ts"

# Model connection presets, model lists and upstream errors
check_sync "$ROOT/shared/model-providers.ts" \
  "$ROOT/src/model-providers.ts" \
  "$ROOT/web/src/lib/model-providers.ts"

# Automations
check_sync "$ROOT/shared/automation.ts" \
  "$ROOT/src/automation.ts" \
  "$ROOT/web/src/lib/automation.ts" \
  "$ROOT/container/agent-runner/src/automation.ts"


# Team mode shapes
check_sync "$ROOT/shared/work-items.ts" \
  "$ROOT/src/work-items.ts" \
  "$ROOT/web/src/work-items.ts" \
  "$ROOT/container/agent-runner/src/work-items.ts"

if [ "$FAIL" -eq 0 ]; then
  echo "All shared type copies are in sync."
else
  echo ""
  echo "Fix: run 'make sync-types' to re-sync from shared/"
  exit 1
fi
