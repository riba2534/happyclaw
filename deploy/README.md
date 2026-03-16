# HappyClaw deployment assets

## Files

- `../.env.example`: production environment template
- `bin/doctor.sh`: verify host prerequisites
- `bin/build-production.sh`: install dependencies and build backend/web artifacts
- `bin/build-agent-image.sh`: build the agent container image with `CONTAINER_IMAGE`
- `bin/start-production.sh`: start the production server from built artifacts
- `bin/healthcheck.sh`: verify the HTTP endpoint is reachable
- `systemd/happyclaw.service`: systemd unit template
- `nginx/happyclaw.conf`: nginx reverse proxy template

## Recommended flow

```bash
cp .env.example .env.production
vim .env.production

./deploy/bin/doctor.sh
./deploy/bin/build-production.sh
./deploy/bin/start-production.sh
```

## Host prerequisites

- Node.js 20+
- npm
- make
- Python 3.8+ for `node-gyp` native module builds
- Docker, if container mode is required

If the system Python is too old, set `PYTHON_FOR_BUILD=/path/to/python3` in `.env.production` and `build-production.sh` will export it to `npm`/`node-gyp`.
If the default GCC is too old for native modules, set `CC=clang-11` and `CXX=clang++-11` in `.env.production`.

For long-running production, install `deploy/systemd/happyclaw.service` and put nginx in front of HappyClaw.
