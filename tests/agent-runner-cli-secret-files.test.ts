import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { writeCliSecretFiles } from '../container/agent-runner/src/cli-secret-files.js';

const roots: string[] = [];
function base(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-cli-files-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('writeCliSecretFiles', () => {
  test('writes private files the CLI can read and removes them', () => {
    const files = writeCliSecretFiles(
      { env: { ANTHROPIC_AUTH_TOKEN: 'secret' } },
      { remote: { type: 'http', url: 'http://x', headers: { k: 'v' } } },
      base(),
    );
    const dir = path.dirname(files.settingsPath);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(files.settingsPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(files.mcpConfigPath!).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(files.settingsPath, 'utf8'))).toEqual({
      env: { ANTHROPIC_AUTH_TOKEN: 'secret' },
    });
    expect(JSON.parse(fs.readFileSync(files.mcpConfigPath!, 'utf8'))).toEqual({
      mcpServers: {
        remote: { type: 'http', url: 'http://x', headers: { k: 'v' } },
      },
    });
    files.dispose();
    files.dispose();
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('skips the MCP file when there are no external servers', () => {
    const files = writeCliSecretFiles({}, {}, base());
    expect(files.mcpConfigPath).toBeUndefined();
    files.dispose();
  });

  test('cleans up when a value cannot be serialized', () => {
    const root = base();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => writeCliSecretFiles(cyclic, {}, root)).toThrow();
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
