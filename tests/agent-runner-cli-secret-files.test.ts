import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  sweepOrphanCliSecretDirs,
  writeCliSecretFiles,
} from '../container/agent-runner/src/cli-secret-files.js';

const roots: string[] = [];
function base(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-cli-files-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const moduleUrl = pathToFileURL(
  path.resolve('container/agent-runner/src/cli-secret-files.ts'),
).href;

/**
 * A Runner stand-in in its own process: writes the files for a query, then
 * waits as if the CLI were still running. Its SIGTERM handler ends in
 * process.exit() like the Runner's, so the query's finally never runs.
 */
async function startQueryInFlight(root: string) {
  const scripts = base();
  const script = path.join(scripts, 'query-in-flight.mts');
  fs.writeFileSync(
    script,
    `import path from 'node:path';
import { writeCliSecretFiles } from ${JSON.stringify(moduleUrl)};
process.on('SIGTERM', () => process.exit(0));
const files = writeCliSecretFiles(
  { env: { ANTHROPIC_AUTH_TOKEN: 'secret' } },
  { remote: { type: 'http', url: 'http://x', headers: { k: 'v' } } },
  process.argv[2],
);
console.log(JSON.stringify({ dir: path.dirname(files.settingsPath) }));
setInterval(() => {}, 60_000);
`,
  );
  // `--import tsx` keeps the script in this one process; the tsx CLI would
  // put a wrapper process in front of it.
  const child = spawn(process.execPath, ['--import', 'tsx', script, root], {
    cwd: path.resolve('.'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const dir = await new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const line = out.split('\n')[0];
      if (out.includes('\n')) resolve(JSON.parse(line).dir as string);
    });
    child.once('exit', (code) =>
      reject(new Error(`child exited ${code} before writing: ${stderr}`)),
    );
  });
  return { child, dir, exited };
}

describe('writeCliSecretFiles', () => {
  test('writes private files the CLI can read and removes them', () => {
    const files = writeCliSecretFiles(
      { env: { ANTHROPIC_AUTH_TOKEN: 'secret' } },
      { remote: { type: 'http', url: 'http://x', headers: { k: 'v' } } },
      base(),
    );
    const dir = path.dirname(files.settingsPath);
    expect(path.basename(dir)).toMatch(
      new RegExp(`^happyclaw-cli-${process.pid}-`),
    );
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

  test('a failed removal is logged, not thrown over the query result', () => {
    const files = writeCliSecretFiles({}, {}, base());
    const rm = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => files.dispose()).not.toThrow();
    expect(stderr.mock.calls.join('\n')).toContain('busy');
    rm.mockRestore();
    files.dispose();
    expect(fs.existsSync(path.dirname(files.settingsPath))).toBe(false);
  });

  test('a Runner stopped by SIGTERM mid-query leaves no files behind', async () => {
    const root = base();
    const { child, dir, exited } = await startQueryInFlight(root);
    expect(path.basename(dir)).toMatch(
      new RegExp(`^happyclaw-cli-${child.pid}-`),
    );
    expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(true);
    child.kill('SIGTERM');
    await exited;
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  }, 30_000);
});

describe('sweepOrphanCliSecretDirs', () => {
  test('removes what a SIGKILLed Runner left and keeps everything else', async () => {
    const root = base();
    const { child, dir: orphan, exited } = await startQueryInFlight(root);
    child.kill('SIGKILL');
    await exited;
    // Nothing in the process can run on SIGKILL: the next Runner sweeps.
    expect(fs.existsSync(path.join(orphan, 'settings.json'))).toBe(true);

    const live = path.join(root, `happyclaw-cli-${process.pid}-live01`);
    const otherPrefix = path.join(root, `happyclaw-other-${child.pid}-abc123`);
    const notADir = path.join(root, `happyclaw-cli-${child.pid}-file01`);
    const linked = path.join(root, `happyclaw-cli-${child.pid}-link01`);
    const linkTarget = path.join(base(), 'target');
    fs.mkdirSync(live);
    fs.writeFileSync(path.join(live, 'settings.json'), '{}');
    fs.mkdirSync(otherPrefix);
    fs.writeFileSync(notADir, '');
    fs.mkdirSync(linkTarget);
    fs.writeFileSync(path.join(linkTarget, 'keep'), '');
    fs.symlinkSync(linkTarget, linked);

    expect(sweepOrphanCliSecretDirs(root)).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(path.join(live, 'settings.json'))).toBe(true);
    expect(fs.existsSync(otherPrefix)).toBe(true);
    expect(fs.existsSync(notADir)).toBe(true);
    expect(fs.existsSync(path.join(linkTarget, 'keep'))).toBe(true);
  }, 30_000);

  test('a missing temp root is not an error', () => {
    expect(sweepOrphanCliSecretDirs(path.join(base(), 'missing'))).toBe(0);
  });
});
