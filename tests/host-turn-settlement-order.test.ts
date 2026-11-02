import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const source = fs.readFileSync(
  path.join(process.cwd(), 'src/index.ts'),
  'utf8',
);

describe('Host turn settlement ordering', () => {
  test('warm IPC receipts commit only after the session output handler resolves', () => {
    const start = source.indexOf(
      'const wrappedOnOutput = async (output: ContainerOutput): Promise<void>',
    );
    const end = source.indexOf(
      'ipcWatcherManager?.watchRuntime(effectiveGroup.folder, { agentId })',
      start,
    );
    const wrapper = source.slice(start, end);

    expect(
      wrapper.indexOf('await handleAgentOutput(output);'),
    ).toBeGreaterThanOrEqual(0);
    expect(wrapper.indexOf('queue.acknowledgeIpcDeliveries(')).toBeGreaterThan(
      wrapper.indexOf('await handleAgentOutput(output);'),
    );
  });

  test('initializes IPC watching before automations and recovery can spawn runners', () => {
    const watcher = source.lastIndexOf('startIpcWatcher();');
    const scheduler = source.lastIndexOf('automationScheduler?.start();');
    const conversationRecovery = source.lastIndexOf(
      'recoverConversationAgents();',
    );

    expect(watcher).toBeGreaterThanOrEqual(0);
    expect(watcher).toBeLessThan(scheduler);
    expect(watcher).toBeLessThan(conversationRecovery);
    expect(conversationRecovery).toBeLessThan(scheduler);
  });
});
