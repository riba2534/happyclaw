import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();
const indexSource = fs.readFileSync(path.join(root, 'src', 'index.ts'), 'utf8');

function extractResultFilePrefixes(source: string): string[] {
  const start = source.indexOf('const RESULT_FILE_PREFIXES = [');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('];', start);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end + 2);
  return [...block.matchAll(/'([^']+_result_)'/g)].map((m) => m[1]);
}

describe('task IPC ACK self-reap allowlist', () => {
  test('RESULT_FILE_PREFIXES includes fresh_window and feishu_capability result files', () => {
    const prefixes = extractResultFilePrefixes(indexSource);
    expect(prefixes).toContain('fresh_window_result_');
    expect(prefixes).toContain('feishu_capability_result_');
  });

  test('fresh_window / feishu_capability result files are not treated as requests', () => {
    const prefixes = extractResultFilePrefixes(indexSource);
    const isResultFile = (name: string) =>
      prefixes.some((p) => name.startsWith(p));

    // Live fail-then-pass: without these prefixes the watcher would classify
    // the ACK as a request, processTaskIpc default-branch, then unlink it
    // before the runner's pollIpcResult read.
    expect(isResultFile('fresh_window_result_abc.json')).toBe(true);
    expect(isResultFile('feishu_capability_result_abc.json')).toBe(true);
    expect(isResultFile('fresh_window_req.json')).toBe(false);
    expect(isResultFile('feishu_capability_req.json')).toBe(false);

    const requestCandidates = [
      'fresh_window_result_abc.json',
      'feishu_capability_result_abc.json',
      'fresh_window.json',
    ].filter((name) => name.endsWith('.json') && !isResultFile(name));
    expect(requestCandidates).toEqual(['fresh_window.json']);
  });
});
