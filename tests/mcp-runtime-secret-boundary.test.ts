import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const TEST_ROOT =
  process.env.HAPPYCLAW_MCP_RUNTIME_TEST_ROOT ??
  (() => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-mcp-runtime-boundary-'),
    );
    process.env.HAPPYCLAW_MCP_RUNTIME_TEST_ROOT = root;
    return root;
  })();

const ownerRoles = vi.hoisted(() => new Map<string, 'admin' | 'member'>());

vi.mock('../src/config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/config.js')>();
  const root = process.env.HAPPYCLAW_MCP_RUNTIME_TEST_ROOT!;
  return {
    ...real,
    DATA_DIR: root,
    GROUPS_DIR: path.join(root, 'groups'),
    STORE_DIR: path.join(root, 'db'),
    CONTAINER_IMAGE: 'happyclaw-agent:test',
    TIMEZONE: 'UTC',
    MAIN_GROUP_FOLDER: 'main',
  };
});

vi.mock('../src/db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/db.js')>();
  return {
    ...real,
    getUserById: (id: string) => ({
      id,
      role: ownerRoles.get(id) ?? 'member',
      status: 'active',
    }),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));

const { buildVolumeMounts, getContainerRuntimeEnvDir } =
  await import('../src/container-runner.js');

function writeMcpStore(
  ownerId: string,
  servers: Record<string, Record<string, unknown>>,
  secrets: Record<string, Record<string, unknown>> = {},
): void {
  const root = path.join(TEST_ROOT, 'mcp-servers', ownerId);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'servers.json'),
    JSON.stringify({ servers }),
  );
  fs.writeFileSync(
    path.join(root, 'secrets.json'),
    JSON.stringify({ servers: secrets }),
  );
}

function group(folder: string, ownerId: string) {
  return {
    name: folder,
    folder,
    added_at: '2026-07-16T00:00:00.000Z',
    created_by: ownerId,
    is_home: true,
  };
}

const SESSION = 'session-1';

function settingsPath(folder: string): string {
  return path.join(
    TEST_ROOT,
    'sessions',
    folder,
    'agents',
    SESSION,
    '.claude',
    'settings.json',
  );
}

function seedStores(ownerId: string): void {
  writeMcpStore(
    'system',
    {
      sharedStdio: {
        enabled: true,
        command: 'shared-system-mcp',
        args: ['--token', 'shared-args-secret'],
        memberAccess: 'shared',
        addedAt: '2026-07-16T00:00:00.000Z',
      },
      sharedHttp: {
        enabled: true,
        type: 'http',
        url: 'https://shared.example/mcp?token=shared-url-secret',
        memberAccess: 'shared',
        addedAt: '2026-07-16T00:00:00.000Z',
      },
      legacyArgs: {
        enabled: true,
        command: 'legacy-args-mcp',
        args: ['--token', 'legacy-args-secret'],
        addedAt: '2026-07-16T00:00:00.000Z',
      },
      legacyUrl: {
        enabled: true,
        type: 'http',
        url: 'https://legacy.example/mcp?token=legacy-url-secret',
        addedAt: '2026-07-16T00:00:00.000Z',
      },
      adminSecret: {
        enabled: true,
        command: 'admin-secret-mcp',
        memberAccess: 'admin_only',
        addedAt: '2026-07-16T00:00:00.000Z',
      },
    },
    {
      sharedStdio: { env: { SHARED_TOKEN: 'shared-env-secret' } },
      sharedHttp: {
        headers: { Authorization: 'Bearer shared-header-secret' },
      },
      adminSecret: { env: { SYSTEM_TOKEN: 'admin-env-secret' } },
    },
  );
  writeMcpStore(
    ownerId,
    {
      privateOwner: {
        enabled: true,
        command: 'private-owner-mcp',
        addedAt: '2026-07-16T00:00:00.000Z',
      },
    },
    { privateOwner: { env: { OWNER_TOKEN: 'owner-secret' } } },
  );
  writeMcpStore(
    'other-tenant',
    {
      privateOther: {
        enabled: true,
        command: 'private-other-mcp',
        addedAt: '2026-07-16T00:00:00.000Z',
      },
    },
    { privateOther: { env: { OTHER_TOKEN: 'other-tenant-secret' } } },
  );
}

beforeEach(() => {
  ownerRoles.clear();
  for (const entry of fs.readdirSync(TEST_ROOT)) {
    fs.rmSync(path.join(TEST_ROOT, entry), { recursive: true, force: true });
  }
});

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  delete process.env.HAPPYCLAW_MCP_RUNTIME_TEST_ROOT;
});

describe('managed MCP runtime secret boundary', () => {
  test('image and entrypoint do not recreate legacy filesystem memory roots', () => {
    const dockerfile = fs.readFileSync('container/Dockerfile', 'utf8');
    const entrypoint = fs.readFileSync('container/entrypoint.sh', 'utf8');

    for (const legacyRoot of ['/workspace/global', '/workspace/memory']) {
      expect(dockerfile).not.toContain(legacyRoot);
      expect(entrypoint).not.toContain(legacyRoot);
    }
  });

  test('isolates generated env paths by Bot identity and runtime', () => {
    const botAAgent = getContainerRuntimeEnvDir(
      'workspace',
      'agent-a',
      'account-a',
    );
    const botBAgent = getContainerRuntimeEnvDir(
      'workspace',
      'agent-a',
      'account-b',
    );
    const botAOtherAgent = getContainerRuntimeEnvDir(
      'workspace',
      'agent-b',
      'account-a',
    );

    expect(new Set([botAAgent, botBAgent, botAOtherAgent]).size).toBe(3);
    expect(botAAgent).toContain(
      path.join('channel-accounts', 'account-a', 'agents', 'agent-a'),
    );
    expect(() =>
      getContainerRuntimeEnvDir('workspace', '../escape', 'account-a'),
    ).toThrow(/Invalid agent id/);
  });

  test('rejects unsafe workspace folders before building env paths', () => {
    expect(() =>
      getContainerRuntimeEnvDir('../workspace', 'agent-a', 'account-a'),
    ).toThrow(/Invalid group folder/);
  });

  test('member runtime receives only explicitly shared system MCP, regardless of where tokens are stored', () => {
    const ownerId = 'member-owner';
    ownerRoles.set(ownerId, 'member');
    seedStores(ownerId);

    const target = settingsPath('member-workspace');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      JSON.stringify({
        env: { KEEP_ME: 'yes' },
        mcpServers: {
          staleSystem: { env: { TOKEN: 'stale-system-secret' } },
        },
      }),
    );

    const mounts = buildVolumeMounts(
      group('member-workspace', ownerId) as any,
      false,
      SESSION,
    );
    expect(mounts.map((mount) => mount.containerPath)).not.toContain(
      '/workspace/global',
    );
    expect(mounts.map((mount) => mount.containerPath)).not.toContain(
      '/workspace/memory',
    );

    const raw = fs.readFileSync(target, 'utf8');
    const settings = JSON.parse(raw) as {
      env: Record<string, string>;
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(settings.env.KEEP_ME).toBe('yes');
    expect(settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(settings.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('0');
    expect(settings.mcpServers).toMatchObject({
      sharedStdio: {
        command: 'shared-system-mcp',
        args: ['--token', 'shared-args-secret'],
        env: { SHARED_TOKEN: 'shared-env-secret' },
      },
      sharedHttp: {
        url: 'https://shared.example/mcp?token=shared-url-secret',
        headers: { Authorization: 'Bearer shared-header-secret' },
      },
      privateOwner: {
        command: 'private-owner-mcp',
        env: { OWNER_TOKEN: 'owner-secret' },
      },
    });
    expect(settings.mcpServers).not.toHaveProperty('legacyArgs');
    expect(settings.mcpServers).not.toHaveProperty('legacyUrl');
    expect(settings.mcpServers).not.toHaveProperty('adminSecret');
    expect(settings.mcpServers).not.toHaveProperty('privateOther');
    expect(settings.mcpServers).not.toHaveProperty('staleSystem');
    expect(raw).not.toContain('legacy-args-secret');
    expect(raw).not.toContain('legacy-url-secret');
    expect(raw).not.toContain('admin-env-secret');
    expect(raw).not.toContain('other-tenant-secret');
    expect(raw).not.toContain('stale-system-secret');

    const migrated = JSON.parse(
      fs.readFileSync(
        path.join(TEST_ROOT, 'mcp-servers', 'system', 'servers.json'),
        'utf8',
      ),
    ) as { servers: Record<string, Record<string, unknown>> };
    expect(migrated.servers.legacyArgs.memberAccess).toBe('admin_only');
    expect(migrated.servers.legacyUrl.memberAccess).toBe('admin_only');
  });

  test('active admin runtime receives shared and admin-only system MCP definitions', () => {
    const ownerId = 'admin-owner';
    ownerRoles.set(ownerId, 'admin');
    seedStores(ownerId);

    buildVolumeMounts(group('admin-workspace', ownerId) as any, false, SESSION);

    const settings = JSON.parse(
      fs.readFileSync(settingsPath('admin-workspace'), 'utf8'),
    ) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(settings.mcpServers.legacyArgs).toMatchObject({
      args: ['--token', 'legacy-args-secret'],
    });
    expect(settings.mcpServers.legacyUrl).toMatchObject({
      url: 'https://legacy.example/mcp?token=legacy-url-secret',
    });
    expect(settings.mcpServers.adminSecret).toMatchObject({
      env: { SYSTEM_TOKEN: 'admin-env-secret' },
    });
  });

  test('custom member policy fails explicitly when it selects an admin-only system MCP', () => {
    const ownerId = 'custom-member';
    ownerRoles.set(ownerId, 'member');
    seedStores(ownerId);

    expect(() =>
      buildVolumeMounts(
        group('custom-member-workspace', ownerId) as any,
        false,
        SESSION,
        true,
        undefined,
        undefined,
        {
          id: 'restricted-system-profile',
          name: 'Restricted System Profile',
          version: 1,
          identityHash: 'hash',
          identityPrompt: '',
          includeClaudePreset: true,
          runtimePolicy: {
            skills: { mode: 'inherit', ids: [] },
            mcp: { mode: 'custom', ids: ['system:legacyArgs'] },
          },
        },
      ),
    ).toThrow(
      'AgentProfile restricted-system-profile requires unavailable MCP server(s): system:legacyArgs',
    );
  });
});
