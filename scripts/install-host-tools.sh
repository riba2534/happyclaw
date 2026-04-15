#!/usr/bin/env bash
# install-host-tools.sh — Install external tools required by host-mode agents.
#
# This script brings the host environment closer to what the Docker container
# provides (feishu-cli, agent-browser, uv).  It is safe to re-run — it skips
# tools that are already installed and updates the builtin-skills cache.
#
# Usage:
#   ./scripts/install-host-tools.sh          # install everything
#   ./scripts/install-host-tools.sh skills   # only refresh builtin-skills cache

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$PROJECT_ROOT/data"
BUILTIN_SKILLS_DIR="$DATA_DIR/builtin-skills"

# ── Helpers ──────────────────────────────────────────────────

info()  { echo "  [INFO]  $*"; }
ok()    { echo "  [OK]    $*"; }
skip()  { echo "  [SKIP]  $*"; }
warn()  { echo "  [WARN]  $*" >&2; }

has_cmd() { command -v "$1" >/dev/null 2>&1; }

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  ARCH_GO="amd64" ;;
  aarch64|arm64) ARCH_GO="arm64" ;;
  *) warn "Unsupported architecture: $ARCH"; exit 1 ;;
esac
case "$OS" in
  Darwin) OS_GO="Darwin" ;;
  Linux)  OS_GO="linux" ;;
  *) warn "Unsupported OS: $OS"; exit 1 ;;
esac

# ── feishu-cli ───────────────────────────────────────────────

install_feishu_cli() {
  if has_cmd feishu-cli; then
    skip "feishu-cli already installed ($(feishu-cli --version 2>/dev/null || echo 'unknown version'))"
  else
    info "Installing feishu-cli..."
    VERSION=$(curl -sI "https://github.com/riba2534/feishu-cli/releases/latest" \
      | grep -i '^location:' | head -1 \
      | sed 's|.*/tag/\([^[:space:]]*\).*|\1|' | tr -d '\r\n')
    if [ -z "$VERSION" ]; then
      warn "Failed to detect feishu-cli latest version"
      return 1
    fi
    curl -fsSL "https://github.com/riba2534/feishu-cli/releases/download/${VERSION}/feishu-cli_${VERSION}_${OS_GO}-${ARCH_GO}.tar.gz" \
      | tar -xz --strip-components=1 -C /usr/local/bin 2>/dev/null \
      || tar -xzf <(curl -fsSL "https://github.com/riba2534/feishu-cli/releases/download/${VERSION}/feishu-cli_${VERSION}_${OS_GO}-${ARCH_GO}.tar.gz") -C /usr/local/bin
    ok "feishu-cli $VERSION installed"
  fi
}

# ── feishu-cli builtin skills cache ──────────────────────────

refresh_builtin_skills() {
  info "Refreshing builtin-skills cache in $BUILTIN_SKILLS_DIR ..."
  VERSION=$(curl -sI "https://github.com/riba2534/feishu-cli/releases/latest" \
    | grep -i '^location:' | head -1 \
    | sed 's|.*/tag/\([^[:space:]]*\).*|\1|' | tr -d '\r\n')
  if [ -z "$VERSION" ]; then
    warn "Failed to detect feishu-cli latest version — cannot refresh builtin-skills"
    return 1
  fi

  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' RETURN
  curl -fsSL "https://github.com/riba2534/feishu-cli/archive/refs/tags/${VERSION}.tar.gz" \
    | tar -xz -C "$TMP"

  # Clear old cache and copy fresh skills
  rm -rf "$BUILTIN_SKILLS_DIR"
  mkdir -p "$BUILTIN_SKILLS_DIR"
  cp -r "$TMP"/*/skills/. "$BUILTIN_SKILLS_DIR"/
  ok "Cached $(ls -d "$BUILTIN_SKILLS_DIR"/*/ 2>/dev/null | wc -l | tr -d ' ') builtin skills (feishu-cli $VERSION)"
}

# ── agent-browser ────────────────────────────────────────────

install_agent_browser() {
  if has_cmd agent-browser; then
    skip "agent-browser already installed"
  else
    info "Installing agent-browser..."
    npm install -g agent-browser
    ok "agent-browser installed"
  fi
}

# ── uv ───────────────────────────────────────────────────────

install_uv() {
  if has_cmd uv; then
    skip "uv already installed ($(uv --version 2>/dev/null || echo 'unknown'))"
  else
    info "Installing uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    ok "uv installed"
  fi
}

# ── Main ─────────────────────────────────────────────────────

echo "=== HappyClaw Host Tools Installer ==="
echo "    OS=$OS  ARCH=$ARCH"
echo ""

if [ "${1:-}" = "skills" ]; then
  refresh_builtin_skills
  exit 0
fi

install_feishu_cli
refresh_builtin_skills
install_agent_browser
install_uv

echo ""
echo "=== Done ==="
echo "Restart HappyClaw to pick up the new tools."
