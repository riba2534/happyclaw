#!/usr/bin/env node
// Print the effective deployment mode for Makefile targets (no dependencies,
// run from the repository root). Same per-key order as src/deployment-mode.ts:
// data/config/system-settings.json `deploymentMode`, then
// HAPPYCLAW_DEPLOYMENT_MODE (process env, then .env), then multi_user.
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

const MODES = new Set(['multi_user', 'single_user_host']);
const parse = (value) =>
  typeof value === 'string' && MODES.has(value.trim()) ? value.trim() : null;

function fromSettings(root) {
  try {
    const file = path.join(root, 'data', 'config', 'system-settings.json');
    return parse(JSON.parse(fs.readFileSync(file, 'utf8')).deploymentMode);
  } catch {
    return null;
  }
}

// The parser process.loadEnvFile() uses (src/load-env.ts), so quotes,
// inline comments and `export` read the same as in the server.
function fromDotEnv(root) {
  try {
    const text = fs.readFileSync(path.join(root, '.env'), 'utf8');
    return parse(parseEnv(text).HAPPYCLAW_DEPLOYMENT_MODE);
  } catch {
    return null;
  }
}

const root = process.argv[2] ?? process.cwd();
process.stdout.write(
  (fromSettings(root) ??
    parse(process.env.HAPPYCLAW_DEPLOYMENT_MODE) ??
    fromDotEnv(root) ??
    'multi_user') + '\n',
);
