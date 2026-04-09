#!/usr/bin/env bash
# ─── HappyClaw 服务管理 ──────────────────────────────────────
# 用法:
#   make stop      — 优雅停止服务
#   make restart   — 停止并重新启动
#   make status    — 查看运行状态
#   make logs      — 实时查看日志
#
# 也可以直接调用:
#   bash scripts/service.sh stop|restart|status|logs

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

PID_FILE="data/happyclaw.pid"
LOG_DIR="data/logs"
LOG_FILE="$LOG_DIR/happyclaw.log"
PORT="${WEB_PORT:-3000}"

# ─── Helpers ──────────────────────────────────────────────────

# 验证 PID 对应的进程是否是 HappyClaw
verify_pid_is_happyclaw() {
  local pid="$1"
  # 方法 1: ps 命令
  if command -v ps >/dev/null 2>&1; then
    local cmdline
    cmdline=$(ps -p "$pid" -o args= 2>/dev/null || echo "")
    if echo "$cmdline" | grep -qE "(happyclaw|index\.ts|index\.js)"; then
      return 0
    fi
    return 1
  fi
  # 方法 2: /proc (Linux)
  if [ -d "/proc/$pid" ]; then
    if grep -qE "(happyclaw|index\.ts|index\.js)" "/proc/$pid/cmdline" 2>/dev/null; then
      return 0
    fi
    return 1
  fi
  # 无法验证，拒绝信任
  return 1
}

get_pid_from_file() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    # 验证进程仍存在且是 HappyClaw（避免 PID 复用）
    if kill -0 "$pid" 2>/dev/null && verify_pid_is_happyclaw "$pid"; then
      echo "$pid"
      return 0
    fi
    # PID 文件过期，清理
    rm -f "$PID_FILE"
  fi
  return 1
}

get_pid_from_port() {
  local pid=""
  if command -v lsof >/dev/null 2>&1; then
    pid=$(lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)
  elif command -v ss >/dev/null 2>&1; then
    pid=$(ss -tlnp "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
  elif command -v netstat >/dev/null 2>&1; then
    pid=$(netstat -tlnp 2>/dev/null | grep ":$PORT " | grep -oP '\d+(?=/)' | tail -1)
  fi
  # 验证进程身份，防止误杀其他服务
  if [ -n "$pid" ] && verify_pid_is_happyclaw "$pid"; then
    echo "$pid"
    return 0
  fi
  return 1
}

find_pid() {
  # 优先使用 PID 文件
  local pid
  if pid=$(get_pid_from_file); then
    echo "$pid"
    return 0
  fi
  # 回退到端口查找
  if pid=$(get_pid_from_port); then
    echo "$pid"
    return 0
  fi
  return 1
}

# ─── Commands ─────────────────────────────────────────────────

cmd_stop() {
  local pid
  if ! pid=$(find_pid); then
    echo "✅ HappyClaw 未在运行"
    rm -f "$PID_FILE"
    return 0
  fi

  local method="PID 文件"
  [ -f "$PID_FILE" ] && [ "$(cat "$PID_FILE")" = "$pid" ] || method="端口 :$PORT"

  echo "⏳ 正在停止 HappyClaw (PID $pid, 通过$method)..."
  rm -f "$PID_FILE"

  # 1. 先发 SIGTERM 让进程优雅退出（30s 超时在进程内部处理）
  if kill -TERM "$pid" 2>/dev/null; then
    echo "   已发送 SIGTERM，等待优雅退出..."
    local waited=0
    while kill -0 "$pid" 2>/dev/null && [ $waited -lt 35 ]; do
      sleep 1
      waited=$((waited + 1))
    done

    if ! kill -0 "$pid" 2>/dev/null; then
      echo "✅ HappyClaw 已优雅停止 (${waited}s)"
      return 0
    fi

    # 2. SIGTERM 超时，发 SIGKILL
    echo "⚠️  优雅退出超时，强制终止..."
    kill -KILL "$pid" 2>/dev/null || true
    sleep 1

    if ! kill -0 "$pid" 2>/dev/null; then
      echo "✅ HappyClaw 已强制停止"
      return 0
    fi
  fi

  echo "❌ 无法停止进程 $pid"
  return 1
}

cmd_restart() {
  echo "🔄 重启 HappyClaw..."
  cmd_stop
  echo ""
  echo "请手动启动: make start 或 make start-bg"
}

cmd_status() {
  echo "━━━ HappyClaw 服务状态 ━━━"
  echo ""

  local pid
  if pid=$(find_pid); then
    local method="PID 文件"
    [ -f "$PID_FILE" ] && [ "$(cat "$PID_FILE")" = "$pid" ] || method="端口 :$PORT"

    echo "  状态:  ✅ 运行中"
    echo "  PID:   $pid (via $method)"
    echo "  端口:  $PORT"
    echo "  地址:  http://localhost:$PORT"

    # 显示进程运行时间
    if command -v ps >/dev/null 2>&1; then
      local elapsed
      elapsed=$(ps -p "$pid" -o etime= 2>/dev/null | tr -d ' ')
      if [ -n "$elapsed" ]; then
        echo "  运行:  ${elapsed}"
      fi
    fi

    # 内存占用
    if command -v ps >/dev/null 2>&1; then
      local mem
      mem=$(ps -p "$pid" -o rss= 2>/dev/null | tr -d ' ')
      if [ -n "$mem" ]; then
        echo "  内存:  $((mem / 1024)) MB"
      fi
    fi
  else
    echo "  状态:  ⏹ 未运行"
  fi

  echo ""
  echo "  日志:  $LOG_FILE"
  if [ -f "$LOG_FILE" ]; then
    echo "  大小:  $(du -sh "$LOG_FILE" | cut -f1)"
    echo "  更新:  $(stat -c '%y' "$LOG_FILE" 2>/dev/null | cut -d. -f1 || stat -f '%Sm' "$LOG_FILE" 2>/dev/null)"
  fi

  echo ""
  echo "━━━ 常用命令 ━━━"
  echo "  make start     前台启动"
  echo "  make start-bg  后台启动（日志写入文件）"
  echo "  make stop      停止服务"
  echo "  make restart   重启服务"
  echo "  make status    查看状态"
  echo "  make logs      实时日志"
}

cmd_logs() {
  if [ ! -f "$LOG_FILE" ]; then
    # 检查日志目录下是否有日志
    local found=0
    if [ -d "$LOG_DIR" ]; then
      found=$(find "$LOG_DIR" -name "*.log" -type f 2>/dev/null | wc -l)
    fi
    if [ "$found" -gt 0 ]; then
      echo "📦 主日志文件不存在，但发现其他日志："
      find "$LOG_DIR" -name "*.log" -type f -exec ls -lh {} \; 2>/dev/null
      echo ""
      echo "提示: 使用后台模式启动会产生日志文件 (make start-bg)"
      return 1
    fi
    echo "📭 暂无日志文件: $LOG_FILE"
    echo ""
    echo "日志在以下情况产生:"
    echo "  1. 使用 make start-bg 后台启动时，输出会写入日志文件"
    echo "  2. 前台运行 (make start) 的日志直接输出到终端"
    echo "  3. 容器日志在 data/groups/*/logs/ 下"
    return 1
  fi

  local lines="${1:-100}"
  if [ "$lines" = "follow" ] || [ "$lines" = "f" ]; then
    echo "📝 实时跟踪日志: $LOG_FILE (Ctrl+C 退出)"
    echo ""
    tail -f "$LOG_FILE"
  else
    echo "📝 最近 $lines 行日志: $LOG_FILE"
    echo ""
    tail -n "$lines" "$LOG_FILE"
  fi
}

# ─── Main ─────────────────────────────────────────────────────

case "${1:-}" in
  stop)
    cmd_stop
    ;;
  restart)
    cmd_restart
    ;;
  status)
    cmd_status
    ;;
  logs)
    cmd_logs "${2:-100}"
    ;;
  *)
    echo "HappyClaw 服务管理"
    echo ""
    echo "用法: bash scripts/service.sh <command>"
    echo ""
    echo "Commands:"
    echo "  stop          优雅停止服务"
    echo "  restart       停止并提示重新启动"
    echo "  status        查看运行状态、PID、日志路径"
    echo "  logs [N|f]    查看最近 N 行日志，或 f 实时跟踪"
    echo ""
    echo "推荐通过 Makefile 使用:"
    echo "  make stop | make restart | make status | make logs"
    exit 1
    ;;
esac
