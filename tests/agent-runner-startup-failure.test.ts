import { expect, test } from 'vitest';

import { classifyPreInitErrorResult } from '../container/agent-runner/src/startup-failure.js';

// Result shapes observed from the bundled Claude Code 2.1.296.
const missingSession = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  errors: [
    'No conversation found with session ID: 11111111-2222-3333-4444-555555555555',
  ],
};
const invalidProxy = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  startup_failure_reason: 'proxy_invalid',
  errors: ['Invalid proxy URL in HTTPS_PROXY: "not a url" cannot be parsed'],
};

test('an unnamed pre-init failure while resuming is a resume failure', () => {
  expect(
    classifyPreInitErrorResult({ resuming: true, result: missingSession }),
  ).toEqual({ kind: 'resume_failed' });
});

test('a named startup refusal keeps the session and reports why', () => {
  expect(
    classifyPreInitErrorResult({ resuming: true, result: invalidProxy }),
  ).toEqual({
    kind: 'startup_failed',
    reason: 'proxy_invalid',
    message:
      'Claude Code failed to start (proxy_invalid): Invalid proxy URL in HTTPS_PROXY: "not a url" cannot be parsed',
  });
  expect(
    classifyPreInitErrorResult({
      resuming: true,
      result: {
        ...invalidProxy,
        startup_failure_reason: 'session_held_by_background',
      },
    }).kind,
  ).toBe('startup_failed');
});

test('a fresh session that fails before init is never retried as a resume', () => {
  expect(
    classifyPreInitErrorResult({ resuming: false, result: missingSession }),
  ).toMatchObject({ kind: 'startup_failed' });
});
