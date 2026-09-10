import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, test } from 'vitest';

import {
  FRESH_WINDOW_HANDOFF_MARKER,
  captureWorkspaceSnapshot,
  formatFreshWindowHandoff,
} from '../container/agent-runner/src/fresh-window.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-fresh-window-'));
  tmpDirs.push(dir);
  return dir;
}

describe('formatFreshWindowHandoff', () => {
  test('includes marker, notes, next focus, and git snapshot', () => {
    const text = formatFreshWindowHandoff({
      notes: '已修好登录',
      nextFocus: '下一步做支付',
      snapshot: {
        available: true,
        branch: 'main',
        commit: 'abc1234',
        statusLines: [' M src/foo.ts', '?? bar.ts'],
      },
    });

    expect(text).toContain(FRESH_WINDOW_HANDOFF_MARKER);
    expect(text).toContain('## Notes');
    expect(text).toContain('已修好登录');
    expect(text).toContain('## Next focus');
    expect(text).toContain('下一步做支付');
    expect(text).toContain('branch: main');
    expect(text).toContain('commit: abc1234');
    expect(text).toContain('M src/foo.ts');
    expect(text).toContain('?? bar.ts');
    expect(text).toMatch(/not summarized/i);
  });

  test('omits next focus when empty and degrades missing snapshot', () => {
    const text = formatFreshWindowHandoff({
      notes: '  ',
      snapshot: { available: false, reason: 'not a git repository' },
    });

    expect(text).toContain('## Notes');
    expect(text).toContain('(none)');
    expect(text).not.toContain('## Next focus');
    expect(text).toContain('(not a git repository)');
  });
});

describe('captureWorkspaceSnapshot', () => {
  test('non-git directory degrades without throwing', async () => {
    const dir = tmpDir();
    const snapshot = await captureWorkspaceSnapshot(dir);
    expect(snapshot.available).toBe(false);
    expect(snapshot.reason).toBe('not a git repository');
  });

  test('missing cwd degrades', async () => {
    const snapshot = await captureWorkspaceSnapshot('');
    expect(snapshot.available).toBe(false);
  });

  test('git repository reports branch, commit, and status', async () => {
    const dir = tmpDir();
    try {
      execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
      fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
      execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
      execFileSync(
        'git',
        [
          '-c',
          'user.email=fresh-window@test.local',
          '-c',
          'user.name=Fresh Window',
          'commit',
          '-m',
          'init',
        ],
        {
          cwd: dir,
          stdio: 'ignore',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Fresh Window',
            GIT_AUTHOR_EMAIL: 'fresh-window@test.local',
            GIT_COMMITTER_NAME: 'Fresh Window',
            GIT_COMMITTER_EMAIL: 'fresh-window@test.local',
          },
        },
      );
      fs.writeFileSync(path.join(dir, 'dirty.txt'), 'x\n');
    } catch {
      return;
    }

    const snapshot = await captureWorkspaceSnapshot(dir);
    expect(snapshot.available).toBe(true);
    expect(snapshot.branch).toMatch(/^(main|master|HEAD)$/);
    expect(snapshot.commit).toMatch(/^[0-9a-f]{4,40}$/);
    expect(
      snapshot.statusLines?.some((line) => line.includes('dirty.txt')),
    ).toBe(true);
  });
});
