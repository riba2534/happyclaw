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
    // Per-model quotas are per account: a walled model tier says nothing about
    // the other accounts' budget for the same model. Exhausting every tier on
    // this profile must hand it back to the host pool for failover rather than
    // dead-ending the turn inside the runner.
    expect(agentRunner).not.toContain('terminalModelLimitFailure');
    expect(agentRunner).not.toContain('publishTerminalModelLimitFailure');
    expect(agentRunner).toContain(
      'Model tiers exhausted on this account; quarantining profile for failover',
    );
    expect(agentRunner).toMatch(
      /publishProviderFailure\(\{\s*error: 'rate_limit',\s*failureClass: 'account',\s*rateLimitResetsAt: info\.resetsAt,\s*failureNotice: MODEL_LIMIT_EXHAUSTED_NOTICE,/,
    );
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
    // The boundary helper delegates to classifyProviderAssistantError(); its
    // unit tests pin that every top-level error still yields a class.
    expect(agentRunner).toMatch(
      /resolveAssistantErrorAttemptBoundary\(\{\s*error: assistantError,/,
    );
    // The published class must come from the classifier, never a hard-coded
    // label: borrowing 'server_error' is exactly how the liveness watchdog
    // inherited the account-verdict disposition it had no business having.
    expect(agentRunner).toMatch(
      /publishProviderFailure\(\{\s*error: assistantError,\s*failureClass: assistantErrorClass,\s*\}\)/,
    );
    expect(agentRunner).toContain(
      'const ipcReceipts = ipcDeliveryTracker.completeNextTurn()',
    );
    expect(agentRunner).toContain(
      'writeOutput(outputCorrelation.correlate(output))',
    );
    expect(agentRunner).toMatch(
      /runSdkControlWithTimeout\(\s*'getContextUsage'/,
    );
    expect(agentRunner).toContain('new SdkFirstResponseWatchdog(');
  });

  test('host quarantines before projection and chooses retry vs terminal', () => {
    expect(
      hostRunner.match(/applyProviderFailureDisposition\(/g)?.length,
    ).toBeGreaterThanOrEqual(5);
    expect(hostRunner).toMatch(
      /quarantineFromOutput\(selectedProfileId, output\);[\s\S]*?applyProviderFailureDisposition\([\s\S]*?await onOutput\(output\)/,
    );
    expect(hostRunner).toMatch(
      /quarantineFromOutput\(hostSelectedProfileId, output\);[\s\S]*?applyProviderFailureDisposition\([\s\S]*?await onOutput\(output\)/,
    );
    // Quarantine granularity must follow the reported scope: a model wall may
    // never take the whole account out of rotation, and the upstream reset
    // stamp must reach the pool so the pair is not resurrected early.
    expect(hostRunner).toContain("output.providerRateLimitScope === 'model'");
    expect(hostRunner).toContain('providerPool.reportModelFailure(');
    expect(hostRunner).toMatch(
      /providerPool\.reportFailure\(profileId, true, output\.providerRateLimitResetsAt\)/,
    );
    // The terminal boundary spans both dimensions, not account health alone.
    expect(hostRunner).toContain('poolCanStillServe()');
    expect(hostRunner).toMatch(
      /hasCandidateForTier\(primaryTier\)[\s\S]*?hasCandidateForTier\(fallbackModel\)/,
    );
    expect(agentRunner).toMatch(
      /publishProviderFailure\(\{\s*error: 'rate_limit',\s*failureClass: 'account',\s*rateLimitResetsAt: info\.resetsAt,\s*\}\)/,
    );
    expect(hostRunner).toMatch(
      /providerPool\.refreshFromConfig\([\s\S]*?providerPool\.refreshRecoveryState\(\)/,
    );
  });

  test('maintenance provider failures cannot project or replay a completed input', () => {
    expect(agentRunner).toContain('providerFailureMaintenance: true');
    // Workspace Memory no longer launches a post-compaction model side-query;
    // compaction persistence and provider retry are independent.
    expect(agentRunner).not.toContain('Running memory flush query');
    expect(agentRunner).not.toContain('needsMemoryFlush');
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
    // The upstream limit text, when the runner captured one, replaces the
    // generic pool notice — but only on the terminal projection.
    expect(taskScheduler).toContain(
      'error = output.providerFailureNotice || PROVIDER_FAILURE_USER_NOTICE',
    );
    expect(taskScheduler).toMatch(
      /streamedOutput\.providerFailureNotice \|\|\s*PROVIDER_FAILURE_USER_NOTICE/,
    );
    expect(hostRunner).toContain(
      'Scheduled task provider failed; retrying the same prompt on another provider',
    );
  });
});
