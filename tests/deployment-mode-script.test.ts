import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

// scripts/deployment-mode.mjs lets Makefile targets skip Docker in
// single-user host mode; it must resolve like src/deployment-mode.ts.
const script = path.resolve('scripts/deployment-mode.mjs');
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-mode-script-'));
  fs.mkdirSync(path.join(root, 'data', 'config'), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function run(env: Record<string, string> = {}): string {
  const { HAPPYCLAW_DEPLOYMENT_MODE: _ignored, ...base } = process.env;
  return execFileSync(process.execPath, [script, root], {
    env: { ...base, ...env },
    encoding: 'utf8',
  }).trim();
}

function settings(value: unknown): void {
  fs.writeFileSync(
    path.join(root, 'data', 'config', 'system-settings.json'),
    JSON.stringify(value),
  );
}

test('defaults to multi_user', () => {
  expect(run()).toBe('multi_user');
});

test('the stored setting wins over the environment and .env', () => {
  settings({ deploymentMode: 'single_user_host' });
  fs.writeFileSync(
    path.join(root, '.env'),
    'HAPPYCLAW_DEPLOYMENT_MODE=multi_user\n',
  );
  expect(run({ HAPPYCLAW_DEPLOYMENT_MODE: 'multi_user' })).toBe(
    'single_user_host',
  );
});

test('an unset setting falls back to the environment, then .env', () => {
  settings({ deploymentMode: '' });
  fs.writeFileSync(
    path.join(root, '.env'),
    "HAPPYCLAW_DEPLOYMENT_MODE='single_user_host'\n",
  );
  expect(run()).toBe('single_user_host');
  expect(run({ HAPPYCLAW_DEPLOYMENT_MODE: 'multi_user' })).toBe('multi_user');
});

test('unknown values are ignored', () => {
  settings({ deploymentMode: 'single' });
  expect(run({ HAPPYCLAW_DEPLOYMENT_MODE: 'nope' })).toBe('multi_user');
});

test('.env is read the way process.loadEnvFile reads it', () => {
  settings({ deploymentMode: '' });
  for (const line of [
    'HAPPYCLAW_DEPLOYMENT_MODE=single_user_host # chosen at install',
    'export HAPPYCLAW_DEPLOYMENT_MODE=single_user_host',
    'HAPPYCLAW_DEPLOYMENT_MODE="single_user_host"',
  ]) {
    fs.writeFileSync(path.join(root, '.env'), `# HappyClaw\n${line}\n`);
    expect(run(), line).toBe('single_user_host');
  }
  // A commented-out line is not a value.
  fs.writeFileSync(
    path.join(root, '.env'),
    '# HAPPYCLAW_DEPLOYMENT_MODE=single_user_host\n',
  );
  expect(run()).toBe('multi_user');
});
