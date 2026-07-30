# HappyClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with full toolchain

FROM node:24-slim

# The publish workflow sets this to the main-branch commit SHA. Writing it into
# the first layer intentionally invalidates all downstream "latest" tool
# installs on every main push, while still allowing exact-version overrides for
# local or incident-response builds.
ARG TOOL_REFRESH=manual

# Install system packages (organized by category)
# Debian packages intentionally follow the current signed stable repositories,
# so a refreshed build receives the newest security and bug-fix packages.
RUN printf '%s\n' "$TOOL_REFRESH" > /etc/happyclaw-tool-refresh \
    && apt-get update && apt-get install -y --no-install-recommends \
    # --- Browser & fonts ---
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    # --- Chromium shared library deps ---
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    # --- Build tools & compilers ---
    build-essential \
    cmake \
    pkg-config \
    # --- Python ecosystem ---
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    # --- Core CLI tools ---
    curl \
    wget \
    git \
    zsh \
    jq \
    tree \
    file \
    less \
    bc \
    patch \
    rsync \
    # --- Compression ---
    zip \
    unzip \
    xz-utils \
    bzip2 \
    # --- Network ---
    openssh-client \
    dnsutils \
    iputils-ping \
    # --- Process & system ---
    procps \
    lsof \
    # --- Text search & dev ---
    ripgrep \
    fd-find \
    shellcheck \
    # --- Multimedia ---
    ffmpeg \
    imagemagick \
    ghostscript \
    graphviz \
    # --- Document & PDF ---
    poppler-utils \
    pandoc \
    # --- Database clients ---
    sqlite3 \
    default-mysql-client \
    postgresql-client \
    redis-tools \
    # --- Locale ---
    locales \
    && rm -rf /var/lib/apt/lists/* \
    # Set up UTF-8 locale
    && sed -i '/en_US.UTF-8/s/^# //' /etc/locale.gen && locale-gen \
    # Symlink fd-find → fd (Debian names it fdfind)
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd

# Pull the newest stable multi-arch uv release. The publish workflow uses
# `pull: true`, and TOOL_REFRESH prevents a stale cached COPY layer.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
COPY --from=ghcr.io/astral-sh/uv:latest /uvx /usr/local/bin/uvx

# Locale environment
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Set Chromium path for agent-browser. The entrypoint starts a managed
# headless Chromium instance on this container-local CDP port, and
# agent-browser attaches to it instead of launching a second browser with a
# random debugging port.
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV HAPPYCLAW_CHROMIUM_CDP_HOST=127.0.0.1
ENV HAPPYCLAW_CHROMIUM_CDP_PORT=9222
ENV AGENT_BROWSER_CDP=9222
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Allow pip install without venv (Debian 12+ PEP 668) and add user bin to PATH
ENV PIP_BREAK_SYSTEM_PACKAGES=1
ENV PATH="/home/node/.local/bin:${PATH}"

# Create app directory
WORKDIR /app

# Start with the committed dependency graph so application dependencies stay
# deterministic and package.json/package-lock.json drift still fails fast.
COPY agent-runner/package.json agent-runner/package-lock.json ./

# Runtime tools default to their newest npm releases at image-build time. Exact
# versions remain available as build args for rollback/reproduction. These are
# deliberately installed without rewriting the committed lockfile.
ARG CLAUDE_AGENT_SDK_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest
ARG AGENT_BROWSER_VERSION=latest
RUN npm ci \
    && npm install --no-save --package-lock=false \
      "@anthropic-ai/claude-agent-sdk@${CLAUDE_AGENT_SDK_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "agent-browser@${AGENT_BROWSER_VERSION}" \
    && npm cache clean --force \
    && ln -s /app/node_modules/.bin/agent-browser /usr/local/bin/agent-browser \
    && node -e "const fs=require('node:fs'); for (const p of ['@anthropic-ai/claude-agent-sdk','@anthropic-ai/claude-code','agent-browser']) { const j=JSON.parse(fs.readFileSync('/app/node_modules/'+p+'/package.json','utf8')); console.log(p+' '+j.version); }"

# Headroom (https://github.com/chopratejas/headroom) - 工具输出/RAG/日志压缩.
# 装上 binary 但默认不启用——用户在 /mcp-servers 自行添加才生效, 配置:
#   { "command": "headroom", "args": ["mcp", "serve"] }
# 只选 [code,mcp] 两个 extras: [memory] 通过 sentence-transformers 强依赖
# torch + CUDA (cudnn-cu12, cublas, cusparse, cusolver, nccl, triton...),
# 压缩包就 ~2.45GB, 解包 3-6GB 量级. HappyClaw 容器无 GPU, 也不需要语义
# embedding 类 retrieve. 用户如真需要 headroom 的 memory 能力, 可在容器内
# 单独 `pip install --index-url https://download.pytorch.org/whl/cpu torch`
# 再 `pip install "headroom-ai[memory]"` 走 CPU 路径. PIP_BREAK_SYSTEM_PACKAGES
# 已在上方设置, 这里无需再传 --break-system-packages.
# 默认安装 PyPI 最新稳定版；可用 HEADROOM_VERSION 精确回退。继续只安装
# [code,mcp]，避免 [memory] 的 GPU/torch 依赖把镜像额外撑大数 GB。
ARG HEADROOM_VERSION=latest
RUN set -eu; \
    if [ "$HEADROOM_VERSION" = latest ]; then \
      HEADROOM_SPEC='headroom-ai[code,mcp]'; \
    else \
      HEADROOM_SPEC="headroom-ai[code,mcp]==${HEADROOM_VERSION}"; \
    fi; \
    pip install --no-cache-dir --upgrade "$HEADROOM_SPEC"; \
    python3 -c "from importlib.metadata import version; print('headroom-ai', version('headroom-ai'))"

# Resolve the newest stable feishu-cli GitHub release by default, then verify
# the selected archive against the checksums file published with that release.
# An exact vX.Y.Z tag can be supplied through FEISHU_CLI_VERSION for rollback.
ARG TARGETARCH
ARG FEISHU_CLI_VERSION=latest
RUN set -eu && \
    ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" && \
    case "$ARCH" in \
      amd64|arm64) ;; \
      *) echo "ERROR: unsupported feishu-cli architecture: $ARCH" >&2; exit 1 ;; \
    esac && \
    DOWNLOAD_TMP="$(mktemp -d)" && \
    if [ "$FEISHU_CLI_VERSION" = latest ]; then \
      RELEASE_URL='https://github.com/riba2534/feishu-cli/releases/latest/download'; \
    else \
      RELEASE_URL="https://github.com/riba2534/feishu-cli/releases/download/${FEISHU_CLI_VERSION}"; \
    fi && \
    curl -fsSL --retry 3 \
      -o "$DOWNLOAD_TMP/checksums.txt" "$RELEASE_URL/checksums.txt" && \
    if [ "$FEISHU_CLI_VERSION" = latest ]; then \
      ARCHIVE="$(awk -v arch="$ARCH" \
        '$2 ~ ("^feishu-cli_v[0-9.]+_linux-" arch "\\.tar\\.gz$") { print $2; exit }' \
        "$DOWNLOAD_TMP/checksums.txt")"; \
      test -n "$ARCHIVE"; \
      RELEASE_TAG="${ARCHIVE#feishu-cli_}"; \
      RELEASE_TAG="${RELEASE_TAG%_linux-*}"; \
    else \
      RELEASE_TAG="$FEISHU_CLI_VERSION"; \
      ARCHIVE="feishu-cli_${RELEASE_TAG}_linux-${ARCH}.tar.gz"; \
    fi && \
    echo "Installing feishu-cli $RELEASE_TAG for $ARCH" && \
    curl -fsSL --retry 3 \
      -o "$DOWNLOAD_TMP/$ARCHIVE" "$RELEASE_URL/$ARCHIVE" && \
    grep -F "  $ARCHIVE" "$DOWNLOAD_TMP/checksums.txt" \
      > "$DOWNLOAD_TMP/checksum.txt" && \
    (cd "$DOWNLOAD_TMP" && sha256sum -c checksum.txt) && \
    tar -xzf "$DOWNLOAD_TMP/$ARCHIVE" --strip-components=1 -C /usr/local/bin && \
    feishu-cli --version && \
    printf '%s\n' "$RELEASE_TAG" > /usr/local/share/feishu-cli-version && \
    rm -rf "$DOWNLOAD_TMP"

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories. Long-term memory is host-managed and workspace
# scoped; legacy global/memory filesystem roots must not exist in the runtime.
RUN mkdir -p /workspace/group /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Copy entrypoint script (runs as root, drops to node user via runuser)
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace

# Install the newest oh-my-zsh master snapshot by default. An exact tag or
# commit can be passed through OH_MY_ZSH_REF when reproducing an older image.
ARG OH_MY_ZSH_REF=master
RUN set -eu; \
    mkdir -p /home/node/.oh-my-zsh; \
    git -C /home/node/.oh-my-zsh init; \
    git -C /home/node/.oh-my-zsh remote add origin \
      https://github.com/ohmyzsh/ohmyzsh.git; \
    git -C /home/node/.oh-my-zsh fetch --depth 1 origin "$OH_MY_ZSH_REF"; \
    git -C /home/node/.oh-my-zsh checkout --detach FETCH_HEAD; \
    git -C /home/node/.oh-my-zsh rev-parse HEAD \
      > /usr/local/share/oh-my-zsh-version; \
    rm -rf /home/node/.oh-my-zsh/.git; \
    cp /home/node/.oh-my-zsh/templates/zshrc.zsh-template /home/node/.zshrc; \
    sed -i 's/ZSH_THEME="robbyrussell"/ZSH_THEME="ys"/' /home/node/.zshrc; \
    chown -R node:node /home/node/.oh-my-zsh /home/node/.zshrc; \
    chsh -s /bin/zsh node

# Keep an in-image audit record of every dynamically resolved tool version.
# This can be inspected without relying on transient GitHub Actions logs:
#   cat /usr/local/share/happyclaw-tool-versions.txt
RUN set -eu; \
    { \
      printf 'tool_refresh=%s\n' "$TOOL_REFRESH"; \
      printf 'node=%s\n' "$(node --version)"; \
      printf 'npm=%s\n' "$(npm --version)"; \
      printf 'uv=%s\n' "$(uv --version | awk '{print $2}')"; \
      node -e "const fs=require('node:fs'); for (const p of ['@anthropic-ai/claude-agent-sdk','@anthropic-ai/claude-code','agent-browser']) { const j=JSON.parse(fs.readFileSync('/app/node_modules/'+p+'/package.json','utf8')); console.log(p+'='+j.version); }"; \
      printf 'feishu-cli=%s\n' "$(cat /usr/local/share/feishu-cli-version)"; \
      printf 'headroom=%s\n' "$(python3 -c "from importlib.metadata import version; print(version('headroom-ai'))")"; \
      printf 'chromium=%s\n' "$(chromium --version | awk '{print $2}')"; \
      printf 'oh-my-zsh=%s\n' "$(cat /usr/local/share/oh-my-zsh-version)"; \
    } > /usr/local/share/happyclaw-tool-versions.txt; \
    cat /usr/local/share/happyclaw-tool-versions.txt

# Entrypoint runs as root to fix volume permissions, then drops to node user.
# Do NOT add USER node here — entrypoint handles the privilege drop.
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
