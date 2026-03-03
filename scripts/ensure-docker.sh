#!/usr/bin/env bash
# ensure-docker.sh — 确保 Docker 已安装、运行，且当前用户有权限使用
set -euo pipefail

# 尝试直接执行 docker info，成功则无需任何操作
try_docker() {
  docker info >/dev/null 2>&1 && return 0
  sg docker -c "docker info" >/dev/null 2>&1 && return 0
  return 1
}

# 如果 docker 命令存在且可正常执行，直接返回
if command -v docker >/dev/null 2>&1 && try_docker; then
  exit 0
fi

# 如果 docker 命令存在但无权限（用户不在 docker 组）
if command -v docker >/dev/null 2>&1; then
  echo "⚠️  Docker 已安装但当前用户无权限，尝试添加到 docker 组..."
  sudo usermod -aG docker "$USER"
  if sg docker -c "docker info" >/dev/null 2>&1; then
    echo "✅ 已将 $USER 加入 docker 组"
    exit 0
  fi
  echo "✅ 已将 $USER 加入 docker 组"
  echo "⚠️  请重新登录终端或执行 'newgrp docker' 后重试"
  exit 1
fi

echo "🐳 Docker 未安装，正在自动安装..."

# 检测发行版
if [ -f /etc/os-release ]; then
  . /etc/os-release
else
  echo "❌ 无法检测操作系统，请手动安装 Docker"
  exit 1
fi

install_docker_rhel() {
  local repo_url="https://download.docker.com/linux"
  # RHEL 系（AlmaLinux, Rocky, CentOS Stream, RHEL, Fedora）
  case "${ID:-}:${ID_LIKE:-}" in
    fedora:*) repo_url="$repo_url/fedora/docker-ce.repo" ;;
    *rhel*|*centos*|almalinux:*|rocky:*) repo_url="$repo_url/rhel/docker-ce.repo" ;;
    *) repo_url="$repo_url/centos/docker-ce.repo" ;;
  esac

  sudo dnf config-manager --add-repo "$repo_url"
  sudo dnf install -y docker-ce docker-ce-cli containerd.io
}

install_docker_debian() {
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  local distro="$ID"
  # Ubuntu 和 Debian 用各自的源
  if [ "$distro" != "ubuntu" ] && [ "$distro" != "debian" ]; then
    distro="debian"
  fi
  curl -fsSL "https://download.docker.com/linux/$distro/gpg" | sudo gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$distro $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io
}

# 根据包管理器选择安装方式
if command -v dnf >/dev/null 2>&1; then
  install_docker_rhel
elif command -v apt-get >/dev/null 2>&1; then
  install_docker_debian
else
  echo "❌ 不支持的包管理器，请手动安装 Docker: https://docs.docker.com/engine/install/"
  exit 1
fi

# 启动 Docker 并设置开机自启
sudo systemctl enable --now docker

# 将当前用户加入 docker 组
if ! groups "$USER" | grep -q '\bdocker\b'; then
  sudo usermod -aG docker "$USER"
  echo "✅ 已将 $USER 加入 docker 组"
fi

# 验证安装
if try_docker; then
  echo "✅ Docker 安装完成"
else
  echo "✅ Docker 安装完成，请重新登录终端或执行 'newgrp docker' 使权限生效后重试"
  exit 1
fi
