import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  buildClaudeContextPlan,
  syncHostClaudeContext,
} from '../src/claude-context-resolver.js';

function writeFile(file: string, text = 'x'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function makeSkill(root: string, name: string): void {
  writeFile(path.join(root, name, 'SKILL.md'), `# ${name}`);
}

function fakeGroup(folder: string, ownerId: string, isHome = false) {
  return {
    name: folder,
    folder,
    added_at: '2026-05-18T00:00:00.000Z',
    created_by: ownerId,
    is_home: isHome,
  };
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-context-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ClaudeContextResolver', () => {
  test('host sync links admin CLAUDE.md/rules/skills from the effective external dir', () => {
    const external = path.join(tmp, 'external-claude');
    const dataDir = path.join(tmp, 'data');
    const projectRoot = path.join(tmp, 'project');
    const sessionDir = path.join(tmp, 'sessions', 'main', '.claude');

    writeFile(path.join(external, 'CLAUDE.md'), '# admin playbook');
    writeFile(path.join(external, 'rules', 'browser.md'), '# browser rule');
    makeSkill(path.join(external, 'skills'), 'external-skill');
    makeSkill(path.join(dataDir, 'builtin-skills'), 'builtin-skill');
    makeSkill(path.join(projectRoot, 'container', 'skills'), 'project-skill');
    makeSkill(path.join(dataDir, 'skills', 'admin'), 'user-skill');

    const plan = buildClaudeContextPlan({
      executionMode: 'host',
      group: fakeGroup('main', 'admin', true) as any,
      ownerHomeFolder: 'main',
      externalClaudeDir: external,
      projectRoot,
      dataDir,
      groupSessionsDir: sessionDir,
    });
    const sync = syncHostClaudeContext(plan, sessionDir);

    expect(sync.claudeMdStatus).toBe('linked');
    expect(fs.readlinkSync(path.join(sessionDir, 'CLAUDE.md'))).toBe(path.join(external, 'CLAUDE.md'));
    expect(fs.readlinkSync(path.join(sessionDir, 'rules', 'browser.md'))).toBe(path.join(external, 'rules', 'browser.md'));
    expect(fs.readlinkSync(path.join(sessionDir, 'skills', 'builtin-skill'))).toBe(path.join(dataDir, 'builtin-skills', 'builtin-skill'));
    expect(fs.readlinkSync(path.join(sessionDir, 'skills', 'external-skill'))).toBe(path.join(external, 'skills', 'external-skill'));
    expect(fs.readlinkSync(path.join(sessionDir, 'skills', 'project-skill'))).toBe(path.join(projectRoot, 'container', 'skills', 'project-skill'));
    expect(fs.readlinkSync(path.join(sessionDir, 'skills', 'user-skill'))).toBe(path.join(dataDir, 'skills', 'admin', 'user-skill'));
  });

  test('host sync preserves a real session CLAUDE.md and reports shadowed', () => {
    const external = path.join(tmp, 'external-claude');
    const sessionDir = path.join(tmp, 'sessions', 'main', '.claude');
    writeFile(path.join(external, 'CLAUDE.md'), '# external');
    writeFile(path.join(sessionDir, 'CLAUDE.md'), '# local');

    const plan = buildClaudeContextPlan({
      executionMode: 'host',
      group: fakeGroup('main', 'admin', true) as any,
      ownerHomeFolder: 'main',
      externalClaudeDir: external,
      projectRoot: path.join(tmp, 'project'),
      dataDir: path.join(tmp, 'data'),
      groupSessionsDir: sessionDir,
    });
    const sync = syncHostClaudeContext(plan, sessionDir);

    expect(sync.claudeMdStatus).toBe('shadowed');
    expect(sync.warnings).toContain('CLAUDE.md shadowed by session file');
    expect(fs.lstatSync(path.join(sessionDir, 'CLAUDE.md')).isSymbolicLink()).toBe(false);
  });

  test('container plan mounts admin triad but does not expose it to ordinary users', () => {
    const external = path.join(tmp, 'external-claude');
    writeFile(path.join(external, 'CLAUDE.md'), '# admin');
    writeFile(path.join(external, 'rules', 'r.md'), '# rule');
    makeSkill(path.join(external, 'skills'), 'external-skill');

    const adminPlan = buildClaudeContextPlan({
      executionMode: 'container',
      group: fakeGroup('main', 'admin', true) as any,
      ownerHomeFolder: 'main',
      externalClaudeDir: external,
      projectRoot: path.join(tmp, 'project'),
      dataDir: path.join(tmp, 'data'),
      groupSessionsDir: path.join(tmp, 'sessions', 'main', '.claude'),
    });
    expect(adminPlan.audit.claudeMd).toMatchObject({
      sourcePath: path.join(external, 'CLAUDE.md'),
      runtimePath: '/workspace/CLAUDE.md',
      status: 'mounted',
    });
    expect(adminPlan.audit.rules).toMatchObject({
      sourcePath: path.join(external, 'rules'),
      runtimePath: '/workspace/.claude/rules',
      status: 'mounted',
      fileCount: 1,
    });
    expect(adminPlan.audit.skills.sources.some((source) => source.name === 'external')).toBe(true);

    const userPlan = buildClaudeContextPlan({
      executionMode: 'container',
      group: fakeGroup('alice-home', 'alice', true) as any,
      ownerHomeFolder: 'alice-home',
      externalClaudeDir: external,
      projectRoot: path.join(tmp, 'project'),
      dataDir: path.join(tmp, 'data'),
      groupSessionsDir: path.join(tmp, 'sessions', 'alice-home', '.claude'),
    });
    expect(userPlan.audit.claudeMd.status).toBe('unavailable');
    expect(userPlan.audit.externalClaudeDir).toBeUndefined();
    expect(userPlan.audit.claudeMd.sourcePath).toBeUndefined();
    expect(userPlan.audit.rules.status).toBe('unavailable');
    expect(userPlan.audit.skills.sources.some((source) => source.name === 'external')).toBe(false);
  });
});
