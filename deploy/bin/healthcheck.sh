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

PORT="${WEB_PORT:-3000}"
URL="${HEALTHCHECK_URL:-http://127.0.0.1:${PORT}/}"

curl --fail --silent --show-error "$URL" >/dev/null

echo "healthcheck ok: $URL"
