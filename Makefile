.PHONY: dev dev-backend dev-web build build-backend build-web start \
       typecheck typecheck-backend typecheck-web typecheck-agent-runner \
       format format-check install clean reset-init update-sdk sync-types \
       backup restore help

# ─── Development ─────────────────────────────────────────────

dev: ## 启动前后端（首次自动安装依赖和构建容器镜像）
	@./scripts/ensure-node.sh
	@if [ ! -d node_modules ] || [ package.json -nt node_modules ] || [ web/package.json -nt web/node_modules ] || [ container/agent-runner/package.json -nt container/agent-runner/node_modules ]; then echo "📦 依赖有更新，安装依赖..."; $(MAKE) install; fi
	@./scripts/ensure-docker.sh
	@if ! docker image inspect happyclaw-agent:latest >/dev/null 2>&1; then echo "🐳 构建 Agent 容器镜像..."; ./container/build.sh; fi
	@npm --prefix container/agent-runner run build --silent 2>/dev/null || npm --prefix container/agent-runner run build
	npm run dev:all

dev-backend: ## 仅启动后端
	npm run dev

dev-web: ## 仅启动前端
	npm run dev:web

# ─── Build ───────────────────────────────────────────────────

build: sync-types ## 编译前后端及 agent-runner
	npm run build:all
	npm --prefix container/agent-runner run build

build-backend: ## 仅编译后端
	npm run build

build-web: ## 仅编译前端
	npm run build:web

# ─── Production ──────────────────────────────────────────────

start: ## 一键启动生产环境（首次自动安装依赖和构建容器镜像）
	@./scripts/ensure-node.sh
	@if [ ! -d node_modules ] || [ package.json -nt node_modules ] || [ web/package.json -nt web/node_modules ] || [ container/agent-runner/package.json -nt container/agent-runner/node_modules ]; then echo "📦 依赖有更新，安装依赖..."; $(MAKE) install; fi
	@./scripts/ensure-docker.sh
	@if ! docker image inspect happyclaw-agent:latest >/dev/null 2>&1; then echo "🐳 构建 Agent 容器镜像..."; ./container/build.sh; fi
	$(MAKE) build
	npm run start

# ─── Quality ─────────────────────────────────────────────────

typecheck: sync-types typecheck-backend typecheck-web typecheck-agent-runner ## 全量类型检查
	@./scripts/check-stream-event-sync.sh

typecheck-backend:
	npm run typecheck

typecheck-web:
	cd web && npx tsc --noEmit

typecheck-agent-runner:
	cd container/agent-runner && npx tsc --noEmit

format: ## 格式化代码
	npm run format

format-check: ## 检查代码格式
	npm run format:check

# ─── Shared Types ────────────────────────────────────────────

sync-types: ## 同步 shared/ 下的类型定义到各子项目
	@./scripts/sync-stream-event.sh

# ─── SDK ─────────────────────────────────────────────────────

update-sdk: ## 更新 agent-runner 的 Claude Agent SDK 到最新版本
	cd container/agent-runner && npm update @anthropic-ai/claude-agent-sdk && npm run build
	@echo "SDK updated. Run 'make typecheck' to verify."

# ─── Setup ───────────────────────────────────────────────────

install: ## 安装全部依赖并编译 agent-runner
	npm install
	npm --prefix container/agent-runner install
	npm --prefix container/agent-runner run build
	cd web && npm install
	@touch node_modules web/node_modules container/agent-runner/node_modules

clean: ## 清理构建产物
	rm -rf dist
	rm -rf web/dist
	rm -rf container/agent-runner/dist

reset-init: ## 完全重置为首装状态（清空所有运行时数据）
	rm -rf data store groups
	@echo "✅ 已完全重置为首装状态（数据库、配置、工作区、记忆、会话全部清除）"

# ─── Backup / Restore ────────────────────────────────────────

backup: ## 备份运行时数据到 happyclaw-backup-{date}.tar.gz
	@DATE=$$(date +%Y%m%d-%H%M%S); \
	FILE="happyclaw-backup-$$DATE.tar.gz"; \
	echo "📦 正在打包备份到 $$FILE ..."; \
	tar -czf "$$FILE" \
	  --exclude='data/ipc' \
	  --exclude='data/env' \
	  --exclude='data/happyclaw.log' \
	  --exclude='data/db/messages.db-shm' \
	  --exclude='data/db/messages.db-wal' \
	  --exclude='data/groups/*/logs' \
	  data/db \
	  data/config \
	  data/groups \
	  data/sessions \
	  $$([ -d data/skills ] && echo data/skills) \
	  2>/dev/null; \
	echo "✅ 备份完成：$$FILE ($$(du -sh $$FILE | cut -f1))"

restore: ## 从 happyclaw-backup-*.tar.gz 恢复数据（用法：make restore 或 make restore FILE=xxx.tar.gz）
	@if [ -n "$(FILE)" ]; then \
	  BACKUP="$(FILE)"; \
	elif [ $$(ls happyclaw-backup-*.tar.gz 2>/dev/null | wc -l) -eq 1 ]; then \
	  BACKUP=$$(ls happyclaw-backup-*.tar.gz); \
	elif [ $$(ls happyclaw-backup-*.tar.gz 2>/dev/null | wc -l) -gt 1 ]; then \
	  echo "❌ 发现多个备份文件，请用 make restore FILE=xxx.tar.gz 指定："; \
	  ls happyclaw-backup-*.tar.gz; \
	  exit 1; \
	else \
	  echo "❌ 未找到备份文件，请将 happyclaw-backup-*.tar.gz 放到当前目录"; \
	  exit 1; \
	fi; \
	echo "📂 正在从 $$BACKUP 恢复..."; \
	if [ -d data ] && [ "$$(ls -A data 2>/dev/null)" ]; then \
	  echo "⚠️  data/ 目录已存在数据，继续将覆盖。是否继续？[y/N] "; \
	  read CONFIRM; \
	  [ "$$CONFIRM" = "y" ] || [ "$$CONFIRM" = "Y" ] || { echo "已取消"; exit 1; }; \
	fi; \
	tar -xzf "$$BACKUP"; \
	if [ ! -f data/config/session-secret.key ]; then \
	  echo "⚠️  警告：备份中缺少 session-secret.key，用户登录 cookie 将失效，需重新登录"; \
	fi; \
	echo "✅ 数据恢复完成"; \
	echo ""; \
	echo "后续步骤："; \
	echo "  1. 如需 Docker 容器支持：./container/build.sh"; \
	echo "  2. 启动服务：make start"

# ─── Help ────────────────────────────────────────────────────

help: ## 显示帮助
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
