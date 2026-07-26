import fs from 'node:fs';

import { describe, expect, test } from 'vitest';

const main = fs.readFileSync('src/index.ts', 'utf8');

describe('main-runner exact input delivery fencing', () => {
  test('records SDK final delivery against the correlated output input', () => {
    expect(main).not.toContain('let genuineReplyDelivered = false');
    expect(main).toContain('const genuineReplyDeliveredByInput = new Map');
    expect(main).toMatch(
      /genuineReplyDeliveredByInput\.set\(\s*outputChannelScope\.inputId,\s*true/,
    );
  });

  test('late-error recovery reads delivery and cursor state for only the active input', () => {
    expect(main).toMatch(
      /wasGenuineReplyDeliveredForInput\(\s*genuineReplyDeliveredByInput,\s*activeInputTurnId/,
    );
    expect(main).toContain('cursorCommittedInputTurns.has(activeInputTurnId)');
    expect(main).toMatch(
      /shouldSkipRetryAfterLateError\(\{\s*genuineReplyDelivered: activeGenuineReplyDelivered/,
    );
  });

  test('a correlated SDK final commits its own input, not whichever input is active later', () => {
    expect(main).toContain('commitCursor(outputChannelScope.inputId)');
    expect(main).not.toMatch(
      /completeChannelRuntimesForOutput\(result\)\s*\)\s*\{\s*commitCursor\(\);/,
    );
  });
});

describe('conversation-agent exact input cursor fencing', () => {
  const agentHost = main.slice(
    main.indexOf('async function processAgentConversation('),
    main.indexOf('async function startMessageLoop()'),
  );

  test('does not let late A cursor state become active B cursor state', () => {
    expect(agentHost).toContain(
      'const cursorCommittedInputTurns = new Set<string>()',
    );
    expect(agentHost).not.toContain('let cursorCommitted = false');
    expect(agentHost).toContain(
      'cursorCommitted: isCursorCommitted(inputTurnId)',
    );
  });

  test('correlated SDK completions commit their own immutable input', () => {
    expect(agentHost).toMatch(
      /commitCursor\(\s*resolveContainerOutputInputTurnId\(output, lastProcessed\.id\)/,
    );
  });
});
