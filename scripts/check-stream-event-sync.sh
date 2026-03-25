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

if [ "$FAIL" -eq 0 ]; then
  echo "All shared type copies are in sync."
else
  echo ""
  echo "Fix: run 'make sync-types' to re-sync from shared/"
  exit 1
fi
