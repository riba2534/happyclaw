import fs from 'fs';
import path from 'path';
import type { ChildProcess } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testPaths = vi.hoisted(() => ({
  dataDir: `/tmp/happyclaw-group-queue-runtime-test-${process.pid}`,
  hasPendingConversationRuntimeBinding: vi.fn(() => false),
}));

vi.mock('../src/config.js', () => ({
  DATA_DIR: testPaths.dataDir,
}));

vi.mock('../src/db.js', () => ({
  getTaskById: vi.fn(),
  hasPendingConversationRuntimeBinding:
    testPaths.hasPendingConversationRuntimeBinding,
}));

vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: vi.fn(() => ({
    maxConcurrentHostProcesses: 10,
    maxConcurrentContainers: 10,
  })),
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { GroupQueue } from '../src/group-queue.js';

function fakeProcess(): ChildProcess {
  return {} as ChildProcess;
}

describe('GroupQueue runtime live-input boundary', () => {
  beforeEach(() => {
    fs.rmSync(testPaths.dataDir, { recursive: true, force: true });
    fs.mkdirSync(testPaths.dataDir, { recursive: true });
    testPaths.hasPendingConversationRuntimeBinding.mockReturnValue(false);
  });

  afterEach(() => {
    fs.rmSync(testPaths.dataDir, { recursive: true, force: true });
  });

  it('keeps Claude runners eligible for live IPC injection', () => {
    const queue = new GroupQueue();
    queue.registerProcess('web:flow-test', fakeProcess(), {
      containerName: null,
      groupFolder: 'flow-test',
      runtime: 'claude',
    });
    (queue as any).groups.get('web:flow-test').active = true;

    const result = queue.sendMessage('web:flow-test', 'follow up');

    expect(result).toBe('sent');
    const inputDir = path.join(
      testPaths.dataDir,
      'ipc',
      'flow-test',
      'input',
    );
    expect(fs.readdirSync(inputDir).some((file) => file.endsWith('.json'))).toBe(
      true,
    );
  });

  it('defers live IPC injection for one-turn Codex runners', () => {
    const queue = new GroupQueue();
    queue.registerProcess('web:flow-test', fakeProcess(), {
      containerName: null,
      groupFolder: 'flow-test',
      runtime: 'codex',
    });
    (queue as any).groups.get('web:flow-test').active = true;

    const result = queue.sendMessage('web:flow-test', 'follow up');

    expect(result).toBe('no_active');
    const inputDir = path.join(
      testPaths.dataDir,
      'ipc',
      'flow-test',
      'input',
    );
    expect(fs.existsSync(path.join(inputDir, '_drain'))).toBe(true);
    expect(
      fs.existsSync(inputDir) &&
        fs.readdirSync(inputDir).some((file) => file.endsWith('.json')),
    ).toBe(false);
  });

  it('drains a stale Claude runner when a model switch is pending', () => {
    testPaths.hasPendingConversationRuntimeBinding.mockReturnValue(true);

    const queue = new GroupQueue();
    queue.registerProcess('web:flow-test', fakeProcess(), {
      containerName: null,
      groupFolder: 'flow-test',
      runtime: 'claude',
    });
    (queue as any).groups.get('web:flow-test').active = true;

    const result = queue.sendMessage('web:flow-test', 'follow up');

    expect(result).toBe('no_active');
    expect(testPaths.hasPendingConversationRuntimeBinding).toHaveBeenCalledWith(
      'flow-test',
      null,
    );
    const inputDir = path.join(
      testPaths.dataDir,
      'ipc',
      'flow-test',
      'input',
    );
    expect(fs.existsSync(path.join(inputDir, '_drain'))).toBe(true);
    expect(
      fs.existsSync(inputDir) &&
        fs.readdirSync(inputDir).some((file) => file.endsWith('.json')),
    ).toBe(false);
  });
});
