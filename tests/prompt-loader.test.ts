import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LONE_SURROGATE_RE } from '../container/agent-runner/src/session-history.js';

const PROMPTS_DIR = path.join(
  __dirname,
  '..',
  'container',
  'agent-runner',
  'prompts',
);

const REQUIRED_FILES = [
  'security-rules.md',
  'interaction.md',
  'skill-routing.md',
  'output.md',
  'web-fetch.md',
  'background-tasks.md',
  'agent-override.md',
  'memory-system.home.md',
  'memory-system.guest.md',
];

const REQUIRED_CHANNELS = ['feishu', 'telegram', 'qq', 'dingtalk'];

function listMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('prompts/ files', () => {
  test('all required top-level prompt files exist and are non-empty', () => {
    for (const file of REQUIRED_FILES) {
      const fullPath = path.join(PROMPTS_DIR, file);
      expect(fs.existsSync(fullPath), `${file} should exist`).toBe(true);
      const content = fs.readFileSync(fullPath, 'utf-8').trim();
      expect(content.length, `${file} should be non-empty`).toBeGreaterThan(0);
    }
  });

  test('all required channel files exist and are non-empty', () => {
    const channelsDir = path.join(PROMPTS_DIR, 'channels');
    expect(fs.existsSync(channelsDir), 'channels dir should exist').toBe(true);

    for (const channel of REQUIRED_CHANNELS) {
      const fullPath = path.join(channelsDir, `${channel}.md`);
      expect(fs.existsSync(fullPath), `channels/${channel}.md should exist`).toBe(true);
      const content = fs.readFileSync(fullPath, 'utf-8').trim();
      expect(content.length, `${channel}.md should be non-empty`).toBeGreaterThan(0);
    }
  });

  test('no prompt file contains lone UTF-16 surrogates (would break Anthropic API)', () => {
    const allFiles = listMarkdownFiles(PROMPTS_DIR);
    expect(allFiles.length).toBeGreaterThan(0);

    for (const file of allFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const matches = content.match(LONE_SURROGATE_RE);
      expect(matches, `${path.relative(PROMPTS_DIR, file)} contains lone surrogates`).toBeNull();
    }
  });

  test('platform prompt patches do not duplicate user rules or skill bodies', () => {
    const skillRouting = fs.readFileSync(path.join(PROMPTS_DIR, 'skill-routing.md'), 'utf-8');
    const webFetch = fs.readFileSync(path.join(PROMPTS_DIR, 'web-fetch.md'), 'utf-8');
    const homeMemory = fs.readFileSync(path.join(PROMPTS_DIR, 'memory-system.home.md'), 'utf-8');
    const guestMemory = fs.readFileSync(path.join(PROMPTS_DIR, 'memory-system.guest.md'), 'utf-8');

    expect(skillRouting).not.toContain('ToolSearch');
    expect(skillRouting).not.toContain('SKILL.md');
    expect(webFetch).not.toContain('WebFetch');
    expect(webFetch).not.toContain('web-content-fetcher');
    expect(homeMemory).toContain('不等同于用户原生 `~/.claude/CLAUDE.md` playbook');
    expect(guestMemory).toContain('不等同于用户原生 `~/.claude/CLAUDE.md` playbook');
  });
});
