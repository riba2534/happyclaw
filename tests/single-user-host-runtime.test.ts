import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

import { canExecuteOnHost } from '../src/host-execution-policy.js';
import { makeExpandContext } from '../src/plugin-expander-context.js';
import { isValidWorkspaceFolderName } from '../src/workspace-folder.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

// index.ts functions run as written, with their collaborators passed in.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-backend-root-runtime-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('ensureDockerRunning', () => {
  function harness(singleUserHost: boolean) {
    const globals: Record<string, unknown> = {
      isSingleUserHost: () => singleUserHost,
      hasContainerModeGroups: vi.fn(() => true),
      isDockerAvailable: vi.fn(async () => true),
      execFileAsync: vi.fn(async () => ({ stdout: '' })),
      logger,
      process,
      Promise,
      Number,
      String,
      isNaN,
    };
    createRuntimeSourceHarness(globals).install('ensureDockerRunning');
    return globals as Record<string, any>;
  }

  test('runs no docker command in single-user host mode', async () => {
    const globals = harness(true);
    await globals.ensureDockerRunning();
    expect(globals.hasContainerModeGroups).not.toHaveBeenCalled();
    expect(globals.isDockerAvailable).not.toHaveBeenCalled();
    expect(globals.execFileAsync).not.toHaveBeenCalled();
  });

  test('still probes and cleans up in multi-user mode', async () => {
    const globals = harness(false);
    await globals.ensureDockerRunning();
    expect(globals.isDockerAvailable).toHaveBeenCalledOnce();
    expect(globals.execFileAsync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['ps']),
      expect.anything(),
    );
  });
});

describe('clearSessionRuntimeFiles', () => {
  test('never falls back to docker in single-user host mode', async () => {
    const claudeDir = path.join(tmp, 'claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const execFileAsync = vi.fn(async () => ({ stdout: '' }));
    const globals: Record<string, any> = {
      sessionClaudeDir: () => claudeDir,
      // Direct removal fails, as for files a container user owns.
      fs: {
        existsSync: () => true,
        readdirSync: () => {
          throw new Error('EACCES');
        },
      },
      path,
      execFileAsync,
      CONTAINER_IMAGE: 'image',
      logger,
      isSingleUserHost: () => true,
    };
    createRuntimeSourceHarness(globals).install('clearSessionRuntimeFiles');
    await globals.clearSessionRuntimeFiles('main', 'agent-1');
    expect(execFileAsync).not.toHaveBeenCalled();

    globals.isSingleUserHost = () => false;
    await globals.clearSessionRuntimeFiles('main', 'agent-1');
    expect(execFileAsync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['run', '--rm']),
      expect.anything(),
    );
  });
});

describe('IM auto-registration', () => {
  function harness(hostOnly: boolean) {
    const saved: Array<{ jid: string; group: Record<string, unknown> }> = [];
    const globals: Record<string, any> = {
      registeredGroups: {},
      getUserById: (id: string) =>
        id === 'admin-1' ? { id, role: 'admin', status: 'active' } : undefined,
      canExecuteOnHost,
      isAdminHostOnlyEffective: () => hostOnly,
      isValidWorkspaceFolderName,
      parseContainerConfig: () => ({ config: undefined }),
      validateAdditionalMountsStrict: () => [],
      setRegisteredGroup: (jid: string, group: Record<string, unknown>) =>
        saved.push({ jid, group }),
      assignWorkspaceRootDirIfNew: vi.fn(),
      ensureWorkspaceDirs: vi.fn(),
      resolveImGroupDefaults: () => ({ requireMention: false }),
      fs,
      path,
      logger,
      Error,
      Object,
      Date,
    };
    const h = createRuntimeSourceHarness(globals);
    h.install('isAdminHostOnlyOwner');
    h.install('registerGroup');
    h.install('buildOnNewChat');
    return { globals, saved };
  }

  test('an admin chat registers as host when admin workspaces are host-only', () => {
    const { globals, saved } = harness(true);
    globals.buildOnNewChat('admin-1', 'main')('feishu:oc_chat', 'Chat');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      jid: 'feishu:oc_chat',
      group: { folder: 'main', executionMode: 'host' },
    });
    expect(globals.ensureWorkspaceDirs).toHaveBeenCalledWith('main');
  });

  test('otherwise it keeps the default (container) mode', () => {
    const { globals, saved } = harness(false);
    globals.buildOnNewChat('admin-1', 'main')('feishu:oc_other', 'Other');
    expect(saved[0].group.executionMode).toBeUndefined();
  });

  test('a new Host web workspace gets its directory in the root', () => {
    const { globals } = harness(true);
    globals.registerGroup('web:flow-new', {
      name: 'New',
      folder: 'flow-new',
      added_at: '2026-11-04T00:00:00.000Z',
      created_by: 'admin-1',
    });
    expect(globals.assignWorkspaceRootDirIfNew).toHaveBeenCalledWith(
      'web:flow-new',
      expect.objectContaining({ folder: 'flow-new', executionMode: 'host' }),
    );
  });
});

describe('plugin `!` commands', () => {
  test('never target a container in single-user host mode', () => {
    const getActiveContainerName = vi.fn(() => 'happyclaw-leftover');
    const globals: Record<string, any> = {
      canExecuteOnHost,
      getUserById: () => ({ role: 'member', status: 'active' }),
      makeExpandContext,
      resolveWorkspaceProjectRoot: () => '/unused',
      workspaceDirOf: (folder: string) => `/groups/${folder}`,
      queue: { getActiveContainerName },
      isSingleUserHost: () => true,
    };
    createRuntimeSourceHarness(globals).install('buildExpandContext');
    const group = {
      name: 'Leftover',
      folder: 'leftover',
      added_at: '2026-11-04T00:00:00.000Z',
      executionMode: 'container',
      created_by: 'member-1',
    };
    expect(
      globals.buildExpandContext('web:leftover', group, null),
    ).toMatchObject({ executionMode: 'container', containerName: null });
    expect(getActiveContainerName).not.toHaveBeenCalled();

    globals.isSingleUserHost = () => false;
    expect(
      globals.buildExpandContext('web:leftover', group, null)?.containerName,
    ).toBe('happyclaw-leftover');
  });
});
