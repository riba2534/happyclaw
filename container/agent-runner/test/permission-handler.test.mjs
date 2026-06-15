import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCanUseToolHandler,
  decidePermissionRequest,
} from '../dist/permission-handler.js';

test('bypass mode allows permission requests immediately', async () => {
  const suggestions = [
    {
      rules: [{ toolName: 'Bash' }],
      behavior: 'allow',
      destination: 'session',
    },
  ];

  const result = decidePermissionRequest({
    mode: 'bypassPermissions',
    toolName: 'Bash',
    suggestions,
  });

  assert.equal(result.behavior, 'allow');
  assert.equal(result.toolUseID, undefined);
  assert.deepEqual(result.updatedPermissions, suggestions);
});

test('plan mode allows exiting plan mode', () => {
  const result = decidePermissionRequest({
    mode: 'plan',
    toolName: 'ExitPlanMode',
  });

  assert.equal(result.behavior, 'allow');
});

test('plan mode denies execution tools instead of waiting for approval', () => {
  const result = decidePermissionRequest({
    mode: 'plan',
    toolName: 'Bash',
    decisionReason: 'requires user approval',
  });

  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /Plan mode/);
  assert.equal(result.interrupt, false);
});

test('canUseTool handler resolves SDK requests with the current mode', async () => {
  const seen = [];
  const handler = createCanUseToolHandler({
    getPermissionMode: () => 'bypassPermissions',
    log: (message) => seen.push(message),
  });

  const result = await handler(
    'Write',
    { file_path: 'notes.md' },
    {
      signal: new AbortController().signal,
      toolUseID: 'toolu_123',
    },
  );

  assert.equal(result.behavior, 'allow');
  assert.equal(result.toolUseID, 'toolu_123');
  assert.ok(seen.some((message) => message.includes('allow Write')));
});
