import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  findClaudeMdExcludeLeaks,
  resolveHostClaudeMdExcludes,
} from '../container/agent-runner/src/claude-memory-policy.js';

describe('host Claude memory policy', () => {
  test('excludes OS-home and configured host instructions in managed mode', () => {
    expect(
      resolveHostClaudeMdExcludes({
        executionMode: 'host',
        runtimePolicy: { context: { source: 'managed' } },
        homeDir: '/Users/operator',
        externalClaudeDir: '/Volumes/config/claude',
        projectRoot: '/Users/operator/airepo/happyclaw',
      }),
    ).toEqual([
      path.join('/Users/operator/.claude', 'CLAUDE.md'),
      path.join('/Users/operator/.claude', 'rules', '**'),
      path.join('/Volumes/config/claude', 'CLAUDE.md'),
      path.join('/Volumes/config/claude', 'rules', '**'),
      path.join('/Users/operator/airepo/happyclaw', 'CLAUDE.md'),
      path.join('/Users/operator/airepo/happyclaw', '.claude', 'CLAUDE.md'),
      path.join('/Users/operator/airepo/happyclaw', 'CLAUDE.local.md'),
      path.join('/Users/operator/airepo/happyclaw', '.claude', 'rules', '**'),
    ]);
  });

  test('keeps workspace-local memory while excluding only platform project memory', () => {
    const groupWorkspace =
      '/Users/operator/airepo/happyclaw/data/groups/address-agent';
    const excludes = resolveHostClaudeMdExcludes({
      executionMode: 'host',
      runtimePolicy: { context: { source: 'managed' } },
      homeDir: '/Users/operator',
      projectRoot: '/Users/operator/airepo/happyclaw',
    });

    expect(excludes).not.toContain(path.join(groupWorkspace, 'CLAUDE.md'));
    expect(excludes).toContain(
      path.join('/Users/operator/airepo/happyclaw', 'CLAUDE.md'),
    );
  });

  test('treats a missing legacy context source as managed and deduplicates roots', () => {
    expect(
      resolveHostClaudeMdExcludes({
        executionMode: 'host',
        runtimePolicy: {},
        homeDir: '/Users/operator',
        externalClaudeDir: '/Users/operator/.claude',
      }),
    ).toEqual([
      path.join('/Users/operator/.claude', 'CLAUDE.md'),
      path.join('/Users/operator/.claude', 'rules', '**'),
    ]);
  });

  test('host_claude keeps the host user memory but still excludes the platform repository', () => {
    const excludes = resolveHostClaudeMdExcludes({
      executionMode: 'host',
      runtimePolicy: { context: { source: 'host_claude' } },
      homeDir: '/Users/operator',
      externalClaudeDir: '/Volumes/config/claude',
      projectRoot: '/Users/operator/airepo/happyclaw',
    });

    expect(excludes).toEqual([
      path.join('/Users/operator/airepo/happyclaw', 'CLAUDE.md'),
      path.join('/Users/operator/airepo/happyclaw', '.claude', 'CLAUDE.md'),
      path.join('/Users/operator/airepo/happyclaw', 'CLAUDE.local.md'),
      path.join('/Users/operator/airepo/happyclaw', '.claude', 'rules', '**'),
    ]);
    expect(
      findClaudeMdExcludeLeaks(
        [
          { path: '/Users/operator/.claude/CLAUDE.md' },
          { path: '/Users/operator/.claude/rules/basics.md' },
          { path: '/Users/operator/airepo/happyclaw/CLAUDE.md' },
          {
            path: '/Users/operator/airepo/happyclaw/data/groups/main/CLAUDE.md',
          },
        ],
        excludes,
      ),
    ).toEqual(['/Users/operator/airepo/happyclaw/CLAUDE.md']);
    expect(
      resolveHostClaudeMdExcludes({
        executionMode: 'host',
        runtimePolicy: { context: { source: 'host_claude' } },
        homeDir: '/Users/operator',
      }),
    ).toEqual([]);
  });

  test('ignores container runs', () => {
    for (const source of ['managed', 'host_claude']) {
      expect(
        resolveHostClaudeMdExcludes({
          executionMode: 'container',
          runtimePolicy: { context: { source } },
          homeDir: '/home/node',
          projectRoot: '/app',
        }),
      ).toEqual([]);
    }
  });

  test('detects an SDK memory file that escaped the applied exclusions', () => {
    expect(
      findClaudeMdExcludeLeaks(
        [
          { path: '/repo/CLAUDE.md' },
          { path: '/repo/.claude/rules/runtime.md' },
          { path: '/repo/data/groups/address/CLAUDE.md' },
        ],
        ['/repo/CLAUDE.md', path.join('/repo/.claude/rules', '**')],
      ),
    ).toEqual([
      path.normalize('/repo/CLAUDE.md'),
      path.normalize('/repo/.claude/rules/runtime.md'),
    ]);
  });

  test('emits portable picomatch patterns for Windows host paths', () => {
    const excludes = resolveHostClaudeMdExcludes({
      executionMode: 'host',
      runtimePolicy: { context: { source: 'managed' } },
      homeDir: 'C:\\Users\\operator',
      externalClaudeDir: 'D:\\Claude',
      projectRoot: 'C:\\code\\happyclaw',
    });

    expect(excludes).toContain('C:/Users/operator/.claude/CLAUDE.md');
    expect(excludes).toContain('D:/Claude/rules/**');
    expect(excludes).toContain('C:/code/happyclaw/.claude/rules/**');
    expect(excludes.every((entry) => !entry.includes('\\'))).toBe(true);
    expect(
      findClaudeMdExcludeLeaks(
        [{ path: 'C:\\code\\happyclaw\\.claude\\rules\\agent.md' }],
        excludes,
      ),
    ).toEqual(['C:/code/happyclaw/.claude/rules/agent.md']);
  });
});
