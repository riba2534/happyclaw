import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'container-claude-json-'),
);
const homeDir = path.join(testRoot, 'home');
const dataDir = path.join(testRoot, 'data');
fs.mkdirSync(homeDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: dataDir,
  GROUPS_DIR: path.join(dataDir, 'groups'),
  STORE_DIR: path.join(dataDir, 'db'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const { getContainerClaudeJsonPath } =
  await import('../src/container-runner.js');
const hostJson = path.join(homeDir, '.claude.json');
const target = path.join(dataDir, 'config', 'container-claude-json.json');

/** The pre-change derivation, byte for byte. */
function formerContent(): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(hostJson, 'utf-8'));
    const stripped = { ...parsed };
    delete stripped.cachedGrowthBookFeatures;
    delete stripped.oauthAccount;
    stripped.autoUpdates = false;
    return JSON.stringify(stripped, null, 2) + '\n';
  } catch {
    return '{"hasCompletedOnboarding":true,"autoUpdates":false}\n';
  }
}

function writeHost(value: unknown): void {
  fs.writeFileSync(
    hostJson,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

/** Move mtimes out of the racy window so stat signatures can be trusted. */
function settle(...files: string[]): void {
  const past = new Date(Date.now() - 60_000);
  for (const file of files) fs.utimesSync(file, past, past);
}

function spyFs() {
  const readFileSync = vi.spyOn(fs, 'readFileSync');
  const writeFileSync = vi.spyOn(fs, 'writeFileSync');
  const renameSync = vi.spyOn(fs, 'renameSync');
  return {
    hostReads: () =>
      readFileSync.mock.calls.filter(([f]) => f === hostJson).length,
    targetReads: () =>
      readFileSync.mock.calls.filter(([f]) => f === target).length,
    directTargetWrites: () =>
      writeFileSync.mock.calls.filter(([f]) => f === target).length,
    renames: () => renameSync.mock.calls,
  };
}

const sampleHost = {
  userID: 'fake-user-id',
  numStartups: 3,
  cachedGrowthBookFeatures: { tengu_bridge_repl_v2: true },
  oauthAccount: { emailAddress: 'nobody@example.test' },
  projects: {
    '/tmp/p': { allowedTools: [], history: [{ display: 'héllo ✓' }] },
  },
};

beforeEach(() => {
  vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
  fs.rmSync(path.join(dataDir, 'config'), { recursive: true, force: true });
  writeHost(sampleHost);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe('container .claude.json copy', () => {
  test.each([
    ['a normal host file', sampleHost],
    ['a host file with nothing to strip', { userID: 'x' }],
    ['JSON null', 'null'],
    ['a JSON array', '[1,2]'],
    ['invalid JSON', '{"userID":'],
  ])('derives the same bytes as before from %s', (_name, value) => {
    writeHost(value);
    expect(getContainerClaudeJsonPath()).toBe(target);
    expect(fs.readFileSync(target, 'utf8')).toBe(formerContent());
  });

  test('a missing host file yields the onboarding stub', () => {
    fs.rmSync(hostJson);
    getContainerClaudeJsonPath();
    expect(fs.readFileSync(target, 'utf8')).toBe(
      '{"hasCompletedOnboarding":true,"autoUpdates":false}\n',
    );
  });

  test('an unchanged host file is neither re-read nor rewritten', () => {
    getContainerClaudeJsonPath();
    settle(hostJson, target);
    getContainerClaudeJsonPath(); // revalidates both settled signatures
    const inode = fs.statSync(target).ino;
    const io = spyFs();
    for (let i = 0; i < 5; i++) getContainerClaudeJsonPath();
    expect(io.hostReads()).toBe(0);
    expect(io.targetReads()).toBe(0);
    expect(io.renames()).toHaveLength(0);
    expect(io.directTargetWrites()).toBe(0);
    expect(fs.statSync(target).ino).toBe(inode);
  });

  test('a host change is written atomically via a temp file and rename', () => {
    getContainerClaudeJsonPath();
    settle(hostJson, target);
    getContainerClaudeJsonPath();
    const inode = fs.statSync(target).ino;
    const io = spyFs();

    writeHost({ ...sampleHost, numStartups: 4 });
    getContainerClaudeJsonPath();

    expect(io.directTargetWrites()).toBe(0);
    expect(io.renames()).toHaveLength(1);
    const [from, to] = io.renames()[0];
    expect(to).toBe(target);
    expect(path.dirname(String(from))).toBe(path.dirname(target));
    expect(fs.statSync(target).ino).not.toBe(inode);
    expect(fs.readFileSync(target, 'utf8')).toBe(formerContent());
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).numStartups).toBe(4);
    expect(
      fs.readdirSync(path.dirname(target)).filter((f) => f.endsWith('.tmp')),
    ).toEqual([]);
  });

  test('a host change that strips to the same bytes does not rewrite', () => {
    getContainerClaudeJsonPath();
    const inode = fs.statSync(target).ino;
    const io = spyFs();
    writeHost({
      ...sampleHost,
      cachedGrowthBookFeatures: { other_flag: false },
    });
    getContainerClaudeJsonPath();
    expect(io.hostReads()).toBe(1);
    expect(io.renames()).toHaveLength(0);
    expect(fs.statSync(target).ino).toBe(inode);
  });

  test('a same-size host rewrite right after a launch is picked up', () => {
    writeHost({ ...sampleHost, userID: 'AAAA' });
    getContainerClaudeJsonPath();
    writeHost({ ...sampleHost, userID: 'BBBB' });
    getContainerClaudeJsonPath();
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).userID).toBe('BBBB');
  });

  test('a removed or externally edited copy is restored', () => {
    getContainerClaudeJsonPath();
    const expected = formerContent();
    fs.rmSync(target);
    getContainerClaudeJsonPath();
    expect(fs.readFileSync(target, 'utf8')).toBe(expected);

    settle(hostJson, target);
    getContainerClaudeJsonPath();
    fs.writeFileSync(target, '{"tampered":true}\n');
    getContainerClaudeJsonPath();
    expect(fs.readFileSync(target, 'utf8')).toBe(expected);
  });

  test('a failed write still falls back to the stub, as before', () => {
    getContainerClaudeJsonPath();
    writeHost({ ...sampleHost, numStartups: 9 });
    const realWrite = fs.writeFileSync;
    let failed = false;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, opts) => {
      if (!failed && String(file).startsWith(`${target}.`)) {
        failed = true;
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return realWrite(file, data, opts);
    });
    getContainerClaudeJsonPath();
    expect(failed).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe(
      '{"hasCompletedOnboarding":true,"autoUpdates":false}\n',
    );
    expect(
      fs.readdirSync(path.dirname(target)).filter((f) => f.endsWith('.tmp')),
    ).toEqual([]);
  });
});
