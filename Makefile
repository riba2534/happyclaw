.PHONY: dev dev-backend dev-web build build-backend build-web start \
       typecheck typecheck-backend typecheck-web typecheck-agent-runner \
       format format-check install clean reset-init update-sdk sync-types help

# ─── Development ─────────────────────────────────────────────

dev: ## 启动前后端（首次自动安装依赖和构建容器镜像）
	@if [ ! -d node_modules ]; then echo "📦 首次运行，安装依赖..."; $(MAKE) install; fi
	@if command -v docker >/dev/null 2>&1 && ! docker image inspect happyclaw-agent:latest >/dev/null 2>&1; then echo "🐳 构建 Agent 容器镜像..."; ./container/build.sh; fi
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
	@if [ ! -d node_modules ]; then echo "📦 首次运行，安装依赖..."; $(MAKE) install; fi
	@if command -v docker >/dev/null 2>&1 && ! docker image inspect happyclaw-agent:latest >/dev/null 2>&1; then echo "🐳 构建 Agent 容器镜像..."; ./container/build.sh; fi
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

clean: ## 清理构建产物
	rm -rf dist
	rm -rf web/dist
	rm -rf container/agent-runner/dist

reset-init: ## 完全重置为首装状态（清空所有运行时数据）
	rm -rf data store groups
	@echo "✅ 已完全重置为首装状态（数据库、配置、工作区、记忆、会话全部清除）"

# ─── Help ────────────────────────────────────────────────────

help: ## 显示帮助
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
