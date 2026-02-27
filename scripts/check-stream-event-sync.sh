#!/usr/bin/env bash
# Verify that all StreamEvent type copies are in sync with the canonical source.
# Returns non-zero if any copy diverges.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/shared/stream-event.ts"

TARGETS=(
  "$ROOT/container/agent-runner/src/stream-event.types.ts"
  "$ROOT/src/stream-event.types.ts"
  "$ROOT/web/src/stream-event.types.ts"
)

FAIL=0
for target in "${TARGETS[@]}"; do
  if [ ! -f "$target" ]; then
    echo "MISSING: $target"
    echo "  Run 'make sync-types' to generate it."
    FAIL=1
  elif ! diff -q "$SRC" "$target" > /dev/null 2>&1; then
    echo "OUT OF SYNC: $target"
    diff "$SRC" "$target" || true
    FAIL=1
  fi
done

if [ "$FAIL" -eq 0 ]; then
  echo "All StreamEvent type copies are in sync."
else
  echo ""
  echo "Fix: run 'make sync-types' to re-sync from shared/stream-event.ts"
  exit 1
fi
