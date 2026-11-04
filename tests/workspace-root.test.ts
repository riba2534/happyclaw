import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  checkWorkspaceRootCandidate,
  ensureWorkspaceRootDir,
  resolveWorkspaceRoot,
  validateWorkspaceRootSetting,
  type WorkspaceRootContext,
} from '../src/workspace-root.js';

let tmp: string;
let context: WorkspaceRootContext;

beforeEach(() => {
  tmp = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hc-wsroot-')),
  );
  const home = path.join(tmp, 'home');
  const installDir = path.join(home, 'happyclaw');
  fs.mkdirSync(path.join(installDir, 'data'), { recursive: true });
  context = { home, installDir };
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const resolve = (configured: string, env?: string) =>
  resolveWorkspaceRoot({ configured, env, context });

describe('resolving the workspace root', () => {
  test('defaults to ~/happyclaw', () => {
    // Installed elsewhere, ~/happyclaw is free.
    fs.rmSync(context.installDir, { recursive: true });
    context = { ...context, installDir: path.join(tmp, 'opt', 'happyclaw') };
    fs.mkdirSync(context.installDir, { recursive: true });
    expect(resolve('')).toMatchObject({
      effective: path.join(context.home, 'happyclaw'),
      source: 'default',
      configured: null,
      fallbackReason: null,
    });
  });

  test('falls back when the default is the install directory itself', () => {
    expect(resolve('')).toMatchObject({
      effective: path.join(context.home, 'happyclaw-workspaces'),
      source: 'default',
      fallbackReason: 'inside_install_dir',
      fallbackWarning: null,
    });
  });

  test('the setting wins over the environment, the environment over the default', () => {
    const fromSetting = path.join(context.home, 'work', 'a');
    const fromEnv = path.join(context.home, 'work', 'b');
    expect(resolve(fromSetting, fromEnv)).toMatchObject({
      effective: fromSetting,
      source: 'settings',
      configured: fromSetting,
    });
    expect(resolve('', fromEnv)).toMatchObject({
      effective: fromEnv,
      source: 'env',
      configured: null,
    });
    expect(resolve('  ', '  ').source).toBe('default');
  });

  test('expands ~ and resolves symlinks before comparing', () => {
    expect(resolve('~/spaces').effective).toBe(
      path.join(context.home, 'spaces'),
    );
    const link = path.join(context.home, 'link-to-install');
    fs.symlinkSync(context.installDir, link);
    expect(resolve(path.join(link, 'ws')).fallbackReason).toBe(
      'inside_install_dir',
    );
  });

  test('an invalid environment value falls back and says why', () => {
    expect(resolve('', 'relative/dir')).toMatchObject({
      source: 'env',
      fallbackReason: 'not_absolute',
      effective: path.join(context.home, 'happyclaw-workspaces'),
    });
  });

  test('a fallback with its own problem is still used, with a warning', () => {
    fs.mkdirSync(path.join(context.home, '.git'));
    expect(resolve('')).toMatchObject({
      effective: path.join(context.home, 'happyclaw-workspaces'),
      fallbackReason: 'inside_install_dir',
      fallbackWarning: 'inside_git_repo',
    });
  });
});

describe('checking a candidate', () => {
  test.each([
    ['relative', 'not_absolute'],
    ['/', 'filesystem_root'],
  ] as const)('%s → %s', (candidate, problem) => {
    expect(checkWorkspaceRootCandidate(candidate, context)).toBe(problem);
  });

  test('the home directory itself is refused', () => {
    expect(checkWorkspaceRootCandidate('~', context)).toBe('home_dir');
    expect(checkWorkspaceRootCandidate(context.home, context)).toBe('home_dir');
  });

  test('anything inside the install directory is refused', () => {
    for (const candidate of [
      context.installDir,
      path.join(context.installDir, 'data'),
      path.join(context.installDir, 'data', 'groups'),
    ]) {
      expect(checkWorkspaceRootCandidate(candidate, context)).toBe(
        'inside_install_dir',
      );
    }
  });

  test('a CLAUDE.md in the directory or any parent is refused', () => {
    const parent = path.join(context.home, 'projects');
    fs.mkdirSync(parent, { recursive: true });
    const candidate = path.join(parent, 'spaces');
    expect(checkWorkspaceRootCandidate(candidate, context)).toBeNull();
    for (const memory of [
      'CLAUDE.md',
      'CLAUDE.local.md',
      path.join('.claude', 'CLAUDE.md'),
    ]) {
      const file = path.join(parent, memory);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '# notes\n');
      expect(checkWorkspaceRootCandidate(candidate, context)).toBe(
        'claude_md_ancestor',
      );
      fs.rmSync(file);
    }
  });

  test("the host user's own ~/.claude/CLAUDE.md is not a reason", () => {
    fs.mkdirSync(path.join(context.home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(context.home, '.claude', 'CLAUDE.md'), '# me\n');
    expect(
      checkWorkspaceRootCandidate(path.join(context.home, 'spaces'), context),
    ).toBeNull();
  });

  test('an ancestor of home or of the install is refused', () => {
    expect(
      checkWorkspaceRootCandidate(path.dirname(context.home), context),
    ).toBe('contains_home');
    context = { home: path.join(tmp, 'h2'), installDir: context.installDir };
    fs.mkdirSync(context.home);
    expect(checkWorkspaceRootCandidate(path.join(tmp, 'home'), context)).toBe(
      'contains_install_dir',
    );
  });

  test('a directory with someone’s own files is refused; an empty one is fine', () => {
    const notes = path.join(context.home, 'notes');
    fs.mkdirSync(notes);
    expect(checkWorkspaceRootCandidate(notes, context)).toBeNull();
    fs.writeFileSync(path.join(notes, 'todo.md'), '- buy milk\n');
    expect(checkWorkspaceRootCandidate(notes, context)).toBe('not_empty');
  });

  test('a dangling symlink is a problem, not a crash', () => {
    const link = path.join(context.home, 'gone');
    fs.symlinkSync(path.join(tmp, 'unmounted-drive'), link);
    expect(checkWorkspaceRootCandidate(link, context)).toBe('not_directory');
    expect(resolve(link).fallbackReason).toBe('not_directory');
  });

  test('a directory inside another git repository is refused', () => {
    const repo = path.join(context.home, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    expect(
      checkWorkspaceRootCandidate(path.join(repo, 'spaces'), context),
    ).toBe('inside_git_repo');
  });

  test('an existing file is refused', () => {
    const file = path.join(context.home, 'a-file');
    fs.writeFileSync(file, 'x');
    expect(checkWorkspaceRootCandidate(file, context)).toBe('not_directory');
  });

  test.skipIf(process.getuid?.() === 0)(
    'an unwritable location is refused',
    () => {
      const locked = path.join(context.home, 'locked');
      fs.mkdirSync(locked);
      fs.chmodSync(locked, 0o500);
      try {
        expect(
          checkWorkspaceRootCandidate(path.join(locked, 'spaces'), context),
        ).toBe('not_writable');
      } finally {
        fs.chmodSync(locked, 0o700);
      }
    },
  );
});

describe('saving and creating the root', () => {
  test("'' clears the setting; a bad value is refused", () => {
    expect(validateWorkspaceRootSetting('', {}, context)).toBeNull();
    expect(validateWorkspaceRootSetting('relative', {}, context)).toBe(
      'not_absolute',
    );
    expect(
      validateWorkspaceRootSetting(path.join(context.home, 'ok'), {}, context),
    ).toBeNull();
  });

  test('a root overlapping an existing custom directory or mount is refused', () => {
    const project = path.join(context.home, 'work', 'proj');
    fs.mkdirSync(project, { recursive: true });
    // Containing it means the root is not empty; inside it is an overlap.
    expect(
      validateWorkspaceRootSetting(
        path.join(context.home, 'work'),
        { occupiedPaths: [project] },
        context,
      ),
    ).toBe('not_empty');
    expect(
      validateWorkspaceRootSetting(
        path.join(project, 'spaces'),
        { occupiedPaths: [project] },
        context,
      ),
    ).toBe('overlaps_workspace_paths');
    expect(
      validateWorkspaceRootSetting(
        path.join(context.home, 'other'),
        { occupiedPaths: [project] },
        context,
      ),
    ).toBeNull();
  });

  test('a root inside another workspace or another root is refused; an old root itself is fine', () => {
    const oldRoot = path.join(context.home, 'happyclaw-old');
    const workdir = path.join(oldRoot, 'flow-a');
    fs.mkdirSync(workdir, { recursive: true });
    const occupancy = {
      workdirs: [{ workdir, root: oldRoot }],
      knownRoots: [oldRoot],
    };
    expect(
      validateWorkspaceRootSetting(
        path.join(workdir, 'sub'),
        occupancy,
        context,
      ),
    ).toBe('overlaps_workspace_paths');
    expect(
      validateWorkspaceRootSetting(
        path.join(oldRoot, 'nested'),
        occupancy,
        context,
      ),
    ).toBe('overlaps_workspace_paths');
    fs.writeFileSync(path.join(oldRoot, '.happyclaw-workspace-root'), '');
    // Switching back to the old root: its own workspaces are fine there.
    expect(
      validateWorkspaceRootSetting(oldRoot, occupancy, context),
    ).toBeNull();
  });

  test('a known root with workspaces in it stays valid without the marker', () => {
    const root = path.join(context.home, 'spaces');
    fs.mkdirSync(path.join(root, 'main'), { recursive: true });
    expect(checkWorkspaceRootCandidate(root, context)).toBe('not_empty');
    expect(
      checkWorkspaceRootCandidate(root, context, { knownRoots: [root] }),
    ).toBeNull();
    expect(
      resolveWorkspaceRoot({
        configured: root,
        env: undefined,
        context,
        occupancy: { knownRoots: [root] },
      }).effective,
    ).toBe(root);
  });

  test('the root is marked, so HappyClaw can tell it from a person’s folder', () => {
    const root = path.join(context.home, 'spaces');
    ensureWorkspaceRootDir(resolve(root));
    fs.mkdirSync(path.join(root, 'flow-a'));
    // Marked and in use: still a valid root.
    expect(checkWorkspaceRootCandidate(root, context)).toBeNull();
    expect(fs.existsSync(path.join(root, '.happyclaw-workspace-root'))).toBe(
      true,
    );
  });

  test('the effective root is created owner-only', () => {
    const resolution = resolve(path.join(context.home, 'new', 'root'));
    const dir = ensureWorkspaceRootDir(resolution);
    expect(dir).toBe(path.join(context.home, 'new', 'root'));
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });
});
