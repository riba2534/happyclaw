import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_HOST_MOUNT_ROUTE_TEST_DIR ??
  (() => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-host-mount-route-'),
    );
    process.env.HAPPYCLAW_HOST_MOUNT_ROUTE_TEST_DIR = dir;
    return dir;
  })();

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const root = process.env.HAPPYCLAW_HOST_MOUNT_ROUTE_TEST_DIR!;
  return {
    ...real,
    DATA_DIR: path.join(root, 'data'),
    GROUPS_DIR: path.join(root, 'data', 'groups'),
    STORE_DIR: path.join(root, 'data', 'db'),
    MOUNT_ALLOWLIST_PATH: path.join(root, 'mount-allowlist.json'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.HAPPYCLAW_TEST_USER_ID ?? 'route-admin',
      username: process.env.HAPPYCLAW_TEST_USER_ID ?? 'route-admin',
      role: process.env.HAPPYCLAW_TEST_USER_ROLE ?? 'admin',
      status: process.env.HAPPYCLAW_TEST_USER_STATUS ?? 'active',
      permissions: [],
    });
    return next();
  },
}));

vi.mock('../src/web.js', () => ({
  broadcastNewMessage: () => {},
  invalidateAllowedUserCache: () => {},
}));

const groupRoutes = (await import('../src/routes/groups.js')).default;
const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');

const allowedRoot = path.join(SHARED_TMP, 'allowed');
const outsideRoot = path.join(SHARED_TMP, 'outside');
const webDepsCache: Record<string, unknown> = {};
const ensureTerminalContainerStarted = vi.fn(() => true);

function asUser(
  id: string,
  role: 'admin' | 'member',
  status: 'active' | 'disabled' = 'active',
): void {
  process.env.HAPPYCLAW_TEST_USER_ID = id;
  process.env.HAPPYCLAW_TEST_USER_ROLE = role;
  process.env.HAPPYCLAW_TEST_USER_STATUS = status;
}

function uniqueName(label: string): string {
  return `mount-${label}-${Math.random().toString(36).slice(2, 9)}`;
}

async function createWorkspace(body: Record<string, unknown>) {
  const response = await groupRoutes.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    response,
    body: (await response.json().catch(() => ({}))) as Record<string, any>,
  };
}

function groupsNamed(name: string) {
  return Object.entries(db.getAllRegisteredGroups()).filter(
    ([, group]) => group.name === name,
  );
}

beforeAll(() => {
  fs.mkdirSync(path.join(SHARED_TMP, 'data', 'db'), { recursive: true });
  fs.mkdirSync(path.join(SHARED_TMP, 'data', 'groups'), { recursive: true });
  fs.mkdirSync(allowedRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
  fs.writeFileSync(
    path.join(SHARED_TMP, 'mount-allowlist.json'),
    JSON.stringify({
      allowedRoots: [
        {
          path: allowedRoot,
          allowReadWrite: false,
          description: 'route-test-read-only-root',
        },
      ],
      blockedPatterns: ['blocked'],
      nonMainReadOnly: true,
    }),
  );
  db.initDatabase();
  webContext.setWebDeps({
    getRegisteredGroups: () => webDepsCache,
    ensureTerminalContainerStarted,
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

beforeEach(() => {
  asUser('route-admin', 'admin');
  ensureTerminalContainerStarted.mockClear();
});

describe('POST /api/groups additional_mounts authorization', () => {
  test('rejects a member before probing a nonexistent host path', async () => {
    const name = uniqueName('member-denied');
    const secretPath = path.join(
      outsideRoot,
      `definitely-missing-${Math.random().toString(36).slice(2)}`,
    );
    asUser('route-member', 'member');

    const { response, body } = await createWorkspace({
      name,
      execution_mode: 'container',
      additional_mounts: [
        {
          host_path: secretPath,
          container_path: 'member-secret',
          readonly: true,
        },
      ],
    });

    expect(response.status).toBe(403);
    expect(body.code).toBe('HOST_MOUNT_ADMIN_REQUIRED');
    expect(JSON.stringify(body)).not.toContain(secretPath);
    expect(JSON.stringify(body).toLowerCase()).not.toContain('does not exist');
    expect(groupsNamed(name)).toHaveLength(0);
  });

  test('rejects mounts for an inactive admin', async () => {
    const source = path.join(allowedRoot, uniqueName('inactive-source'));
    fs.mkdirSync(source);
    const name = uniqueName('inactive-admin');
    asUser('inactive-admin', 'admin', 'disabled');

    const { response, body } = await createWorkspace({
      name,
      execution_mode: 'container',
      additional_mounts: [
        {
          host_path: source,
          container_path: 'source',
        },
      ],
    });

    expect(response.status).toBe(403);
    expect(body.code).toBe('HOST_MOUNT_ADMIN_REQUIRED');
    expect(groupsNamed(name)).toHaveLength(0);
  });

  test('rejects additional mounts in host execution mode', async () => {
    const source = path.join(allowedRoot, uniqueName('host-mode-source'));
    fs.mkdirSync(source);
    const name = uniqueName('host-mode');

    const { response, body } = await createWorkspace({
      name,
      execution_mode: 'host',
      additional_mounts: [
        {
          host_path: source,
          container_path: 'source',
          readonly: true,
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(body.code).toBe('HOST_MOUNT_CONTAINER_ONLY');
    expect(groupsNamed(name)).toHaveLength(0);
  });
});

describe('POST /api/groups additional_mounts persistence', () => {
  test('persists the canonical source and explicit safe defaults', async () => {
    const source = path.join(allowedRoot, uniqueName('canonical-source'));
    fs.mkdirSync(source);
    const sourceAlias = path.join(
      allowedRoot,
      '..',
      path.basename(allowedRoot),
      path.basename(source),
    );
    const name = uniqueName('canonical');

    const { response, body } = await createWorkspace({
      name,
      execution_mode: 'container',
      additional_mounts: [
        {
          host_path: sourceAlias,
          container_path: 'project-data',
        },
      ],
    });

    expect(response.status).toBe(200);
    const persisted = db.getRegisteredGroup(body.jid);
    expect(persisted?.containerConfig?.additionalMounts).toEqual([
      {
        hostPath: fs.realpathSync(source),
        containerPath: 'project-data',
        readonly: true,
      },
    ]);
    // A workspace has no runner of its own to warm.
    expect(ensureTerminalContainerStarted).not.toHaveBeenCalled();
  });

  test('keeps ordinary container workspace creation backward compatible', async () => {
    const name = uniqueName('ordinary');
    const { response, body } = await createWorkspace({
      name,
      execution_mode: 'container',
    });

    expect(response.status).toBe(200);
    expect(db.getRegisteredGroup(body.jid)?.containerConfig).toBeUndefined();
  });
});

describe('POST /api/groups additional_mounts strict validation', () => {
  test.each([
    {
      label: 'file source',
      arrange: () => {
        const file = path.join(allowedRoot, uniqueName('file'));
        fs.writeFileSync(file, 'not a directory');
        return {
          host_path: file,
          container_path: 'file',
          readonly: true,
        };
      },
    },
    {
      label: 'outside allowlist',
      arrange: () => {
        const dir = path.join(outsideRoot, uniqueName('outside'));
        fs.mkdirSync(dir);
        return {
          host_path: dir,
          container_path: 'outside',
          readonly: true,
        };
      },
    },
    {
      label: 'symlink escape',
      arrange: () => {
        const target = path.join(outsideRoot, uniqueName('symlink-target'));
        const link = path.join(allowedRoot, uniqueName('symlink-link'));
        fs.mkdirSync(target);
        fs.symlinkSync(target, link, 'dir');
        return {
          host_path: link,
          container_path: 'link',
          readonly: true,
        };
      },
    },
    {
      label: 'blocked path component',
      arrange: () => {
        const dir = path.join(
          allowedRoot,
          'blocked',
          uniqueName('blocked-child'),
        );
        fs.mkdirSync(dir, { recursive: true });
        return {
          host_path: dir,
          container_path: 'blocked',
          readonly: true,
        };
      },
    },
  ])('rejects $label without publishing a workspace', async ({ arrange }) => {
    const name = uniqueName('invalid-source');
    const { response } = await createWorkspace({
      name,
      execution_mode: 'container',
      additional_mounts: [arrange()],
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(groupsNamed(name)).toHaveLength(0);
  });

  test.each([
    '',
    '/absolute',
    '../escape',
    '.',
    '.npm-global',
    '.npm-global/cache',
  ])('rejects reserved or unsafe target %j', async (containerPath) => {
    const source = path.join(allowedRoot, uniqueName('bad-target-source'));
    fs.mkdirSync(source);
    const name = uniqueName('bad-target');

    const { response } = await createWorkspace({
      name,
      execution_mode: 'container',
      additional_mounts: [
        {
          host_path: source,
          container_path: containerPath,
          readonly: true,
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(groupsNamed(name)).toHaveLength(0);
  });

  test.each([
    ['colon', path.join(allowedRoot, 'colon:name')],
    ['control character', path.join(allowedRoot, 'control\u0007name')],
  ])('rejects a host path containing a %s', async (_label, hostPath) => {
    fs.mkdirSync(hostPath, { recursive: true });
    const name = uniqueName('unsafe-host-path');
    const { response, body } = await createWorkspace({
      name,
      execution_mode: 'container',
      additional_mounts: [
        {
          host_path: hostPath,
          container_path: 'unsafe-host-path',
          readonly: true,
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(body.code).toBe('INVALID_ADDITIONAL_MOUNTS');
    expect(groupsNamed(name)).toHaveLength(0);
  });

  test.each([
    {
      label: 'duplicate targets',
      paths: ['same', 'same'],
    },
    {
      label: 'nested targets',
      paths: ['parent', 'parent/child'],
    },
  ])('rejects $label', async ({ paths }) => {
    const sources = paths.map((_, index) => {
      const source = path.join(
        allowedRoot,
        uniqueName(`overlap-source-${index}`),
      );
      fs.mkdirSync(source);
      return source;
    });
    const name = uniqueName('overlap');

    const { response, body } = await createWorkspace({
      name,
      execution_mode: 'container',
      additional_mounts: paths.map((container_path, index) => ({
        host_path: sources[index],
        container_path,
        readonly: true,
      })),
    });

    expect(response.status).toBe(409);
    expect(body.code).toBe('HOST_MOUNT_TARGET_CONFLICT');
    expect(groupsNamed(name)).toHaveLength(0);
  });

  test('rejects more than eight mounts', async () => {
    const mounts = Array.from({ length: 9 }, (_, index) => {
      const source = path.join(allowedRoot, uniqueName(`limit-${index}`));
      fs.mkdirSync(source);
      return {
        host_path: source,
        container_path: `target-${index}`,
        readonly: true,
      };
    });
    const name = uniqueName('limit');

    const { response } = await createWorkspace({
      name,
      execution_mode: 'container',
      additional_mounts: mounts,
    });

    expect(response.status).toBe(400);
    expect(groupsNamed(name)).toHaveLength(0);
  });

  test('rejects read-write when the matching root forbids it', async () => {
    const source = path.join(allowedRoot, uniqueName('rw-source'));
    fs.mkdirSync(source);
    const name = uniqueName('rw');

    const { response, body } = await createWorkspace({
      name,
      execution_mode: 'container',
      additional_mounts: [
        {
          host_path: source,
          container_path: 'rw-source',
          readonly: false,
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(body.code).toBe('INVALID_ADDITIONAL_MOUNTS');
    expect(groupsNamed(name)).toHaveLength(0);
  });
});
