import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

type Surface =
  | 'workspace-settings'
  | 'workspace-meta'
  | 'session-settings'
  | 'session-oauth';
const surfaces: Surface[] = [
  'workspace-settings',
  'workspace-meta',
  'session-settings',
  'session-oauth',
];

function fixture(surface: Surface) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'config-atomic-preservation-'),
  );
  directories.push(directory);
  const globals: Record<string, any> = {
    fs,
    path,
    crypto,
    randomUUID: crypto.randomUUID,
    process,
    JSON,
    SyntaxError,
    Error,
    GROUPS_DIR: directory,
  };
  const workspace = surface.startsWith('workspace');
  const harness = createRuntimeSourceHarness(
    globals,
    new URL(
      workspace
        ? '../src/routes/workspace-config.ts'
        : '../src/container-runner.ts',
      import.meta.url,
    ),
  );
  const session = path.join(directory, 'workspace', '.claude');
  fs.mkdirSync(session, { recursive: true });
  const group = { folder: 'workspace', jid: 'web:workspace' };
  const record = {
    permissions: { allow: ['Read'] },
    hooks: { Stop: [] },
    env: { CUSTOM: 'keep' },
    userID: 'keep',
    projects: { fixture: {} },
    oauthAccount: { emailAddress: 'fixture@example.invalid' },
    mcpServers: {
      disabled: {
        enabled: false,
        command: 'fixture',
        env: { TOKEN: 'preserve' },
        headers: { Authorization: 'preserve' },
      },
    },
  };
  let target: string;
  let write: () => void;
  if (workspace) {
    for (const name of [
      'getWorkspaceRoot',
      'getWorkspaceClaudeDir',
      'getWorkspaceSettingsPath',
      'getWorkspaceMcpMetaPath',
      'writeWorkspaceMeta',
      'writeWorkspaceSettings',
    ])
      harness.install(name);
    target = path.join(
      session,
      surface === 'workspace-meta'
        ? 'happyclaw-workspace.json'
        : 'settings.json',
    );
    write = () =>
      globals[
        surface === 'workspace-meta'
          ? 'writeWorkspaceMeta'
          : 'writeWorkspaceSettings'
      ](group, record);
  } else if (surface === 'session-settings') {
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
    target = path.join(session, 'settings.json');
    write = () =>
      globals.ensureSettingsJson(
        target,
        {},
        { baseSettings: { env: { BASE: 'selected' } } },
      );
  } else {
    harness.install('clearSessionClaudeOAuthFiles');
    target = path.join(session, '.claude.json');
    write = () => globals.clearSessionClaudeOAuthFiles(session);
  }
  return { session, target, write, record, globals };
}

test.each(surfaces)(
  '%s keeps the previous JSON after a short temp write and removes only its own temp',
  (surface) => {
    const f = fixture(surface);
    const original = JSON.stringify(f.record);
    fs.writeFileSync(f.target, original);
    const planted = path.join(f.session, 'unrelated.tmp');
    fs.writeFileSync(planted, 'SENTINEL');
    const write = fs.writeFileSync;
    let injected = false;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (
        !injected &&
        typeof file === 'string' &&
        file.endsWith('.tmp') &&
        file !== planted
      ) {
        injected = true;
        write(file, String(data).slice(0, 12), options);
        throw Object.assign(new Error('Simulated short write'), {
          code: 'EIO',
        });
      }
      return write(file, data, options);
    });
    expect(f.write).toThrow(/short write/);
    expect(injected).toBe(true);
    expect(fs.readFileSync(f.target, 'utf8')).toBe(original);
    expect(
      fs.readdirSync(f.session).filter((name) => name.endsWith('.tmp')),
    ).toEqual(['unrelated.tmp']);
    expect(fs.readFileSync(planted, 'utf8')).toBe('SENTINEL');
  },
);

test.each(surfaces)(
  '%s preserves already torn JSON without a destructive fallback',
  (surface) => {
    const f = fixture(surface);
    fs.writeFileSync(f.target, '{"torn":');
    if (surface.startsWith('workspace')) expect(f.write).toThrow(SyntaxError);
    else expect(f.write).not.toThrow();
    expect(fs.readFileSync(f.target, 'utf8')).toBe('{"torn":');
    expect(fs.readdirSync(f.session)).toEqual([path.basename(f.target)]);
  },
);

test.each(surfaces)('%s keeps the existing ENOENT compatibility', (surface) => {
  const f = fixture(surface);
  f.write();
  expect(fs.existsSync(f.target)).toBe(surface !== 'session-oauth');
});

test.each(surfaces)(
  '%s preserves valid session-owned fields when updating',
  (surface) => {
    const f = fixture(surface);
    fs.writeFileSync(f.target, JSON.stringify(f.record));
    f.write();
    const saved = JSON.parse(fs.readFileSync(f.target, 'utf8'));
    expect(saved.permissions).toEqual(f.record.permissions);
    expect(saved.hooks).toEqual(f.record.hooks);
    expect(saved.env.CUSTOM).toBe('keep');
    if (surface === 'session-settings') expect(saved.env.BASE).toBe('selected');
    else
      expect(saved.mcpServers.disabled).toEqual(f.record.mcpServers.disabled);
    if (surface === 'session-oauth') {
      expect(saved).not.toHaveProperty('oauthAccount');
      expect(saved.userID).toBe('keep');
      expect(saved.projects).toEqual(f.record.projects);
    }
    expect(
      fs.readdirSync(f.session).some((name) => name.endsWith('.tmp')),
    ).toBe(false);
  },
);

test('OAuth clearing detaches a session symlink without writing through to its host template', () => {
  const f = fixture('session-oauth');
  const template = path.join(f.session, 'host-template.json');
  const original = JSON.stringify(f.record);
  fs.writeFileSync(template, original);
  fs.symlinkSync(template, f.target);
  f.write();
  expect(fs.readFileSync(template, 'utf8')).toBe(original);
  expect(fs.lstatSync(f.target).isSymbolicLink()).toBe(false);
  expect(JSON.parse(fs.readFileSync(f.target, 'utf8'))).not.toHaveProperty(
    'oauthAccount',
  );
});

test('a torn session settings file also preserves its existing projection', () => {
  const f = fixture('session-settings');
  const projection = path.join(f.session, '.happyclaw-native-settings.json');
  fs.writeFileSync(f.target, '{"torn":');
  fs.writeFileSync(projection, '{"env":{"BASE":"previous"}}');
  f.write();
  expect(fs.readFileSync(projection, 'utf8')).toBe(
    '{"env":{"BASE":"previous"}}',
  );
});
