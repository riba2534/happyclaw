import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

// Everything under one temp dir: the install (data/), and two workspace roots
// outside it, so changing the root can be observed.
const tmp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'ws-backend-root-dir-')),
);
const dataDir = path.join(tmp, 'install', 'data');
const storeDir = path.join(dataDir, 'db');
const groupsDir = path.join(dataDir, 'groups');
const rootA = path.join(tmp, 'root-a');
const rootB = path.join(tmp, 'root-b');
for (const dir of [storeDir, groupsDir]) fs.mkdirSync(dir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const dir = await import('../src/workspace-dir.js');
const workspaceRoot = await import('../src/workspace-root.js');
const { WORKSPACE_ROOT_MARKER } = await import('../src/workspace-root-fs.js');
const { logger } = await import('../src/logger.js');
const { removeFlowArtifacts } = await import('../src/file-manager.js');

const NOW = '2026-11-04T00:00:00.000Z';
let currentRoot = rootA;

function createUser(id: string, role: 'admin' | 'member'): void {
  db.createUser({
    id,
    username: id,
    password_hash: 'hash',
    display_name: id,
    role,
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
    must_change_password: false,
  });
}

beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  createUser('admin-1', 'admin');
  createUser('member-1', 'member');
});

beforeEach(() => {
  currentRoot = rootA;
  dir.setWorkspaceRootResolver(() => currentRoot);
});

afterAll(() => {
  dir.setWorkspaceRootResolver(null);
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('workspaceDirOf', () => {
  test('an unrecorded folder is data/groups/<folder>, logs inside it', () => {
    expect(dir.getRecordedWorkdir('plain')).toBeNull();
    expect(dir.workspaceDirOf('plain')).toBe(path.join(groupsDir, 'plain'));
    expect(dir.workspaceLogsDirOf('plain')).toBe(
      path.join(groupsDir, 'plain', 'logs'),
    );
  });

  test('a recorded folder resolves to its directory, logs to data/logs', () => {
    const workdir = dir.assignWorkspaceRootDir('flow-recorded');
    expect(workdir).toBe(path.join(rootA, 'flow-recorded'));
    expect(fs.statSync(workdir).isDirectory()).toBe(true);
    expect((fs.statSync(rootA).mode & 0o777).toString(8)).toBe('700');
    expect(dir.getRecordedWorkdir('flow-recorded')).toBe(workdir);
    expect(dir.workspaceDirOf('flow-recorded')).toBe(workdir);
    expect(dir.workspaceLogsDirOf('flow-recorded')).toBe(
      path.join(dataDir, 'logs', 'flow-recorded'),
    );
  });

  test('a folder that already has files in data/groups stays there', () => {
    fs.mkdirSync(path.join(groupsDir, 'flow-old'), { recursive: true });
    expect(dir.assignWorkspaceRootDir('flow-old')).toBe(
      path.join(groupsDir, 'flow-old'),
    );
    expect(dir.getRecordedWorkdir('flow-old')).toBeNull();
  });

  test('a resolver with no usable root keeps data/groups', () => {
    dir.setWorkspaceRootResolver(() => null);
    expect(dir.assignWorkspaceRootDir('flow-no-root')).toBe(
      path.join(groupsDir, 'flow-no-root'),
    );
    expect(dir.getRecordedWorkdir('flow-no-root')).toBeNull();
  });

  test('without a bound root nothing is recorded', () => {
    dir.setWorkspaceRootResolver(null);
    expect(dir.assignWorkspaceRootDir('flow-unbound')).toBe(
      path.join(groupsDir, 'flow-unbound'),
    );
    expect(dir.getRecordedWorkdir('flow-unbound')).toBeNull();
  });

  test('only a Web Host workspace without a custom directory gets one', () => {
    const host = { executionMode: 'host' };
    dir.assignWorkspaceRootDirIfNew('feishu:oc_chat', {
      folder: 'flow-im',
      ...host,
    });
    dir.assignWorkspaceRootDirIfNew('web:flow-cwd-x', {
      folder: 'flow-cwd-x',
      ...host,
      customCwd: '/srv/repo',
    });
    dir.assignWorkspaceRootDirIfNew('web:flow-ctr', {
      folder: 'flow-ctr',
      executionMode: 'container',
    });
    dir.assignWorkspaceRootDirIfNew('web:flow-host', {
      folder: 'flow-host',
      ...host,
    });
    expect(dir.getRecordedWorkdir('flow-im')).toBeNull();
    expect(dir.getRecordedWorkdir('flow-cwd-x')).toBeNull();
    expect(dir.getRecordedWorkdir('flow-ctr')).toBeNull();
    expect(dir.getRecordedWorkdir('flow-host')).toBe(
      path.join(rootA, 'flow-host'),
    );
  });

  test('changing the root leaves existing workspaces where they are', () => {
    const first = dir.assignWorkspaceRootDir('flow-before-change');
    currentRoot = rootB;
    expect(dir.assignWorkspaceRootDir('flow-before-change')).toBe(first);
    expect(dir.workspaceDirOf('flow-before-change')).toBe(first);
    expect(dir.assignWorkspaceRootDir('flow-after-change')).toBe(
      path.join(rootB, 'flow-after-change'),
    );
    expect(dir.workspaceRootDirs()).toEqual(
      expect.arrayContaining([rootA, rootB]),
    );
  });
});

describe('home workspaces', () => {
  test('a new admin home is recorded in the root; a member home is not', () => {
    const adminJid = db.ensureUserHomeGroup('admin-1', 'admin', 'admin-1');
    const adminFolder = db.getRegisteredGroup(adminJid)!.folder;
    expect(db.getRegisteredGroup(adminJid)?.executionMode).toBe('host');
    expect(dir.getRecordedWorkdir(adminFolder)).toBe(
      path.join(rootA, adminFolder),
    );
    expect(fs.existsSync(path.join(rootA, adminFolder))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'logs', adminFolder))).toBe(true);

    const memberJid = db.ensureUserHomeGroup('member-1', 'member', 'member-1');
    const memberFolder = db.getRegisteredGroup(memberJid)!.folder;
    expect(dir.getRecordedWorkdir(memberFolder)).toBeNull();
    expect(fs.existsSync(path.join(groupsDir, memberFolder, 'logs'))).toBe(
      true,
    );
  });

  test('deleting the workspace drops its record', () => {
    dir.assignWorkspaceRootDir('flow-deleted');
    db.setRegisteredGroup('web:flow-deleted', {
      name: 'x',
      folder: 'flow-deleted',
      added_at: NOW,
      executionMode: 'host',
      created_by: 'admin-1',
    });
    db.deleteGroupData('web:flow-deleted', 'flow-deleted');
    expect(dir.getRecordedWorkdir('flow-deleted')).toBeNull();
  });
});

describe('removing a recorded directory', () => {
  /** Record `workdir` in `root` for `folder`, as a forged or damaged row would. */
  function forge(folder: string, workdir: string, root = rootA) {
    dir.deleteRecordedWorkdir(folder);
    const conn = new Database(path.join(storeDir, 'messages.db'));
    try {
      conn
        .prepare(
          'INSERT INTO workspace_workdirs (folder, workdir, root, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(folder, workdir, root, NOW);
    } finally {
      conn.close();
    }
    return dir.getRecordedWorkdirRecord(folder)!;
  }

  function withFile(target: string): string {
    fs.mkdirSync(target, { recursive: true });
    const file = path.join(target, 'keep.txt');
    fs.writeFileSync(file, 'user data');
    return file;
  }

  /** The record is refused for `reason` and removing it keeps the file. */
  function expectKept(
    record: ReturnType<typeof forge>,
    reason: string,
    file: string,
  ): void {
    expect(dir.checkRecordedWorkdirRemoval(record)).toBe(reason);
    removeFlowArtifacts(record.folder, record);
    expect(fs.existsSync(file)).toBe(true);
  }

  test('the directory HappyClaw made is removed with its logs', () => {
    const workdir = dir.assignWorkspaceRootDir('flow-remove-ok');
    withFile(workdir);
    withFile(path.join(dataDir, 'logs', 'flow-remove-ok'));
    const record = dir.getRecordedWorkdirRecord('flow-remove-ok')!;
    expect(record.root).toBe(rootA);
    expect(dir.checkRecordedWorkdirRemoval(record)).toBeNull();
    removeFlowArtifacts('flow-remove-ok', record);
    expect(fs.existsSync(workdir)).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'logs', 'flow-remove-ok'))).toBe(
      false,
    );
  });

  test('the only workspace left in an old root can still be removed', () => {
    const workdir = dir.assignWorkspaceRootDir('flow-lone');
    withFile(workdir);
    currentRoot = rootB;
    const record = dir.getRecordedWorkdirRecord('flow-lone')!;
    expect(dir.checkRecordedWorkdirRemoval(record)).toBeNull();
    removeFlowArtifacts('flow-lone', record);
    expect(fs.existsSync(workdir)).toBe(false);
  });

  test('a wrong basename is refused and nothing is removed', () => {
    const elsewhere = path.join(rootA, 'someone-else');
    const file = withFile(elsewhere);
    expectKept(forge('flow-basename', elsewhere), 'basename_mismatch', file);
  });

  test("a record whose root is not its directory's parent is refused", () => {
    const outside = path.join(tmp, 'projects', 'flow-outside');
    const file = withFile(outside);
    expectKept(forge('flow-outside', outside), 'root_mismatch', file);

    // In a real root, but not the one recorded.
    const inB = path.join(rootB, 'flow-other-root');
    const fileB = withFile(inB);
    expectKept(forge('flow-other-root', inB, rootA), 'root_mismatch', fileB);
  });

  test('a symlink, or a parent link that leaves the root, is refused', () => {
    const target = path.join(tmp, 'precious', 'flow-link');
    const file = withFile(target);
    const link = path.join(rootA, 'flow-link');
    fs.mkdirSync(rootA, { recursive: true });
    fs.symlinkSync(target, link);
    expectKept(forge('flow-link', link), 'symlink', file);

    // rootA/escape -> tmp/precious. Under rootA it is not the recorded
    // root's child; recorded as its own root, the root is a link.
    const parentTarget = path.join(tmp, 'precious', 'flow-parent');
    const parentFile = withFile(parentTarget);
    const escape = path.join(rootA, 'escape');
    fs.symlinkSync(path.join(tmp, 'precious'), escape);
    const viaLink = path.join(escape, 'flow-parent');
    expectKept(forge('flow-parent', viaLink), 'root_mismatch', parentFile);
    expectKept(
      forge('flow-parent', viaLink, escape),
      'root_not_real',
      parentFile,
    );
  });

  test("a directory that is some workspace's custom directory is refused", () => {
    const workdir = dir.assignWorkspaceRootDir('flow-cwd');
    const file = withFile(workdir);
    db.setRegisteredGroup('web:uses-it', {
      name: 'uses it',
      folder: 'uses-it',
      added_at: NOW,
      executionMode: 'host',
      customCwd: workdir,
      created_by: 'admin-1',
    });
    try {
      expectKept(dir.getRecordedWorkdirRecord('flow-cwd')!, 'custom_cwd', file);
    } finally {
      db.deleteGroupData('web:uses-it', 'uses-it');
    }
  });

  test('a custom directory around it (such as ~) does not block removal', () => {
    const workdir = dir.assignWorkspaceRootDir('flow-under-home');
    withFile(workdir);
    db.setRegisteredGroup('web:uses-home', {
      name: 'uses home',
      folder: 'uses-home',
      added_at: NOW,
      executionMode: 'host',
      customCwd: tmp,
      created_by: 'admin-1',
    });
    try {
      const record = dir.getRecordedWorkdirRecord('flow-under-home')!;
      expect(dir.checkRecordedWorkdirRemoval(record)).toBeNull();
      removeFlowArtifacts(record.folder, record);
      expect(fs.existsSync(workdir)).toBe(false);
      expect(fs.existsSync(tmp)).toBe(true);
    } finally {
      db.deleteGroupData('web:uses-home', 'uses-home');
    }
  });

  test('a directory inside the install is refused', () => {
    currentRoot = path.join(dataDir, 'roots');
    const workdir = dir.assignWorkspaceRootDir('flow-install');
    const file = withFile(workdir);
    expectKept(
      dir.getRecordedWorkdirRecord('flow-install')!,
      'install_dir',
      file,
    );
  });

  test('assertRecordedWorkdirRemovable throws UnsafeWorkdirError', () => {
    expect(() =>
      dir.assertRecordedWorkdirRemovable({
        folder: 'flow-x',
        workdir: path.join(rootA, 'other'),
        root: rootA,
      }),
    ).toThrow(dir.UnsafeWorkdirError);
  });
});

describe('an existing <root>/<folder>', () => {
  test('with content is never adopted and stays untouched', () => {
    const existing = path.join(rootA, 'flow-taken');
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, 'mine.txt'), 'personal');
    expect(dir.assignWorkspaceRootDir('flow-taken')).toBe(
      path.join(groupsDir, 'flow-taken'),
    );
    expect(dir.getRecordedWorkdir('flow-taken')).toBeNull();
    expect(fs.readdirSync(existing)).toEqual(['mine.txt']);
  });

  test('that is a file or a link is not adopted either', () => {
    fs.mkdirSync(rootA, { recursive: true });
    fs.writeFileSync(path.join(rootA, 'flow-file'), 'x');
    expect(dir.assignWorkspaceRootDir('flow-file')).toBe(
      path.join(groupsDir, 'flow-file'),
    );
    const emptyTarget = path.join(tmp, 'empty-target');
    fs.mkdirSync(emptyTarget, { recursive: true });
    fs.symlinkSync(emptyTarget, path.join(rootA, 'flow-linked'));
    expect(dir.assignWorkspaceRootDir('flow-linked')).toBe(
      path.join(groupsDir, 'flow-linked'),
    );
    expect(dir.getRecordedWorkdir('flow-linked')).toBeNull();
  });

  test('that is empty is adopted; a missing one is created', () => {
    const empty = path.join(rootA, 'flow-empty');
    fs.mkdirSync(empty, { recursive: true });
    expect(dir.assignWorkspaceRootDir('flow-empty')).toBe(empty);
    expect(dir.getRecordedWorkdir('flow-empty')).toBe(empty);

    const missing = path.join(rootA, 'flow-missing');
    expect(fs.existsSync(missing)).toBe(false);
    expect(dir.assignWorkspaceRootDir('flow-missing')).toBe(missing);
    expect(fs.statSync(missing).isDirectory()).toBe(true);
  });
});

describe('the root never lands inside an existing workspace', () => {
  // The resolver main() binds, with a temp home for the fallback root.
  const home = path.join(tmp, 'home');
  const savedHome = process.env.HOME;
  const savedRoot = process.env.HAPPYCLAW_WORKSPACE_ROOT;

  beforeAll(() => fs.mkdirSync(home, { recursive: true }));
  beforeEach(() => {
    process.env.HOME = home;
    dir.setWorkspaceRootResolver(
      () =>
        workspaceRoot.getWorkspaceRootResolution(
          dir.getWorkspaceRootOccupancy(),
        ).effective,
    );
  });
  afterAll(() => {
    process.env.HOME = savedHome;
    if (savedRoot === undefined) delete process.env.HAPPYCLAW_WORKSPACE_ROOT;
    else process.env.HAPPYCLAW_WORKSPACE_ROOT = savedRoot;
  });

  test('occupancy lists custom directories, mounts, workdirs and roots', () => {
    db.setRegisteredGroup('web:occ', {
      name: 'occ',
      folder: 'occ',
      added_at: NOW,
      executionMode: 'container',
      created_by: 'admin-1',
      containerConfig: {
        version: 1,
        additionalMounts: [
          { hostPath: '/srv/mounted', containerPath: 'm', readonly: true },
        ],
      },
    } as Parameters<typeof db.setRegisteredGroup>[1]);
    db.setRegisteredGroup('web:occ-cwd', {
      name: 'occ cwd',
      folder: 'occ-cwd',
      added_at: NOW,
      executionMode: 'host',
      customCwd: '/srv/repo',
      created_by: 'admin-1',
    });
    try {
      const occupancy = dir.getWorkspaceRootOccupancy();
      expect(occupancy.occupiedPaths).toEqual(
        expect.arrayContaining(['/srv/mounted', '/srv/repo']),
      );
      const recorded = dir.getRecordedWorkdirRecord('flow-host')!;
      expect(occupancy.workdirs).toContainEqual({
        workdir: recorded.workdir,
        root: recorded.root,
      });
      expect(occupancy.knownRoots).toEqual(
        expect.arrayContaining([rootA, rootB]),
      );
    } finally {
      db.deleteGroupData('web:occ', 'occ');
      db.deleteGroupData('web:occ-cwd', 'occ-cwd');
    }
  });

  test('a root set inside workspace X is refused, and deleting X keeps Y', () => {
    const rootH = path.join(home, 'hc');
    process.env.HAPPYCLAW_WORKSPACE_ROOT = rootH;
    const x = dir.assignWorkspaceRootDir('flow-x');
    expect(x).toBe(path.join(rootH, 'flow-x'));
    expect(fs.existsSync(path.join(rootH, WORKSPACE_ROOT_MARKER))).toBe(true);

    const inside = path.join(x, 'sub');
    expect(
      workspaceRoot.validateWorkspaceRootSetting(
        inside,
        dir.getWorkspaceRootOccupancy(),
      ),
    ).toBe('overlaps_workspace_paths');

    // Even if it comes from the environment, the effective root avoids X.
    process.env.HAPPYCLAW_WORKSPACE_ROOT = inside;
    const y = dir.assignWorkspaceRootDir('flow-y');
    expect(y.startsWith(x + path.sep)).toBe(false);
    const yFile = path.join(y, 'y.txt');
    fs.writeFileSync(yFile, 'y');

    const record = dir.getRecordedWorkdirRecord('flow-x')!;
    expect(dir.checkRecordedWorkdirRemoval(record)).toBeNull();
    removeFlowArtifacts('flow-x', record);
    expect(fs.existsSync(yFile)).toBe(true);
  });

  test("a workdir holding another folder's workdir is not removed", () => {
    const rootH = path.join(home, 'hc');
    process.env.HAPPYCLAW_WORKSPACE_ROOT = rootH;
    const outer = dir.assignWorkspaceRootDir('flow-outer');
    const nestedRoot = path.join(outer, 'nested');
    fs.mkdirSync(nestedRoot, { recursive: true });
    const conn = new Database(path.join(storeDir, 'messages.db'));
    try {
      conn
        .prepare(
          'INSERT INTO workspace_workdirs (folder, workdir, root, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(
          'flow-inner',
          path.join(nestedRoot, 'flow-inner'),
          nestedRoot,
          NOW,
        );
    } finally {
      conn.close();
    }
    const innerFile = path.join(nestedRoot, 'flow-inner', 'inner.txt');
    fs.mkdirSync(path.dirname(innerFile), { recursive: true });
    fs.writeFileSync(innerFile, 'inner');

    const record = dir.getRecordedWorkdirRecord('flow-outer')!;
    expect(dir.checkRecordedWorkdirRemoval(record)).toBe(
      'overlaps_other_workspace',
    );
    removeFlowArtifacts('flow-outer', record);
    expect(fs.existsSync(innerFile)).toBe(true);
  });

  test('a root that cannot be created leaves the workspace in data/groups', () => {
    const blocker = path.join(tmp, 'blocker-file');
    fs.writeFileSync(blocker, 'not a directory');
    vi.mocked(logger.warn).mockClear();
    dir.setWorkspaceRootResolver(() => path.join(blocker, 'root'));
    expect(dir.assignWorkspaceRootDir('flow-no-root')).toBe(
      path.join(groupsDir, 'flow-no-root'),
    );
    expect(dir.getRecordedWorkdir('flow-no-root')).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});
