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
  'output.assistant.md',
  'output.proactive.md',
  'output.task.md',
  'web-fetch.md',
  'background-tasks.md',
  'delivery-contract.assistant.md',
  'delivery-contract.proactive.md',
  'memory-system.home.md',
  'memory-system.guest.md',
];

const REQUIRED_CHANNELS = [
  'feishu',
  'telegram',
  'qq',
  'wechat',
  'dingtalk',
  'discord',
  'whatsapp',
];

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
      expect(
        fs.existsSync(fullPath),
        `channels/${channel}.md should exist`,
      ).toBe(true);
      const content = fs.readFileSync(fullPath, 'utf-8').trim();
      expect(
        content.length,
        `${channel}.md should be non-empty`,
      ).toBeGreaterThan(0);
    }
  });

  test('no prompt file contains lone UTF-16 surrogates (would break Anthropic API)', () => {
    const allFiles = listMarkdownFiles(PROMPTS_DIR);
    expect(allFiles.length).toBeGreaterThan(0);

    for (const file of allFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const matches = content.match(LONE_SURROGATE_RE);
      expect(
        matches,
        `${path.relative(PROMPTS_DIR, file)} contains lone surrogates`,
      ).toBeNull();
    }
  });

  test('platform prompt patches do not duplicate user rules or skill bodies', () => {
    const webFetch = fs.readFileSync(
      path.join(PROMPTS_DIR, 'web-fetch.md'),
      'utf-8',
    );
    const homeMemory = fs.readFileSync(
      path.join(PROMPTS_DIR, 'memory-system.home.md'),
      'utf-8',
    );
    const guestMemory = fs.readFileSync(
      path.join(PROMPTS_DIR, 'memory-system.guest.md'),
      'utf-8',
    );

    expect(webFetch).not.toContain('WebFetch');
    expect(webFetch).not.toContain('web-content-fetcher');
    expect(homeMemory).toContain(
      '不等同于用户原生 `~/.claude/CLAUDE.md` playbook',
    );
    expect(guestMemory).toContain(
      '不等同于用户原生 `~/.claude/CLAUDE.md` playbook',
    );
  });

  test('reply-mode contracts are explicit delivery rules, not identity prompts', () => {
    const assistant = fs.readFileSync(
      path.join(PROMPTS_DIR, 'delivery-contract.assistant.md'),
      'utf-8',
    );
    const proactive = fs.readFileSync(
      path.join(PROMPTS_DIR, 'delivery-contract.proactive.md'),
      'utf-8',
    );
    const assistantOutput = fs.readFileSync(
      path.join(PROMPTS_DIR, 'output.assistant.md'),
      'utf-8',
    );
    const proactiveOutput = fs.readFileSync(
      path.join(PROMPTS_DIR, 'output.proactive.md'),
      'utf-8',
    );
    const taskOutput = fs.readFileSync(
      path.join(PROMPTS_DIR, 'output.task.md'),
      'utf-8',
    );
    expect(assistant).toContain('Assistant reply mode');
    expect(assistant).toContain('automatically publishes');
    expect(proactive).toContain('Proactive reply mode');
    expect(proactive).toContain('only way for you to say something');
    expect(proactive).toContain('zero, one, or many messages');
    expect(assistantOutput).toContain('最终回复必须自包含');
    expect(proactiveOutput).toContain('真实对话参与者');
    expect(proactiveOutput).toContain(
      '[Your previous response had no visible output.',
    );
    expect(proactiveOutput).toContain('在第一个可能明显耗时的工具调用前');
    expect(proactive).not.toContain('minimal internal acknowledgement');
    expect(proactiveOutput).not.toContain('最终回复必须自包含');
    expect(taskOutput).toContain('最终 SDK Assistant 文本不会自动发送');
    for (const delivery of [assistant, proactive]) {
      expect(delivery).toContain('not an identity or personality instruction');
      expect(delivery).not.toContain('person-like');
      expect(delivery).not.toContain('最高优先级');
      expect(delivery).not.toContain('子会话');
      expect(delivery).not.toContain('简体中文');
    }
  });
});

describe('rules that must survive prompt-variant splits', () => {
  const readPrompt = (name: string): string =>
    fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf-8');

  test('every output variant forbids absolute image paths', () => {
    // Splitting output.md into three mutually exclusive variants left this
    // rule in the assistant one only, so tasks and proactive turns emitted
    // /workspace/... references that render as broken images. The rule has to
    // hold wherever an agent can write Markdown, not just in one variant.
    for (const name of [
      'output.assistant.md',
      'output.proactive.md',
      'output.task.md',
    ]) {
      const body = readPrompt(name);
      expect(body, `${name} must forbid absolute image paths`).toContain(
        '绝对路径',
      );
      expect(body, `${name} must show the relative form`).toContain(
        '![描述](filename.png)',
      );
    }
  });

  test('every delivery surface forbids guessing the target id', () => {
    // Repo CLAUDE.md §6.2: file/image delivery must use the current turn's
    // ChannelTurnContext and must not guess the target from recent messages.
    // The prompt-side reinforcement of that rule was dropped when the single
    // delivery-contract.md became per-mode variants.
    for (const name of [
      'delivery-contract.assistant.md',
      'delivery-contract.proactive.md',
    ]) {
      expect(
        readPrompt(name),
        `${name} must forbid target-id guessing`,
      ).toMatch(/never guess or rewrite the target id/i);
    }
    // Task runs get no delivery contract — output.task.md carries the rule.
    expect(readPrompt('output.task.md')).toContain('不要猜测或改写目标 ID');
  });
});
