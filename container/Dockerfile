# HappyClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with full toolchain

FROM node:22-slim

# Copy uv from official image (multi-arch, no extra download)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
COPY --from=ghcr.io/astral-sh/uv:latest /uvx /usr/local/bin/uvx

# Install system packages (organized by category)
RUN apt-get update && apt-get install -y --no-install-recommends \
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

# Locale environment
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Allow pip install without venv (Debian 12+ PEP 668) and add user bin to PATH
ENV PIP_BREAK_SYSTEM_PACKAGES=1
ENV PATH="/home/node/.local/bin:${PATH}"

# Create app directory
WORKDIR /app

# Copy package.json only — no lock file so "*" always resolves to latest SDK
COPY agent-runner/package.json ./

# CACHEBUST after COPY ensures both global and local npm install are cache-busted
# (COPY caches on file content hash, which blocks ARG invalidation propagation)
ARG CACHEBUST=1
RUN npm install -g agent-browser @anthropic-ai/claude-code
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/memory /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Sources env from mounted /workspace/env-dir/env if it exists (keeps credentials out of process listings)
# Stdin is buffered to /tmp then piped (container requires EOF to flush stdin pipe)
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\nif [ -f /workspace/env-dir/env ]; then\n  set -a\n  source /workspace/env-dir/env\n  set +a\nfi\nmkdir -p /home/node/.claude/skills 2>/dev/null || true\n[ -d /workspace/project-skills ] && ln -sf /workspace/project-skills/* /home/node/.claude/skills/ 2>/dev/null || true\n[ -d /workspace/user-skills ] && ln -sf /workspace/user-skills/* /home/node/.claude/skills/ 2>/dev/null || true\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace

# Install oh-my-zsh for node user (ys theme)
RUN su - node -c 'sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended' \
    && sed -i 's/ZSH_THEME="robbyrussell"/ZSH_THEME="ys"/' /home/node/.zshrc \
    && chsh -s /bin/zsh node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
