import { describe, expect, test } from 'vitest';

import {
  findDuplicateActiveAgentTask,
  type TaskExecutionDefinition,
} from '../src/task-definition-fingerprint.js';
import type { RegisteredGroup, ScheduledTask } from '../src/types.js';
import {
  getScriptTaskHostExecutionError,
  resolveTaskExecutionModeForTarget,
  resolveWorkspaceExecutionMode,
} from '../src/script-task-policy.js';

function definition(
  overrides: Partial<TaskExecutionDefinition> = {},
): TaskExecutionDefinition {
  return {
    group_folder: 'workspace-a',
    chat_jid: 'feishu:chat-a',
    prompt: 'Generate the daily report',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'container',
    script_command: null,
    created_by: 'user-a',
    notify_channels: null,
    ...overrides,
  };
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-existing',
    ...definition(),
    next_run: '2026-07-20T01:00:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-07-19T00:00:00.000Z',
    revision: 1,
    updated_at: '2026-07-19T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  };
}

describe('scheduled-task execution fingerprint', () => {
  test('deduplicates an exactly identical active agent task', () => {
    const existing = task();

    expect(findDuplicateActiveAgentTask([existing], definition())).toBe(
      existing,
    );
  });

  test('does not deduplicate host and container tasks with identical content', () => {
    const existing = task({ execution_mode: 'host' });

    expect(
      findDuplicateActiveAgentTask(
        [existing],
        definition({ execution_mode: 'container' }),
      ),
    ).toBeUndefined();
  });

  test('does not deduplicate tasks routed to different IM targets', () => {
    const existing = task({ chat_jid: 'feishu:chat-b' });

    expect(
      findDuplicateActiveAgentTask([existing], definition()),
    ).toBeUndefined();
  });

  test('does not deduplicate tasks owned or notified differently', () => {
    const existing = task({
      created_by: 'user-b',
      notify_channels: ['telegram:chat-a'],
    });

    expect(
      findDuplicateActiveAgentTask([existing], definition()),
    ).toBeUndefined();
  });
});

describe('target-bound task execution mode', () => {
  test('inherits from the target workspace, independent of the source workspace', () => {
    // Admin home (host) -> container target must remain container.
    expect(resolveTaskExecutionModeForTarget('container', undefined)).toBe(
      'container',
    );
    // A container-backed source targeting an authorized host workspace inherits
    // the target's host mode; source mode is intentionally not an input.
    expect(resolveTaskExecutionModeForTarget('host', undefined)).toBe('host');
  });

  test('rejects explicit host on a container target and permits host downgrade', () => {
    expect(() =>
      resolveTaskExecutionModeForTarget('container', 'host'),
    ).toThrow('Target workspace runs in container mode');
    expect(resolveTaskExecutionModeForTarget('host', 'container')).toBe(
      'container',
    );
  });
});

describe('workspace execution mode for task targets', () => {
  function group(overrides: Partial<RegisteredGroup>): RegisteredGroup {
    return {
      name: 'Workspace',
      folder: 'main',
      added_at: '2026-04-01T00:00:00.000Z',
      ...overrides,
    } as RegisteredGroup;
  }

  test('an IM chat routed into a host home workspace inherits host', () => {
    const home = group({ is_home: true, executionMode: 'host' });
    const imChat = group({ executionMode: 'container' });
    const groups = { 'web:main': home, 'telegram:1': imChat };

    expect(resolveWorkspaceExecutionMode(imChat, groups)).toBe('host');
    expect(
      getScriptTaskHostExecutionError(
        {
          execution_type: 'script',
          execution_mode: 'host',
          chat_jid: 'telegram:1',
          group_folder: 'main',
        },
        groups,
      ),
    ).toBeNull();
  });

  test('a non-home workspace without a home sibling keeps its own mode', () => {
    const other = group({ folder: 'other', executionMode: 'container' });
    const home = group({ is_home: true, executionMode: 'host' });

    expect(
      resolveWorkspaceExecutionMode(other, {
        'web:main': home,
        'web:o': other,
      }),
    ).toBe('container');
  });

  test('a member home stays container even if an IM row claims host', () => {
    const home = group({ is_home: true, executionMode: 'container' });
    const imChat = group({ executionMode: 'host' });

    expect(
      resolveWorkspaceExecutionMode(imChat, { 'web:m': home, 'qq:1': imChat }),
    ).toBe('container');
  });
});
