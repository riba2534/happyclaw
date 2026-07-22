import { describe, expect, test } from 'vitest';

import { ProviderPool, providerPool } from '../src/provider-pool.js';
import {
  runAgentWithModelFallback,
  type ContainerInput,
  type ContainerOutput,
} from '../src/container-runner.js';
import type { RegisteredGroup } from '../src/types.js';
import type { BalancingConfig } from '../src/runtime-config.js';

const BALANCING: BalancingConfig = {
  strategy: 'weighted-round-robin',
  unhealthyThreshold: 3,
  recoveryIntervalMs: 300_000,
};

function poolProviders(ids: string[]) {
  return ids.map((id) => ({ id, enabled: true, weight: 1 }));
}

const GROUP = { name: 'test-group', folder: 'test-folder' } as RegisteredGroup;

const INPUT: ContainerInput = {
  prompt: 'original prompt',
  groupFolder: 'test-folder',
  chatJid: 'web:test-folder',
};

const noopOnProcess = () => {};

function successOutput(): ContainerOutput {
  return { status: 'success', result: 'ok' };
}

function limitOutput(): ContainerOutput {
  return {
    status: 'success',
    result: "You've hit your session limit · resets 11:10pm (Asia/Singapore)",
    providerFailure: true,
  };
}

describe('ProviderPool.hasHealthyEnabledMember', () => {
  test('true when at least one enabled member has no failures', () => {
    const pool = new ProviderPool();
    pool.refreshFromConfig(poolProviders(['a', 'b']), BALANCING);
    expect(pool.hasHealthyEnabledMember()).toBe(true);

    pool.reportFailure('a', true);
    expect(pool.hasHealthyEnabledMember()).toBe(true);

    pool.reportFailure('b', true);
    expect(pool.hasHealthyEnabledMember()).toBe(false);
  });

  test('ignores disabled members even when healthy', () => {
    const pool = new ProviderPool();
    pool.refreshFromConfig(
      [
        { id: 'a', enabled: false, weight: 1 },
        { id: 'b', enabled: true, weight: 1 },
      ],
      BALANCING,
    );
    pool.reportFailure('b', true);
    expect(pool.hasHealthyEnabledMember()).toBe(false);
  });

  test('false when no members configured', () => {
    const pool = new ProviderPool();
    pool.refreshFromConfig([], BALANCING);
    expect(pool.hasHealthyEnabledMember()).toBe(false);
  });
});

describe('runAgentWithModelFallback — account-limit provider failover', () => {
  test('retries the turn on another provider until one succeeds', async () => {
    providerPool.refreshFromConfig(
      poolProviders(['acct-1', 'acct-2', 'acct-3']),
      BALANCING,
    );

    // Simulate the real runner: each failing attempt marks its account
    // unhealthy (the runner's health reporting does this via reportFailure
    // with immediate=true) and surfaces providerFailure.
    const attempts: string[] = [];
    const accounts = ['acct-1', 'acct-2', 'acct-3'];
    const runFn = async (): Promise<ContainerOutput> => {
      const account = accounts[attempts.length];
      attempts.push(account);
      if (attempts.length < 3) {
        providerPool.reportFailure(account, true);
        return limitOutput();
      }
      return successOutput();
    };

    const output = await runAgentWithModelFallback(
      runFn as never,
      GROUP,
      INPUT,
      noopOnProcess,
    );

    expect(attempts).toEqual(['acct-1', 'acct-2', 'acct-3']);
    expect(output.status).toBe('success');
    expect(output.providerFailure).toBeUndefined();
    expect(output.result).toBe('ok');
  });

  test('stops retrying once every enabled account is exhausted', async () => {
    providerPool.refreshFromConfig(
      poolProviders(['dead-1', 'dead-2', 'dead-3']),
      BALANCING,
    );

    let calls = 0;
    const accounts = ['dead-1', 'dead-2', 'dead-3'];
    const runFn = async (): Promise<ContainerOutput> => {
      providerPool.reportFailure(accounts[calls], true);
      calls++;
      return limitOutput();
    };

    const output = await runAgentWithModelFallback(
      runFn as never,
      GROUP,
      INPUT,
      noopOnProcess,
    );

    // Each account gets exactly one shot; the final failure is surfaced.
    expect(calls).toBe(3);
    expect(output.providerFailure).toBe(true);
  });

  test('does not retry with a single provider (nothing to switch to)', async () => {
    providerPool.refreshFromConfig(poolProviders(['only-1']), BALANCING);

    let calls = 0;
    const runFn = async (): Promise<ContainerOutput> => {
      calls++;
      providerPool.reportFailure('only-1', true);
      return limitOutput();
    };

    const output = await runAgentWithModelFallback(
      runFn as never,
      GROUP,
      INPUT,
      noopOnProcess,
    );

    expect(calls).toBe(1);
    expect(output.providerFailure).toBe(true);
  });

  test('rebuilds retry input from the ORIGINAL input each attempt (no history stacking)', async () => {
    providerPool.refreshFromConfig(
      poolProviders(['r-1', 'r-2', 'r-3']),
      BALANCING,
    );

    const seenPrompts: string[] = [];
    const rebuildInputs: ContainerInput[] = [];
    const accounts = ['r-1', 'r-2', 'r-3'];
    let calls = 0;
    const runFn = async (
      _group: RegisteredGroup,
      input: ContainerInput,
    ): Promise<ContainerOutput> => {
      seenPrompts.push(input.prompt);
      const account = accounts[calls];
      calls++;
      if (calls < 3) {
        providerPool.reportFailure(account, true);
        return limitOutput();
      }
      return successOutput();
    };

    await runAgentWithModelFallback(
      runFn as never,
      GROUP,
      INPUT,
      noopOnProcess,
      undefined,
      undefined,
      {
        rebuildInputForProviderSwitch: (originalInput) => {
          rebuildInputs.push(originalInput);
          return {
            ...originalInput,
            prompt: `[history]\n${originalInput.prompt}`,
          };
        },
      },
    );

    // First attempt uses the raw input; each retry rebuilds from the original,
    // so the history prefix appears exactly once no matter how many retries.
    expect(seenPrompts).toEqual([
      'original prompt',
      '[history]\noriginal prompt',
      '[history]\noriginal prompt',
    ]);
    expect(rebuildInputs).toEqual([INPUT, INPUT]);
  });

  test('does not retry a successful turn', async () => {
    providerPool.refreshFromConfig(poolProviders(['ok-1', 'ok-2']), BALANCING);

    let calls = 0;
    const runFn = async (): Promise<ContainerOutput> => {
      calls++;
      return successOutput();
    };

    const output = await runAgentWithModelFallback(
      runFn as never,
      GROUP,
      INPUT,
      noopOnProcess,
    );

    expect(calls).toBe(1);
    expect(output.status).toBe('success');
  });
});
