import fs from 'node:fs';

import { describe, expect, test } from 'vitest';

const main = fs.readFileSync('src/index.ts', 'utf8');

describe('session exact input delivery fencing', () => {
  test('records SDK final delivery against the correlated output input', () => {
    expect(main).toContain('const agentGenuineReplyDeliveredByInput = new Map');
    expect(main).toMatch(
      /agentGenuineReplyDeliveredByInput\.set\(\s*inputId,\s*true/,
    );
  });

  test('late-error recovery reads delivery state for only the active input', () => {
    expect(main).toMatch(
      /wasGenuineReplyDeliveredForInput\(\s*agentGenuineReplyDeliveredByInput,\s*inputTurnId/,
    );
    expect(main).toMatch(
      /agentIpcReplyTracker\.inputTurnId === inputTurnId &&\s*agentIpcReplyTracker\.delivered/,
    );
  });
});

describe('conversation-agent exact input cursor fencing', () => {
  const agentHost = main.slice(
    main.indexOf('async function processAgentConversation('),
    main.indexOf('async function startRunnerSupervisor()'),
  );

  test('initializes the batch runtime id before startup recovery registers the batch', () => {
    const declaration = agentHost.indexOf(
      'const lastProcessed = missedMessages[missedMessages.length - 1]',
    );
    const registration = agentHost.indexOf(
      'activeAgentBuilderTurns.startBatch(',
    );
    expect(declaration).toBeGreaterThanOrEqual(0);
    expect(registration).toBeGreaterThan(declaration);
  });

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
