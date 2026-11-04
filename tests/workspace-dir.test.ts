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
  /** Record `workdir` for `folder` as a forged or damaged row would. */
  function forge(folder: string, workdir: string): void {
    dir.deleteRecordedWorkdir(folder);
    const conn = new Database(path.join(storeDir, 'messages.db'));
    try {
      conn
        .prepare(
          'INSERT INTO workspace_workdirs (folder, workdir, created_at) VALUES (?, ?, ?)',
        )
        .run(folder, workdir, NOW);
    } finally {
      conn.close();
    }
  }

  function withFile(target: string): string {
    fs.mkdirSync(target, { recursive: true });
    const file = path.join(target, 'keep.txt');
    fs.writeFileSync(file, 'user data');
    return file;
  }

  test('the directory HappyClaw made is removed with its logs', () => {
    const workdir = dir.assignWorkspaceRootDir('flow-remove-ok');
    withFile(workdir);
    withFile(path.join(dataDir, 'logs', 'flow-remove-ok'));
    expect(
      dir.checkRecordedWorkdirRemoval('flow-remove-ok', workdir),
    ).toBeNull();
    removeFlowArtifacts('flow-remove-ok', workdir);
    expect(fs.existsSync(workdir)).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'logs', 'flow-remove-ok'))).toBe(
      false,
    );
  });

  test('a wrong basename is refused and nothing is removed', () => {
    const elsewhere = path.join(rootA, 'someone-else');
    const file = withFile(elsewhere);
    forge('flow-basename', elsewhere);
    expect(dir.checkRecordedWorkdirRemoval('flow-basename', elsewhere)).toBe(
      'basename_mismatch',
    );
    removeFlowArtifacts('flow-basename', elsewhere);
    expect(fs.existsSync(file)).toBe(true);
  });

  test('a directory outside every known root is refused', () => {
    const outside = path.join(tmp, 'projects', 'flow-outside');
    const file = withFile(outside);
    forge('flow-outside', outside);
    expect(dir.checkRecordedWorkdirRemoval('flow-outside', outside)).toBe(
      'outside_known_root',
    );
    removeFlowArtifacts('flow-outside', outside);
    expect(fs.existsSync(file)).toBe(true);
  });

  test('a symlink, or a parent link that leaves the root, is refused', () => {
    const target = path.join(tmp, 'precious', 'flow-link');
    const file = withFile(target);
    const link = path.join(rootA, 'flow-link');
    fs.mkdirSync(rootA, { recursive: true });
    fs.symlinkSync(target, link);
    forge('flow-link', link);
    expect(dir.checkRecordedWorkdirRemoval('flow-link', link)).toBe('symlink');
    removeFlowArtifacts('flow-link', link);
    expect(fs.existsSync(file)).toBe(true);

    // rootA/escape -> tmp/precious: rootA/escape/flow-parent really lives
    // in tmp/precious, which is no root.
    const parentTarget = path.join(tmp, 'precious', 'flow-parent');
    const parentFile = withFile(parentTarget);
    fs.symlinkSync(path.join(tmp, 'precious'), path.join(rootA, 'escape'));
    const viaLink = path.join(rootA, 'escape', 'flow-parent');
    forge('flow-parent', viaLink);
    expect(dir.checkRecordedWorkdirRemoval('flow-parent', viaLink)).toBe(
      'outside_known_root',
    );
    removeFlowArtifacts('flow-parent', viaLink);
    expect(fs.existsSync(parentFile)).toBe(true);
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
      expect(dir.checkRecordedWorkdirRemoval('flow-cwd', workdir)).toBe(
        'custom_cwd',
      );
      removeFlowArtifacts('flow-cwd', workdir);
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      db.deleteGroupData('web:uses-it', 'uses-it');
    }
  });

  test('a directory inside the install is refused', () => {
    currentRoot = path.join(dataDir, 'roots');
    const workdir = dir.assignWorkspaceRootDir('flow-install');
    const file = withFile(workdir);
    expect(dir.checkRecordedWorkdirRemoval('flow-install', workdir)).toBe(
      'install_dir',
    );
    removeFlowArtifacts('flow-install', workdir);
    expect(fs.existsSync(file)).toBe(true);
  });

  test('assertRecordedWorkdirRemovable throws UnsafeWorkdirError', () => {
    expect(() =>
      dir.assertRecordedWorkdirRemovable('flow-x', path.join(rootA, 'other')),
    ).toThrow(dir.UnsafeWorkdirError);
  });
});
