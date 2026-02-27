#!/usr/bin/env bash
# Copy the canonical StreamEvent types to all three projects.
# Called by `make build` and `make sync-types`.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/shared/stream-event.ts"

TARGETS=(
  "$ROOT/container/agent-runner/src/stream-event.types.ts"
  "$ROOT/src/stream-event.types.ts"
  "$ROOT/web/src/stream-event.types.ts"
)

for target in "${TARGETS[@]}"; do
  cp "$SRC" "$target"
done
