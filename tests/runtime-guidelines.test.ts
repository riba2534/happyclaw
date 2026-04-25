import { describe, expect, it } from 'vitest';

import { buildRuntimeBackgroundTaskGuidelines } from '../container/agent-runner/src/runtime-guidelines.js';

describe('runtime-specific background task guidelines', () => {
  it('keeps Claude on SDK-native Task semantics', () => {
    const text = buildRuntimeBackgroundTaskGuidelines('claude');

    expect(text).toContain('Task 工具');
    expect(text).toContain('run_in_background');
  });

  it('keeps Codex away from fake Claude Task/sub-agent semantics', () => {
    const text = buildRuntimeBackgroundTaskGuidelines('codex');

    expect(text).toContain('不要使用或声称使用 Claude 的 Task');
    expect(text).toContain('schedule_task');
    expect(text).toContain('/spawn / conversation agent');
    expect(text).not.toContain('run_in_background: true');
  });
});
