import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function sessionSettingsFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'session-settings-retired-env-'),
  );
  directories.push(directory);
  const globals: Record<string, any> = {
    fs,
    path,
    crypto,
    randomUUID: crypto.randomUUID,
    process,
    JSON,
    Object,
    SyntaxError,
    Error,
  };
  const harness = createRuntimeSourceHarness(
    globals,
    new URL('../src/container-runner.ts', import.meta.url),
  );
  for (const name of [
    'REQUIRED_SETTINGS_ENV',
    'RETIRED_SETTINGS_ENV_KEYS',
    'isSettingsRecord',
    'mergeSettingsRecord',
    'removePreviousSettingsProjection',
    'readSettingsRecord',
    'writeAtomicFile',
    'ensureSettingsJson',
  ])
    harness.install(name);
  const target = path.join(directory, 'settings.json');
  return {
    target,
    write: (baseSettings: Record<string, unknown> = {}) =>
      globals.ensureSettingsJson(target, {}, { baseSettings }),
    read: () => JSON.parse(fs.readFileSync(target, 'utf8')),
  };
}

test('removes the attachment kill switch an older HappyClaw forced into session settings', () => {
  const f = sessionSettingsFixture();
  fs.writeFileSync(
    f.target,
    JSON.stringify({
      env: {
        CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CUSTOM: 'keep',
      },
    }),
  );

  f.write();

  const env = f.read().env;
  expect(env).not.toHaveProperty('CLAUDE_CODE_DISABLE_ATTACHMENTS');
  expect(env.CUSTOM).toBe('keep');
  expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('0');
});

test('never writes the attachment kill switch into a fresh session', () => {
  const f = sessionSettingsFixture();
  f.write();
  expect(f.read().env).not.toHaveProperty('CLAUDE_CODE_DISABLE_ATTACHMENTS');
});

test('keeps the key when the selected native settings layer sets it explicitly', () => {
  const f = sessionSettingsFixture();
  f.write({ env: { CLAUDE_CODE_DISABLE_ATTACHMENTS: '1' } });
  expect(f.read().env.CLAUDE_CODE_DISABLE_ATTACHMENTS).toBe('1');
});
