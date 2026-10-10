import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import { splitMarkdownBlocks } from '../web/src/lib/markdown-blocks';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-snapshot-'));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...real,
    DATA_DIR: tmpDir,
    STORE_DIR: path.join(tmpDir, 'db'),
    GROUPS_DIR: path.join(tmpDir, 'groups'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { capSnapshotText } = await import('../src/web.js');

const FENCE = '```';

function reply(sections: number): string {
  const parts: string[] = [];
  for (let i = 0; i < sections; i += 1) {
    parts.push(`## 第 ${i} 节`);
    parts.push(`goroutine 并发监听同一个输入通道，第 ${i} 段说明。`.repeat(4));
    parts.push(`${FENCE}go\nfunc f${i}() {\n\n\treturn\n}\n${FENCE}`);
  }
  return parts.join('\n\n');
}

describe('reconnect snapshot text', () => {
  test('carries a reply past the old 4000-character tail in full', () => {
    const text = reply(60);
    expect(text.length).toBeGreaterThan(8000);
    expect(capSnapshotText(text)).toBe(text);
  });

  test('cuts an over-long reply at a block boundary, as markdownTail does', () => {
    const text = reply(120);
    const max = 5000;
    const cut = capSnapshotText(text, max);
    expect(cut.startsWith('…\n\n')).toBe(true);
    const body = cut.slice(3);
    expect(body.length).toBeLessThanOrEqual(max);
    expect(text.endsWith(body)).toBe(true);
    // It starts where a block starts, never inside a fence or a word.
    const blocks = splitMarkdownBlocks(text);
    expect(blocks.some((block) => body.startsWith(block))).toBe(true);
    expect(body.split(FENCE).length % 2).toBe(1);
  });

  test('re-opens the code fence when one block is longer than the budget', () => {
    const code = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    const text = `intro\n\n${FENCE}ts\n${code}\n${FENCE}\n`;
    const cut = capSnapshotText(text, 600);
    expect(cut.startsWith(`…\n\n${FENCE}ts\n`)).toBe(true);
    expect(cut.endsWith(`${FENCE}\n`)).toBe(true);
    expect(cut.split(FENCE).length % 2).toBe(1);
  });
});
