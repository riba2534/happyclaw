import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const source = fs.readFileSync(
  path.join(process.cwd(), 'container/agent-runner/src/index.ts'),
  'utf8',
);

describe('Agent Runner terminal invariants', () => {
  test('every non-empty Assistant error terminates independently of classification', () => {
    // resolveAssistantErrorAttemptBoundary() returns a class for every
    // non-empty top-level error, so this branch is the only exit for them.
    expect(source).toMatch(
      /if \(assistantError\) \{[\s\S]*?resolveAssistantErrorAttemptBoundary\(\{[\s\S]*?if \(assistantErrorClass\) \{[\s\S]*?stream\.end\(\);[\s\S]*?providerAccountFailure: true/,
    );
    expect(source).not.toContain('if (assistantError && assistantErrorClass)');
  });

  test('sub-agent provider errors are judged before sub-agent routing', () => {
    // processSubAgentMessage() consumes every sub-agent assistant message, so
    // an error check placed after it can never see a sub-agent usage limit.
    const boundary = source.indexOf('resolveAssistantErrorAttemptBoundary({');
    const routing = source.indexOf(
      'if (processor.processSubAgentMessage(message as any))',
    );
    expect(boundary).toBeGreaterThan(-1);
    expect(routing).toBeGreaterThan(-1);
    expect(boundary).toBeLessThan(routing);
    expect(source).toMatch(
      /parentToolUseId: msgParentToolUseId,[\s\S]*?if \(msgParentToolUseId\) \{[\s\S]*?q\.interrupt\(\)/,
    );
  });

  test('protocol-only background debt has a bounded hard failure', () => {
    expect(source).toContain('BACKGROUND_PROTOCOL_DEBT_TIMEOUT_MS = 15_000');
    expect(source).toContain(
      'armBackgroundProtocolDebtWatchdog(blockingBackgroundProtocol)',
    );
    expect(source).toContain('background_protocol_timeout:');
    expect(source).toContain('BACKGROUND_PROTOCOL_FAILURE_EXIT_GRACE_MS');
    expect(source).toMatch(
      /if \(backgroundProtocolFailure\) \{[\s\S]*?throw backgroundProtocolFailure/,
    );
  });

  test('notification-driven continuation activity leaves the arrival watchdog', () => {
    const messageStart = source.indexOf(
      '// Compatibility fallback for CLI builds which omit',
    );
    const taskNotification = source.indexOf(
      "if (um.origin?.kind === 'task-notification')",
    );
    const topLevelAssistant = source.indexOf(
      'processor.getBlockingBackgroundCompletionDebtCount() > 0',
      taskNotification,
    );

    for (const start of [messageStart, taskNotification, topLevelAssistant]) {
      expect(start).toBeGreaterThanOrEqual(0);
      const branch = source.slice(start, start + 1_100);
      expect(branch).toContain('observeBackgroundNotification');
      expect(branch).toContain('clearBackgroundProtocolDebtWatchdog();');
    }
  });

  test('warm IPC claims the full batch before asynchronous context loading', () => {
    const register = source.indexOf(
      'for (const msg of messages) {\n      const becomesCurrentTurn',
    );
    const acknowledge = source.indexOf(
      'acknowledgeRegisteredIpcInputs(messages)',
      register,
    );
    const contextLoad = source.indexOf(
      'loadWorkspaceMemoryTurnContext(msg.text',
      acknowledge,
    );
    expect(register).toBeGreaterThanOrEqual(0);
    expect(acknowledge).toBeGreaterThan(register);
    expect(contextLoad).toBeGreaterThan(acknowledge);
  });

  test('deduplicates crash claims before cold prompt and warm stream delivery', () => {
    const coldFilter = source.indexOf('const coldDuplicates =');
    const coldPrompt = source.indexOf(
      "prompt += '\\n' + pendingDrain.messages.map((m) => m.text).join('\\n')",
    );
    expect(coldFilter).toBeGreaterThanOrEqual(0);
    expect(coldPrompt).toBeGreaterThan(coldFilter);

    const acceptedBatch = source.indexOf(
      'const acceptedMessages: IpcInputMessage[] = []',
    );
    const warmPush = source.indexOf(
      'for (const msg of acceptedMessages)',
      acceptedBatch,
    );
    expect(acceptedBatch).toBeGreaterThanOrEqual(0);
    expect(warmPush).toBeGreaterThan(acceptedBatch);
  });

  test('interrupt grace only suppresses correlated abort-like rejections', () => {
    expect(source).toContain(
      'isWithinInterruptGraceWindow() && isInterruptRelatedError(reason)',
    );
    expect(source).not.toMatch(
      /if \(isWithinInterruptGraceWindow\(\)\) \{\s*console\.error\('Unhandled rejection during interrupt/,
    );
    expect(source).toContain("err.name === 'AbortError'");
    expect(source).not.toMatch(
      /abort\|aborted\|interrupt\|interrupted\|cancelled\|canceled/,
    );
  });
});
