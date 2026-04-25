import { describe, expect, it } from 'vitest';

import {
  buildResumeFailureRetryInput,
  classifyRuntimeError,
} from '../container/agent-runner/src/runtime-adapter.js';

describe('runtime adapter boundary helpers', () => {
  it('classifies common runtime errors for user-facing handling', () => {
    expect(classifyRuntimeError(new Error('The operation was aborted'))).toBe(
      'cancelled',
    );
    expect(classifyRuntimeError(new Error('401 unauthorized: invalid API key'))).toBe(
      'auth',
    );
    expect(classifyRuntimeError(new Error('unsupported model gpt-x'))).toBe(
      'unsupported_model',
    );
    expect(classifyRuntimeError(new Error('rate limit exceeded'))).toBe(
      'rate_limit',
    );
    expect(classifyRuntimeError(new Error('spawn codex ENOENT'))).toBe(
      'runtime_unavailable',
    );
    expect(classifyRuntimeError(new Error('EACCES permission denied'))).toBe(
      'permission',
    );
  });

  it('builds soft-injection retry input after native resume failure', () => {
    const retry = buildResumeFailureRetryInput(
      {
        input: {
          prompt: 'hello',
          groupFolder: 'flow-test',
          chatJid: 'web:flow-test',
        },
        prompt: 'resume prompt',
        resumeFailureFallbackPrompt: 'fallback prompt',
        sessionId: 'native-1',
        cwd: '/tmp',
        systemPromptAppend: '',
      },
      'native_resume_failed',
    );

    expect(retry).toMatchObject({
      prompt: 'fallback prompt',
      sessionId: undefined,
      resumeMode: 'soft_inject',
      softInjectionReason: 'native_resume_failed',
    });
  });
});
