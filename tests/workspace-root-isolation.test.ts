import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

// One workspace must never reach another's directory: neither as a container
// mount nor through the directory browser (which feeds mounts and custom
// directories). The deny set covers the current root and every root a
// recorded directory still lives in.
const tmp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'ws-backend-root-isolation-')),
);
const dataDir = path.join(tmp, 'install', 'data');
const storeDir = path.join(dataDir, 'db');
const groupsDir = path.join(dataDir, 'groups');
const allowed = path.join(tmp, 'allowed');
const currentRoot = path.join(allowed, 'root-now');
const oldRoot = path.join(allowed, 'root-before');
const sibling = path.join(allowed, 'projects');
for (const dir of [storeDir, groupsDir, currentRoot, oldRoot, sibling]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(
  path.join(tmp, 'mount-allowlist.json'),
  JSON.stringify({
    allowedRoots: [{ path: allowed, allowReadWrite: true }],
    blockedPatterns: [],
    nonMainReadOnly: false,
  }),
);

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  MOUNT_ALLOWLIST_PATH: path.join(tmp, 'mount-allowlist.json'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'admin-1',
      username: 'admin-1',
      role: 'admin',
      status: 'active',
      permissions: [],
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const dir = await import('../src/workspace-dir.js');
const security = await import('../src/mount-security.js');
const browseRoutes = (await import('../src/routes/browse.js')).default;

let root = oldRoot;
let rootResolutions = 0;

beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  dir.setWorkspaceRootResolver(() => {
    rootResolutions++;
    return root;
  });
  // A workspace made before the root changed, then the root moves.
  dir.assignWorkspaceRootDir('flow-old');
  root = currentRoot;
  dir.assignWorkspaceRootDir('flow-new');
});

afterAll(() => {
  dir.setWorkspaceRootResolver(null);
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mountable(hostPath: string): boolean {
  return security.validateMount(
    { hostPath, containerPath: 'data', readonly: true },
    false,
  ).allowed;
}

async function browse(target: string, purpose?: 'mount') {
  const query = purpose ? `&purpose=${purpose}` : '';
  const res = await browseRoutes.request(
    `/directories?path=${encodeURIComponent(target)}${query}`,
  );
  return { status: res.status, json: (await res.json()) as any };
}

describe('mounts', () => {
  test('a mount list resolves the workspace root once', () => {
    const sources = Array.from({ length: 5 }, (_, i) => {
      const source = path.join(allowed, 'mount-sources', `m-${i}`);
      fs.mkdirSync(source, { recursive: true });
      return { hostPath: source, containerPath: `m${i}`, readonly: true };
    });
    rootResolutions = 0;
    expect(
      security.validateAdditionalMountsStrict(sources, 'ws', false),
    ).toHaveLength(5);
    expect(rootResolutions).toBe(1);
  });

  test('the roots and every workspace directory in them are denied', () => {
    expect(mountable(sibling)).toBe(true);
    for (const target of [
      currentRoot,
      path.join(currentRoot, 'flow-new'),
      oldRoot,
      path.join(oldRoot, 'flow-old'),
      // An ancestor of a root overlaps it as well.
      allowed,
    ]) {
      expect(mountable(target)).toBe(false);
    }
    expect(
      security.validateMount(
        { hostPath: currentRoot, containerPath: 'data', readonly: true },
        false,
      ).reason,
    ).toContain('protected path');
  });
});

describe('directory browser', () => {
  test('cannot enter a root or a workspace directory', async () => {
    for (const target of [
      currentRoot,
      path.join(currentRoot, 'flow-new'),
      oldRoot,
    ]) {
      const { status, json } = await browse(target);
      expect(status).toBe(403);
      expect(json.code).toBe('WORKSPACE_ROOT_FORBIDDEN');
    }
    expect((await browse(sibling)).status).toBe(200);
  });

  test('does not list the roots next to other directories', async () => {
    const { status, json } = await browse(allowed);
    expect(status).toBe(200);
    const names = json.directories.map((d: { name: string }) => d.name);
    expect(names).toContain('projects');
    expect(names).not.toContain('root-now');
    expect(names).not.toContain('root-before');
  });

  test('resolves the workspace root once per request, not per entry', async () => {
    for (let i = 0; i < 30; i++) {
      fs.mkdirSync(path.join(sibling, `entry-${i}`), { recursive: true });
    }
    for (const purpose of [undefined, 'mount'] as const) {
      rootResolutions = 0;
      const { status, json } = await browse(sibling, purpose);
      expect(status).toBe(200);
      expect(json.directories).toHaveLength(30);
      expect(rootResolutions).toBe(1);
    }
  });

  test('cannot create a folder inside a root', async () => {
    const res = await browseRoutes.request('/directories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentPath: currentRoot, name: 'sneaky' }),
    });
    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(currentRoot, 'sneaky'))).toBe(false);
  });
});
