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

cd "$ROOT_DIR"

if [[ ! -f dist/index.js ]]; then
  echo "dist/index.js missing; run ./deploy/bin/build-production.sh first"
  exit 1
fi

if [[ ! -d web/dist ]]; then
  echo "web/dist missing; run ./deploy/bin/build-production.sh first"
  exit 1
fi

exec node dist/index.js
