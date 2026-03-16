#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.production}"
BUILD_AGENT_IMAGE="${BUILD_AGENT_IMAGE:-auto}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -n "${PYTHON_FOR_BUILD:-}" ]]; then
  export npm_config_python="$PYTHON_FOR_BUILD"
  export PYTHON="$PYTHON_FOR_BUILD"
fi

cd "$ROOT_DIR"

./deploy/bin/doctor.sh

echo "[STEP] install backend dependencies"
npm ci --include=dev

echo "[STEP] install agent-runner dependencies"
npm --prefix container/agent-runner ci --include=dev

echo "[STEP] install web dependencies"
npm --prefix web ci --include=dev

echo "[STEP] build application"
make build

if [[ "$BUILD_AGENT_IMAGE" == "true" ]] || { [[ "$BUILD_AGENT_IMAGE" == "auto" ]] && command -v docker >/dev/null 2>&1; }; then
  echo "[STEP] build agent image"
  ./deploy/bin/build-agent-image.sh
else
  echo "[SKIP] agent image build disabled"
fi

echo "[DONE] build artifacts are ready"
