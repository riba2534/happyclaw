#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <image-reference> [expected-architecture]" >&2
  exit 2
fi

IMAGE_REF="$1"
EXPECTED_ARCHITECTURE="${2:-}"
SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-120}"
SMOKE_CONTAINER_NAME="${SMOKE_CONTAINER_NAME:-happyclaw-image-smoke-${GITHUB_RUN_ID:-local}-${RANDOM}}"

# shellcheck disable=SC2317 # invoked indirectly by trap
cleanup() {
  docker rm -f "$SMOKE_CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# A digest reference is immutable. Prefer an already loaded local image for
# developer use; CI's digest candidate is not loaded, so this performs a real
# registry pull before the runtime probe.
if ! docker image inspect "$IMAGE_REF" >/dev/null 2>&1; then
  docker pull "$IMAGE_REF"
fi

if [ -n "$EXPECTED_ARCHITECTURE" ]; then
  actual_architecture="$(
    docker image inspect --format '{{.Architecture}}' "$IMAGE_REF"
  )"
  if [ "$actual_architecture" != "$EXPECTED_ARCHITECTURE" ]; then
    echo "Expected $EXPECTED_ARCHITECTURE image, pulled $actual_architecture" >&2
    exit 1
  fi
fi

# -i keeps stdin open while detached. The production entrypoint starts Chromium
# first and then waits for the task JSON on stdin, giving the probe a stable
# window without bypassing any real startup behavior.
docker run --detach --interactive \
  --name "$SMOKE_CONTAINER_NAME" \
  "$IMAGE_REF" >/dev/null

for ((attempt = 1; attempt <= SMOKE_TIMEOUT_SECONDS; attempt++)); do
  if ! docker inspect --format '{{.State.Running}}' "$SMOKE_CONTAINER_NAME" |
    grep -qx true; then
    echo "Container exited before Chromium became ready" >&2
    docker logs "$SMOKE_CONTAINER_NAME" >&2 || true
    exit 1
  fi

  if response="$(
    docker exec "$SMOKE_CONTAINER_NAME" \
      curl --noproxy '*' -fsS http://127.0.0.1:9222/json/version 2>/dev/null
  )"; then
    if jq -e '
      type == "object" and
      (.Browser | type == "string" and length > 0) and
      (.webSocketDebuggerUrl | type == "string" and startswith("ws://"))
    ' <<<"$response" >/dev/null; then
      printf '%s\n' "$response" | jq .
      echo "Chromium CDP HTTP smoke test passed for $IMAGE_REF"
      exit 0
    fi
  fi

  sleep 1
done

echo "Timed out waiting for Chromium CDP HTTP endpoint" >&2
docker logs "$SMOKE_CONTAINER_NAME" >&2 || true
exit 1
