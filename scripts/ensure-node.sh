#!/usr/bin/env bash
# ensure-node.sh — 确保 Node.js >= 20 已安装
set -euo pipefail

REQUIRED_MAJOR=20

# 检查原生模块编译工具链（node-pty 等需要 g++ 和 make）
ensure_build_tools() {
  if command -v g++ >/dev/null 2>&1 && command -v make >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  echo "🔧 安装原生模块编译工具链（g++、make、python3）..."
  if command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y gcc-c++ make python3
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y build-essential python3
  fi
}

# 检查 node 是否已安装且版本满足要求
if command -v node >/dev/null 2>&1; then
  NODE_VERSION=$(node -v | sed 's/^v//')
  NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge "$REQUIRED_MAJOR" ]; then
    ensure_build_tools
    exit 0
  fi
  echo "⚠️  当前 Node.js 版本为 v$NODE_VERSION，需要 >= v$REQUIRED_MAJOR"
fi

echo "📦 Node.js >= $REQUIRED_MAJOR 未安装，正在自动安装..."

# 优先使用 fnm（快速 Node 版本管理器）
if command -v fnm >/dev/null 2>&1; then
  fnm install "$REQUIRED_MAJOR"
  fnm use "$REQUIRED_MAJOR"
  echo "✅ Node.js $(node -v) 已通过 fnm 安装"
  exit 0
fi

# 检测发行版并安装
if [ -f /etc/os-release ]; then
  . /etc/os-release
fi

install_node_rhel() {
  # 尝试 dnf module（RHEL/AlmaLinux/Rocky 自带 AppStream）
  if sudo dnf module list nodejs 2>/dev/null | grep -q "$REQUIRED_MAJOR"; then
    sudo dnf module enable -y "nodejs:$REQUIRED_MAJOR"
    sudo dnf install -y nodejs
  else
    # 回退到 NodeSource
    curl -fsSL "https://rpm.nodesource.com/setup_${REQUIRED_MAJOR}.x" | sudo bash -
    sudo dnf install -y nodejs
  fi
}

install_node_debian() {
  curl -fsSL "https://deb.nodesource.com/setup_${REQUIRED_MAJOR}.x" | sudo bash -
  sudo apt-get install -y nodejs
}

if command -v dnf >/dev/null 2>&1; then
  install_node_rhel
elif command -v apt-get >/dev/null 2>&1; then
  install_node_debian
else
  echo "❌ 不支持的包管理器，请手动安装 Node.js >= $REQUIRED_MAJOR: https://nodejs.org/"
  exit 1
fi

# 验证安装
if command -v node >/dev/null 2>&1; then
  ensure_build_tools
  echo "✅ Node.js $(node -v) 安装完成"
else
  echo "❌ Node.js 安装失败，请手动安装: https://nodejs.org/"
  exit 1
fi
