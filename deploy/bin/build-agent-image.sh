#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.production}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found"
  exit 1
fi

IMAGE_REF="${CONTAINER_IMAGE:-happyclaw-agent:latest}"

cd "$ROOT_DIR/container"
echo "Building agent image: ${IMAGE_REF}"
docker build --progress=plain --build-arg CACHEBUST="$(date +%s)" -t "$IMAGE_REF" .
