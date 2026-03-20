#!/bin/bash
# Build the HappyClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="happyclaw-agent"
TAG="${1:-latest}"

echo "Building HappyClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Build with Docker (CACHEBUST ensures claude-code is always latest)
# --progress=plain ensures clean line-based output for piped log capture (WebSocket streaming)
docker build --progress=plain --build-arg CACHEBUST="$(date +%s)" -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | docker run -i ${IMAGE_NAME}:${TAG}"
