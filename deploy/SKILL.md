---
name: happyclaw-deploy
description: Prepare, build, deploy, and verify the HappyClaw project on a self-hosted Linux server. Use when working on HappyClaw environment setup, production build delivery, systemd service installation, nginx reverse proxying, container image preparation, or deployment troubleshooting without changing application source code.
---

# HappyClaw Deploy

Follow the repository deployment assets instead of inventing a new process.

## Quick Start

1. Run `./deploy/bin/doctor.sh` from the repository root to verify the host.
2. Copy `.env.example` to `.env.production` and fill in deployment-specific values.
3. Run `./deploy/bin/build-production.sh` to install dependencies and build production artifacts.
4. Run `./deploy/bin/start-production.sh` for a foreground smoke test.
5. Run `./deploy/bin/healthcheck.sh` after startup.
6. For long-running production, install `deploy/systemd/happyclaw.service` and `deploy/nginx/happyclaw.conf`.

## Workflow

### 1. Confirm prerequisites

- Prefer Linux hosts with `systemd` and `nginx`.
- Require Node.js 20+, `npm`, `make`, and `python3 >= 3.8`.
- Require Docker only when member users need container mode.
- Use [`references/linux-self-hosting.md`](references/linux-self-hosting.md) when you need the full checklist.
- Use `./deploy/bin/doctor.sh` for the actual host check.

### 2. Configure environment

- Treat `.env.example` as the committed template.
- Put operator-specific values in `.env.production`.
- Keep `NODE_ENV=production` for production runs.
- Set `TRUST_PROXY=true` when traffic passes through nginx, Caddy, Cloudflare, or another reverse proxy.
- Set `WEB_SESSION_SECRET` only when the operator wants an externally managed secret; otherwise HappyClaw persists one under `data/config/session-secret.key`.
- Prefer the Web setup wizard for Claude and IM provider secrets; only preseed env vars when bootstrapping is required.

### 3. Build artifacts

- Use `./deploy/bin/build-production.sh` as the default build entrypoint.
- Let that script install dependencies with `npm ci`, build backend/web/agent-runner artifacts, and optionally build the agent image.
- Use `BUILD_AGENT_IMAGE=false ./deploy/bin/build-production.sh` when Docker is intentionally unavailable.
- Use `./deploy/bin/build-agent-image.sh` when the image must be rebuilt separately or `CONTAINER_IMAGE` changed.

### 4. Run and verify

- Use `./deploy/bin/start-production.sh` for foreground startup.
- Use `./deploy/bin/healthcheck.sh` to verify the HTTP endpoint after the process is up.
- If the healthcheck fails, inspect `.env.production`, `WEB_PORT`, reverse proxy config, and whether `web/dist` and `dist/index.js` exist.

### 5. Install process supervision

- Use `deploy/systemd/happyclaw.service` as the base template.
- Adjust `User`, `Group`, `WorkingDirectory`, `EnvironmentFile`, and `ExecStart` to match the target host.
- Keep build and run separated: build first, then let systemd only run `deploy/bin/start-production.sh`.
- Put nginx in front of the service with `deploy/nginx/happyclaw.conf` and update `server_name`.

## Constraints

- Do not modify `src/`, `web/src/`, or other application source files just to make deployment easier unless the user explicitly asks for code changes.
- Prefer documenting or templating operational configuration in `deploy/`, `.env.example`, or other repo-local deployment docs.
- Preserve the existing `make start` workflow for local one-shot startup; use dedicated deployment scripts for production.

## Resources

- [`deploy/README.md`](README.md): deployment assets overview.
- [`references/linux-self-hosting.md`](references/linux-self-hosting.md): Linux deployment checklist and decision points.
