#!/bin/bash
# Build the HappyClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="happyclaw-agent"
TAG="${1:-latest}"

echo "Building HappyClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker command not found"
  exit 127
fi

# Some environments only have the legacy builder and do not support --progress.
# Detect support at runtime so Homebrew/docker-cli without buildx can still work.
BUILD_ARGS=(build --build-arg CACHEBUST="$(date +%s)" -t "${IMAGE_NAME}:${TAG}" .)
if docker build --help 2>/dev/null | grep -q -- '--progress'; then
  BUILD_ARGS=(build --progress=plain --build-arg CACHEBUST="$(date +%s)" -t "${IMAGE_NAME}:${TAG}" .)
fi

docker "${BUILD_ARGS[@]}"

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"

# Touch sentinel so Makefile can detect stale image
touch "$SCRIPT_DIR/../.docker-build-sentinel"

echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | docker run -i ${IMAGE_NAME}:${TAG}"
