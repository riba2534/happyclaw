.PHONY: dev dev-backend dev-web build build-backend build-web start \
       typecheck typecheck-backend typecheck-web typecheck-agent-runner \
       format format-check install install-host-tools clean reset-init update-sdk ensure-latest-sdk sync-types \
       backup restore help _ensure-docker-image

# ─── Runtime Detection ──────────────────────────────────────
# 优先使用 bun（跳过编译、启动更快），fallback 到 npm + tsx + node
HAS_BUN := $(shell command -v bun >/dev/null 2>&1 && echo 1 || echo 0)

ifeq ($(HAS_BUN),1)
  PKG     := bun
  RUN     := bun
  RUNNER  := bun src/index.ts
  PKG_PFX  = cd $(1) && bun install
else
  PKG     := npm
  RUN     := npx
  RUNNER  := npx tsx src/index.ts
  PKG_PFX  = npm --prefix $(1) install
endif

# ─── Development ─────────────────────────────────────────────

dev: ## 启动前后端（首次自动安装依赖和构建容器镜像）
	@if [ ! -d node_modules ] || [ package.json -nt node_modules ] || [ web/package.json -nt web/node_modules ] || [ container/agent-runner/package.json -nt container/agent-runner/node_modules ]; then echo "📦 依赖有更新，安装依赖..."; $(MAKE) install; fi
	@$(MAKE) _ensure-docker-image
	@$(PKG) --prefix container/agent-runner run build --silent 2>/dev/null || $(PKG) --prefix container/agent-runner run build
	@echo "🚀 使用 $(PKG) 启动..."
	$(PKG) run dev:all

dev-backend: ## 仅启动后端（bun 直接跑 TS，node 用 tsx）
	$(RUNNER)

dev-web: ## 仅启动前端
	cd web && $(PKG) run dev

# ─── Build ───────────────────────────────────────────────────

build: sync-types ## 编译前后端及 agent-runner
	$(PKG) run build:all
	@touch .build-sentinel

build-backend: ## 仅编译后端
	$(PKG) run build

build-web: ## 仅编译前端
	cd web && $(PKG) run build

# ─── Production ──────────────────────────────────────────────

start: ensure-latest-sdk ## 一键启动生产环境
	@if [ ! -d node_modules ] || [ package.json -nt node_modules ] || [ web/package.json -nt web/node_modules ] || [ container/agent-runner/package.json -nt container/agent-runner/node_modules ]; then echo "📦 依赖有更新，安装依赖..."; $(MAKE) install; fi
	@$(MAKE) _ensure-docker-image
	@NEED_SYNC=0; \
	for target in src/stream-event.types.ts web/src/stream-event.types.ts container/agent-runner/src/stream-event.types.ts src/image-detector.ts container/agent-runner/src/image-detector.ts src/channel-prefixes.ts container/agent-runner/src/channel-prefixes.ts; do \
	  if [ ! -f "$$target" ] || [ -n "$$(find shared/ -newer "$$target" -name '*.ts' 2>/dev/null | head -1)" ]; then NEED_SYNC=1; break; fi; \
	done; \
	if [ "$$NEED_SYNC" = "1" ]; then echo "🔄 检测到 shared/ 类型变更，同步类型..."; $(MAKE) sync-types; fi
ifeq ($(HAS_BUN),1)
	@NEED_WEB=0; \
	if [ ! -f web/dist/index.html ]; then NEED_WEB=1; \
	else \
	  for f in web/package.json web/vite.config.ts web/index.html web/tsconfig.json; do \
	    if [ -f "$$f" ] && [ "$$f" -nt web/dist/index.html ]; then NEED_WEB=1; break; fi; \
	  done; \
	  if [ "$$NEED_WEB" = "0" ] && [ -n "$$(find web/src/ -newer web/dist/index.html \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) 2>/dev/null | head -1)" ]; then NEED_WEB=1; fi; \
	fi; \
	if [ "$$NEED_WEB" = "1" ]; then echo "🔨 检测到前端变更，重新编译前端..."; cd web && bun run build; else echo "✅ 前端无变更，跳过编译"; fi
	@NEED_AR=0; \
	if [ ! -f container/agent-runner/dist/.tsbuildinfo ]; then NEED_AR=1; \
	else \
	  for f in container/agent-runner/package.json container/agent-runner/tsconfig.json; do \
	    if [ -f "$$f" ] && [ "$$f" -nt container/agent-runner/dist/.tsbuildinfo ]; then NEED_AR=1; break; fi; \
	  done; \
	  if [ "$$NEED_AR" = "0" ] && [ -n "$$(find container/agent-runner/src/ -newer container/agent-runner/dist/.tsbuildinfo -name '*.ts' 2>/dev/null | head -1)" ]; then NEED_AR=1; fi; \
	fi; \
	if [ "$$NEED_AR" = "1" ]; then echo "🔨 检测到 agent-runner 变更，重新编译..."; cd container/agent-runner && bun run build; else echo "✅ agent-runner 无变更，跳过编译"; fi
	@echo "⚡ Bun 模式：直接运行 TypeScript，跳过后端编译"
	bun src/index.ts
else
	@NEED_SYNC=0; \
	for target in src/stream-event.types.ts web/src/stream-event.types.ts container/agent-runner/src/stream-event.types.ts src/image-detector.ts container/agent-runner/src/image-detector.ts src/channel-prefixes.ts container/agent-runner/src/channel-prefixes.ts; do \
	  if [ ! -f "$$target" ] || [ -n "$$(find shared/ -newer "$$target" -name '*.ts' 2>/dev/null | head -1)" ]; then NEED_SYNC=1; break; fi; \
	done; \
	if [ "$$NEED_SYNC" = "1" ]; then echo "🔄 检测到 shared/ 类型变更，同步类型..."; $(MAKE) sync-types; fi
	@NEED_BACKEND=0; \
	if [ ! -f dist/index.js ]; then NEED_BACKEND=1; \
	else \
	  for f in package.json tsconfig.json; do \
	    if [ "$$f" -nt dist/index.js ]; then NEED_BACKEND=1; break; fi; \
	  done; \
	  if [ "$$NEED_BACKEND" = "0" ] && [ -n "$$(find src/ -newer dist/index.js -name '*.ts' 2>/dev/null | head -1)" ]; then NEED_BACKEND=1; fi; \
	fi; \
	if [ "$$NEED_BACKEND" = "1" ]; then echo "🔨 检测到后端源码变更，重新编译后端..."; npm run build; else echo "✅ 后端无变更，跳过编译"; fi
	@NEED_WEB=0; \
	if [ ! -f web/dist/index.html ]; then NEED_WEB=1; \
	else \
	  for f in web/package.json web/vite.config.ts web/index.html web/tsconfig.json; do \
	    if [ -f "$$f" ] && [ "$$f" -nt web/dist/index.html ]; then NEED_WEB=1; break; fi; \
	  done; \
	  if [ "$$NEED_WEB" = "0" ] && [ -n "$$(find web/src/ -newer web/dist/index.html \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) 2>/dev/null | head -1)" ]; then NEED_WEB=1; fi; \
	fi; \
	if [ "$$NEED_WEB" = "1" ]; then echo "🔨 检测到前端变更，重新编译前端..."; cd web && npm run build; else echo "✅ 前端无变更，跳过编译"; fi
	@NEED_AR=0; \
	if [ ! -f container/agent-runner/dist/.tsbuildinfo ]; then NEED_AR=1; \
	else \
	  for f in container/agent-runner/package.json container/agent-runner/tsconfig.json; do \
	    if [ -f "$$f" ] && [ "$$f" -nt container/agent-runner/dist/.tsbuildinfo ]; then NEED_AR=1; break; fi; \
	  done; \
	  if [ "$$NEED_AR" = "0" ] && [ -n "$$(find container/agent-runner/src/ -newer container/agent-runner/dist/.tsbuildinfo -name '*.ts' 2>/dev/null | head -1)" ]; then NEED_AR=1; fi; \
	fi; \
	if [ "$$NEED_AR" = "1" ]; then echo "🔨 检测到 agent-runner 变更，重新编译..."; cd container/agent-runner && npm run build; else echo "✅ agent-runner 无变更，跳过编译"; fi
	node dist/index.js
endif

# ─── Quality ─────────────────────────────────────────────────

typecheck: sync-types typecheck-backend typecheck-web typecheck-agent-runner ## 全量类型检查
	@./scripts/check-stream-event-sync.sh

typecheck-backend:
	$(RUN) tsc --noEmit

typecheck-web:
	cd web && $(RUN) tsc --noEmit

typecheck-agent-runner:
	cd container/agent-runner && $(RUN) tsc --noEmit

test: ## 运行单元测试
ifeq ($(HAS_BUN),1)
	bun test
else
	$(RUN) vitest run
endif

format: ## 格式化代码
	$(PKG) run format

format-check: ## 检查代码格式
	$(PKG) run format:check

# ─── Docker Image ─────────────────────────────────────────────

# Docker 镜像源文件：Dockerfile、entrypoint.sh、agent-runner 源码
DOCKER_SRC := container/Dockerfile container/entrypoint.sh $(wildcard container/agent-runner/src/*.ts) $(wildcard container/agent-runner/prompts/*)

_ensure-docker-image: ## (内部) 检测 Docker 镜像是否需要构建/重建
	@if command -v docker >/dev/null 2>&1; then \
	  if ! docker image inspect happyclaw-agent:latest >/dev/null 2>&1; then \
	    echo "🐳 Docker 镜像不存在，正在构建..."; \
	    ./container/build.sh; \
	  elif [ ! -f .docker-build-sentinel ]; then \
	    echo "🐳 Docker 镜像 sentinel 缺失，正在重建..."; \
	    ./container/build.sh; \
	  else \
	    STALE=0; \
	    for f in $(DOCKER_SRC); do \
	      if [ "$$f" -nt .docker-build-sentinel ]; then STALE=1; break; fi; \
	    done; \
	    if [ "$$STALE" = "1" ]; then \
	      echo "🐳 检测到容器源码变更，正在重建 Docker 镜像..."; \
	      ./container/build.sh; \
	    else \
	      echo "✅ Docker 镜像无需重建"; \
	    fi; \
	  fi; \
	fi

# ─── Shared Types ────────────────────────────────────────────

sync-types: ## 同步 shared/ 下的类型定义到各子项目
	@./scripts/sync-stream-event.sh

# ─── SDK ─────────────────────────────────────────────────────

update-sdk: ## 更新 agent-runner 的 Claude Agent SDK 到最新版本
	cd container/agent-runner && $(PKG) update @anthropic-ai/claude-agent-sdk && $(PKG) run build
	@# npm/bun update 会将 "*" 回写为具体版本，还原它
	@sed -i '' 's/"@anthropic-ai\/claude-agent-sdk": "[^"]*"/"@anthropic-ai\/claude-agent-sdk": "*"/' container/agent-runner/package.json
	@echo "SDK updated. Run 'make typecheck' to verify."

ensure-latest-sdk: ## 启动前自动检测并更新 SDK（有新版才更新）
	@LOCAL=$$(node -p "require('./container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version" 2>/dev/null || echo "0.0.0"); \
	LATEST=$$(npm view @anthropic-ai/claude-agent-sdk version --fetch-timeout=5000 2>/dev/null || echo "$$LOCAL"); \
	if [ "$$LOCAL" != "$$LATEST" ]; then \
		echo "🔄 Claude Agent SDK 有新版本: $$LOCAL → $$LATEST，正在更新..."; \
		cd container/agent-runner && $(PKG) update @anthropic-ai/claude-agent-sdk && $(PKG) run build; \
		sed -i '' 's/"@anthropic-ai\/claude-agent-sdk": "[^"]*"/"@anthropic-ai\/claude-agent-sdk": "*"/' container/agent-runner/package.json; \
		echo "✅ SDK 更新完成（内置 Claude Code 版本随之更新）"; \
	else \
		echo "✅ Claude Agent SDK 已是最新 ($$LOCAL)"; \
	fi

# ─── Setup ───────────────────────────────────────────────────

install-host-tools: ## 安装宿主机模式所需的外部工具（feishu-cli、agent-browser、uv）+ 刷新 builtin-skills 缓存
	@./scripts/install-host-tools.sh

install: ## 安装全部依赖并编译 agent-runner
	$(PKG) install
	@# node-pty 的 spawn-helper 预构建二进制可能缺少可执行权限，导致 PTY 模式失败
	@chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper 2>/dev/null || true
	cd container/agent-runner && $(PKG) install
	cd container/agent-runner && $(PKG) run build
	cd web && $(PKG) install
	@touch node_modules web/node_modules container/agent-runner/node_modules

clean: ## 清理构建产物
	rm -rf dist
	rm -rf web/dist
	rm -rf container/agent-runner/dist
	rm -f .build-sentinel

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
	@echo "检测到运行时: $(if $(filter 1,$(HAS_BUN)),⚡ Bun,🟢 Node.js)"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
