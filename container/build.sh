#!/bin/bash
# Build the HappyClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_REF="${1:-${LOCAL_CONTAINER_IMAGE:-happyclaw-agent:local}}"

echo "Building HappyClaw agent container image..."
echo "Image: ${IMAGE_REF}"

# Build with Docker. The committed application dependency graph remains
# deterministic, while externally sourced runtime tools intentionally resolve
# their newest stable versions unless exact build args are supplied.
# --pull refreshes mutable base/tool stages without adding a time-based cache
# bust to deterministic application layers.
# --network=host: the build container otherwise gets Docker's default bridge DNS
# (8.8.8.8), which is unreliable inside VPN/tunnel environments and breaks the
# GitHub fetch in the feishu-cli step. Host networking reuses the host's working
# DNS resolver. Override with BUILD_NETWORK=default if your environment differs.
BUILD_NETWORK="${BUILD_NETWORK:-host}"
if ! docker build --pull --network="${BUILD_NETWORK}" -t "${IMAGE_REF}" .; then
  # Restricted/rootless BuildKit builders reject host networking (it's a gated
  # entitlement) instead of falling back. Retry once on the default bridge so
  # those environments still build — bridge DNS may need a working resolver.
  if [ "${BUILD_NETWORK}" = "host" ]; then
    echo "host-network build failed (restricted builder?); retrying with default bridge network..." >&2
    docker build --pull -t "${IMAGE_REF}" .
  else
    exit 1
  fi
fi

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_REF}"

# Touch sentinel so Makefile can detect stale image
touch "$SCRIPT_DIR/../.docker-build-sentinel"

echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | docker run -i ${IMAGE_REF}"
