# Linux self-hosting checklist

## Scope

Use this reference when deploying HappyClaw on a Linux host with systemd and nginx.

## Checklist

1. Ensure Node.js 20+ is installed.
2. Ensure npm, make, and Python 3.8+ are available.
3. Install Docker if member users need container mode.
4. Copy `.env.example` to `.env.production` and set `NODE_ENV=production`.
5. Set `TRUST_PROXY=true` if nginx or another reverse proxy terminates traffic.
6. Run `./deploy/bin/doctor.sh` before building.
7. Run `./deploy/bin/build-production.sh` after dependency or lockfile changes.
8. Run `./deploy/bin/build-agent-image.sh` if `CONTAINER_IMAGE` changed or the agent image needs refresh.
9. Start with `./deploy/bin/start-production.sh` for manual verification.
10. Install `deploy/systemd/happyclaw.service` for process supervision.
11. Install `deploy/nginx/happyclaw.conf` and reload nginx.
12. Verify `./deploy/bin/healthcheck.sh` succeeds.

## Notes

- `make start` is convenient for first-run local usage, but the dedicated scripts are better for production because they separate build and run.
- The frontend is served from `web/dist` by the backend in production.
- Runtime state is stored in `data/`; back it up before host migrations.
