#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.production}"

source_env() {
  if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
}

python_cmd() {
  if [[ -n "${PYTHON_FOR_BUILD:-}" ]]; then
    printf '%s\n' "$PYTHON_FOR_BUILD"
  else
    printf '%s\n' "python3"
  fi
}

check_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[FAIL] missing command: $cmd"
    return 1
  fi
  echo "[ OK ] $cmd -> $(command -v "$cmd")"
}

check_node_version() {
  local major
  major="$(node -p "process.versions.node.split('.')[0]")"
  if [[ "$major" -lt 20 ]]; then
    echo "[FAIL] Node.js >= 20 required, current: $(node -v)"
    return 1
  fi
  echo "[ OK ] node version $(node -v)"
}

check_optional_docker() {
  if command -v docker >/dev/null 2>&1; then
    echo "[ OK ] docker -> $(docker --version)"
  else
    echo "[WARN] docker not found; host mode works, member container mode will be unavailable"
  fi
}

check_python_version() {
  local py
  py="$(python_cmd)"
  if ! command -v "$py" >/dev/null 2>&1; then
    echo "[FAIL] missing Python interpreter: $py"
    return 1
  fi

  local version major minor
  version="$("$py" -c 'import sys; print("{}.{}".format(sys.version_info[0], sys.version_info[1]))')"
  major="${version%%.*}"
  minor="${version##*.}"
  if [[ "$major" -lt 3 ]] || [[ "$major" -eq 3 && "$minor" -lt 8 ]]; then
    echo "[FAIL] python >= 3.8 required for node-gyp/native module builds, current: $("$py" --version 2>&1)"
    return 1
  fi
  echo "[ OK ] python interpreter $py -> $("$py" --version 2>&1)"
}

main() {
  cd "$ROOT_DIR"
  source_env

  check_cmd node
  check_node_version
  check_cmd npm
  check_cmd make
  check_python_version
  check_optional_docker

  echo "[INFO] project root: $ROOT_DIR"
  echo "[INFO] env file: ${ENV_FILE}"
  echo "[INFO] web port: ${WEB_PORT:-3000}"
  echo "[INFO] timezone: ${TZ:-system default}"

  [[ -f package.json ]] || { echo "[FAIL] package.json missing"; exit 1; }
  [[ -f web/package.json ]] || { echo "[FAIL] web/package.json missing"; exit 1; }
  [[ -f container/agent-runner/package.json ]] || { echo "[FAIL] container/agent-runner/package.json missing"; exit 1; }

  echo "[ OK ] repository layout looks valid"
}

main "$@"
