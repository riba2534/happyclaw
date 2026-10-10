import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

import { isClaudeAttachmentPassDisabled } from '../container/agent-runner/src/claude-attachments.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function configDir(env?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-attachments-'));
  dirs.push(dir);
  if (env) writeFileSync(join(dir, 'settings.json'), JSON.stringify({ env }));
  return dir;
}

test('attachments are on when neither the process nor user settings disable them', () => {
  expect(isClaudeAttachmentPassDisabled({}, configDir())).toBe(false);
  expect(
    isClaudeAttachmentPassDisabled(
      {},
      configDir({ CLAUDE_CODE_DISABLE_ATTACHMENTS: '0' }),
    ),
  ).toBe(false);
});

test('detects the kill switch in the process env or the user settings env', () => {
  expect(
    isClaudeAttachmentPassDisabled(
      { CLAUDE_CODE_DISABLE_ATTACHMENTS: 'true' },
      configDir(),
    ),
  ).toBe(true);
  expect(
    isClaudeAttachmentPassDisabled(
      {},
      configDir({ CLAUDE_CODE_DISABLE_ATTACHMENTS: '1' }),
    ),
  ).toBe(true);
});

test('a torn settings file does not count as disabled', () => {
  const dir = configDir();
  writeFileSync(join(dir, 'settings.json'), '{"env":');
  expect(isClaudeAttachmentPassDisabled({}, dir)).toBe(false);
});
