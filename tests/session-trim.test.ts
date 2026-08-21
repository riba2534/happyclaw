import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { trimSessionJsonl } from '../container/agent-runner/src/session-trim.js';

const TASK_ID = 'agent-bg-research-1';
const LAUNCH_UUID = 'async-launch-uuid';

function launchEntry(taskId = TASK_ID) {
  return {
    type: 'user',
    uuid: LAUNCH_UUID,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu-task-1',
          content: `Background agent launched: ${taskId}`,
        },
      ],
    },
    toolUseResult: {
      status: 'async_launched',
      agentId: taskId,
      taskId,
    },
  };
}

function dummyEntry(i: number) {
  return {
    type: 'user',
    uuid: `dummy-${i}`,
    message: { role: 'user', content: `dummy ${i}` },
  };
}

function compactBoundary() {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'compact-boundary-1',
    compact_metadata: { trigger: 'auto' },
  };
}

function taskNotification(taskId: string) {
  return {
    type: 'user',
    uuid: `task-notification-${taskId}`,
    message: {
      role: 'user',
      content: `<task-notification><task-id>${taskId}</task-id><status>completed</status></task-notification>`,
    },
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-trim-test-'));
});

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function writeJsonl(name: string, entries: object[]): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(
    filePath,
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
  return filePath;
}

function readJsonl(filePath: string): unknown[] {
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

describe('trimSessionJsonl', () => {
  test('keeps an unfinished async_launched Task line across compact_boundary', () => {
    const dummyCount = 50;
    const transcriptPath = writeJsonl('session.jsonl', [
      launchEntry(),
      ...Array.from({ length: dummyCount }, (_, i) => dummyEntry(i)),
      compactBoundary(),
    ]);

    trimSessionJsonl(transcriptPath, () => {});

    const kept = readJsonl(transcriptPath);
    const launchLines = kept.filter((entry) => {
      const result = (entry as { toolUseResult?: { status?: string } })
        .toolUseResult;
      return result?.status === 'async_launched';
    });

    expect(launchLines).toHaveLength(1);
    expect(
      (launchLines[0] as { toolUseResult: { agentId: string } }).toolUseResult
        .agentId,
    ).toBe(TASK_ID);
    expect(
      kept.some((entry) => (entry as { uuid?: string }).uuid === LAUNCH_UUID),
    ).toBe(true);
    expect(
      kept.some(
        (entry) =>
          (entry as { type?: string; subtype?: string }).type === 'system' &&
          (entry as { subtype?: string }).subtype === 'compact_boundary',
      ),
    ).toBe(true);
    expect(
      kept.some((entry) =>
        String((entry as { uuid?: string }).uuid ?? '').startsWith('dummy-'),
      ),
    ).toBe(false);
  });

  test('does not keep an async_launched line that already has a task-notification', () => {
    const transcriptPath = writeJsonl('completed.jsonl', [
      launchEntry(),
      ...Array.from({ length: 50 }, (_, i) => dummyEntry(i)),
      taskNotification(TASK_ID),
      compactBoundary(),
    ]);

    trimSessionJsonl(transcriptPath, () => {});

    const kept = readJsonl(transcriptPath);
    expect(
      kept.some(
        (entry) =>
          (entry as { toolUseResult?: { status?: string } }).toolUseResult
            ?.status === 'async_launched',
      ),
    ).toBe(false);
    expect(
      kept.some(
        (entry) =>
          (entry as { type?: string; subtype?: string }).subtype ===
          'compact_boundary',
      ),
    ).toBe(true);
  });
});
