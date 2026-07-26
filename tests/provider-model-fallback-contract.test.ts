import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const agentRunner = fs.readFileSync(
  path.join(root, 'container/agent-runner/src/index.ts'),
  'utf8',
);
const hostRunner = fs.readFileSync(
  path.join(root, 'src/container-runner.ts'),
  'utf8',
);
const main = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');
const taskScheduler = fs.readFileSync(
  path.join(root, 'src/task-scheduler.ts'),
  'utf8',
);

describe('provider fallback source contracts', () => {
  test('cold/warm retry uses the failed turn payload rather than startup input', () => {
    expect(agentRunner).toMatch(
      /return runQueryAttempt\(\s*failed\.prompt,\s*failed\.sessionIdBeforeTurn,[\s\S]*?failed\.resumeAt,[\s\S]*?failed\.images,[\s\S]*?failed\.ipcMessages,/,
    );
    expect(agentRunner).toContain(
      'laterIpcMessages: ipcDeliveryTracker.laterTurnMessages',
    );
    expect(agentRunner).toContain(
      'requeueIpcInputMessages(IPC_INPUT_DIR, failed.laterIpcMessages)',
    );
    expect(agentRunner).toContain('containerInput.turnId = failed.turnId');
  });

  test('SDK teardown after a limit result cannot erase the retry handoff', () => {
    expect(agentRunner).toMatch(
      /catch \(err\) \{[\s\S]*?if \(providerFailureTurn\) \{[\s\S]*?providerFailureTurn,[\s\S]*?\};[\s\S]*?Context overflow/,
    );
  });

  test('structured model limits report usage and activate fallback for later warm turns', () => {
    expect(agentRunner).toContain(
      'const info: SDKRateLimitInfo = message.rate_limit_info',
    );
    expect(agentRunner).toContain(
      'structuredRejection: { rateLimitType: info.rateLimitType }',
    );
    expect(agentRunner).toContain(
      "limitDecision.action === 'provider_failure'",
    );
    expect(agentRunner).toContain(
      'PROVIDER_FALLBACK_MODELS.activateForScope(limitDecision.scope)',
    );
    expect(agentRunner).toContain(
      'PROVIDER_FALLBACK_MODELS.activeModelOverride',
    );
    expect(agentRunner).toContain('providerFailureRetrying: true');
    expect(agentRunner).toContain('terminalModelLimitFailure: true');
    expect(agentRunner).not.toContain('pendingRejectedRateLimit');
  });

  test('host consumes the hidden model retry marker without quarantining provider', () => {
    expect(
      hostRunner.match(/if \(output\.providerFailureRetrying\)/g),
    ).toHaveLength(2);
    expect(hostRunner).toContain('!providerFailureReported &&');
    expect(hostRunner).toContain('!hostProviderFailureReported &&');
    expect(hostRunner).not.toContain('ownerHomeFolder,\n    fallbackModel');
    expect(agentRunner).not.toMatch(
      /providerFailure:\s*true,\s*providerFailureRetrying:\s*true/,
    );
  });

  test('a synthetic assistant provider error cannot park the SDK stream', () => {
    expect(agentRunner).toContain(
      'isAccountProviderAssistantError(assistantError)',
    );
    expect(agentRunner).toContain(
      'publishProviderAccountFailure(assistantError)',
    );
    expect(agentRunner).toContain(
      'const ipcReceipts = ipcDeliveryTracker.completeNextTurn()',
    );
    expect(agentRunner).toContain(
      'writeOutput(outputCorrelation.correlate(output))',
    );
    expect(agentRunner).toContain(
      "runSdkControlWithTimeout(\n              'getContextUsage'",
    );
    expect(agentRunner).toContain('new SdkFirstResponseWatchdog(');
  });

  test('host quarantines before projection and chooses retry vs terminal', () => {
    expect(
      hostRunner.match(/applyProviderFailureDisposition\(/g)?.length,
    ).toBeGreaterThanOrEqual(5);
    expect(hostRunner).toMatch(
      /providerPool\.reportFailure\(selectedProfileId, true\);[\s\S]*?applyProviderFailureDisposition\([\s\S]*?await onOutput\(output\)/,
    );
    expect(hostRunner).toMatch(
      /providerPool\.reportFailure\(hostSelectedProfileId, true\);[\s\S]*?applyProviderFailureDisposition\([\s\S]*?await onOutput\(output\)/,
    );
    expect(hostRunner).toMatch(
      /providerPool\.refreshFromConfig\([\s\S]*?providerPool\.refreshRecoveryState\(\)/,
    );
  });

  test('maintenance provider failures cannot project or replay a completed input', () => {
    expect(agentRunner).toContain('providerFailureMaintenance: true');
    expect(agentRunner).toContain(
      'queryResult.durableInputTurnCompleted === true',
    );
    expect(
      hostRunner.match(/output\.providerFailureMaintenance &&/g),
    ).toHaveLength(2);
    expect(hostRunner).toContain('healthyInputTurnCompleted');
    expect(hostRunner).toContain('hostHealthyInputTurnCompleted');
    expect(hostRunner).toContain(
      'Provider failed after scheduled input completed; suppressing replay',
    );
  });

  test('provider failures are visible only at pool exhaustion across interaction modes', () => {
    expect(main).not.toContain(
      'Provider failure result suppressed from user (silent switch)',
    );
    expect(main.match(/Provider failure surfaced to user/g)).toHaveLength(2);
    expect(main).toContain('result.providerFailureTerminal !== true');
    expect(main).toContain('output.providerFailureTerminal !== true');
    expect(main).toContain('rollbackIdleMainCardReservation(');
    expect(main).toContain('rollbackIdleAgentCardReservation(');
    expect(main).toMatch(
      /!publishesFrameworkAnswer\(interactionMode\)\s*&&\s*!result\.providerFailure/,
    );
    expect(main).toMatch(
      /!publishesFrameworkAnswer\(interactionMode\)\s*&&\s*!output\.providerFailure/,
    );
  });

  test('scheduled tasks classify exhausted providers as failures', () => {
    expect(taskScheduler).toContain(
      'streamedOutput.providerFailureTerminal === true',
    );
    expect(taskScheduler).toContain('error = PROVIDER_FAILURE_USER_NOTICE');
    expect(hostRunner).toContain(
      'Scheduled task provider failed; retrying the same prompt on another provider',
    );
  });
});
