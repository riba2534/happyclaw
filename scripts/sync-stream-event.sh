#!/usr/bin/env bash
# Copy canonical shared types to all sub-projects.
# Called by `make build` and `make sync-types`.
# Only copies when content differs, to avoid unnecessary timestamp changes
# that would trigger redundant incremental builds.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Copy file only if content differs
sync_file() {
  local src="$1" target="$2"
  if [ ! -f "$target" ] || ! cmp -s "$src" "$target"; then
    cp "$src" "$target"
  fi
}

# --- StreamEvent types (3 targets) ---
SRC_SE="$ROOT/shared/stream-event.ts"
for target in \
  "$ROOT/container/agent-runner/src/stream-event.types.ts" \
  "$ROOT/src/stream-event.types.ts" \
  "$ROOT/web/src/stream-event.types.ts" \
; do
  sync_file "$SRC_SE" "$target"
done

# --- Image detector (2 targets: backend + agent-runner; not needed by web) ---
SRC_ID="$ROOT/shared/image-detector.ts"
for target in \
  "$ROOT/src/image-detector.ts" \
  "$ROOT/container/agent-runner/src/image-detector.ts" \
; do
  sync_file "$SRC_ID" "$target"
done

# --- Channel prefixes (2 targets: backend + agent-runner; not needed by web) ---
SRC_CP="$ROOT/shared/channel-prefixes.ts"
for target in \
  "$ROOT/src/channel-prefixes.ts" \
  "$ROOT/container/agent-runner/src/channel-prefixes.ts" \
; do
  sync_file "$SRC_CP" "$target"
done

# --- Claude environment HappyClaw owns (backend strip + Runner pin) ---
SRC_PE="$ROOT/shared/claude-provider-env.ts"
for target in \
  "$ROOT/src/claude-provider-env.ts" \
  "$ROOT/container/agent-runner/src/claude-provider-env.ts" \
; do
  sync_file "$SRC_PE" "$target"
done

# --- Reply step list + reasoning text helpers (2 targets each: backend + web) ---
# The backend records a settled turn's ordered steps with the very reducer the
# Web renders live, so the two cannot drift. Not needed by the agent-runner.
for name in thinking-text stream-steps; do
  sync_file "$ROOT/shared/$name.ts" "$ROOT/src/$name.ts"
  sync_file "$ROOT/shared/$name.ts" "$ROOT/web/src/lib/$name.ts"
done

# --- Session list order (backend + web): Web lists and IM /list agree ---
sync_file "$ROOT/shared/session-order.ts" "$ROOT/src/session-order.ts"
sync_file "$ROOT/shared/session-order.ts" "$ROOT/web/src/lib/session-order.ts"

# --- Model connection presets, model lists and upstream errors (backend + web) ---
# The server validates and tests connections with the same rules the Web uses
# to guide the user through adding one.
sync_file "$ROOT/shared/model-providers.ts" "$ROOT/src/model-providers.ts"
sync_file "$ROOT/shared/model-providers.ts" "$ROOT/web/src/lib/model-providers.ts"

# --- Automations: validation, labels and the per-run context (all three) ---
sync_file "$ROOT/shared/automation.ts" "$ROOT/src/automation.ts"
sync_file "$ROOT/shared/automation.ts" "$ROOT/web/src/lib/automation.ts"
sync_file "$ROOT/shared/automation.ts" "$ROOT/container/agent-runner/src/automation.ts"

# --- Team mode shapes (3 targets: backend, web and agent-runner) ---
for target in \
  "$ROOT/src/work-items.ts" \
  "$ROOT/web/src/work-items.ts" \
  "$ROOT/container/agent-runner/src/work-items.ts" \
; do
  sync_file "$ROOT/shared/work-items.ts" "$target"
done
