import { describe, expect, it } from 'vitest';

import { ProviderPoolManager } from '../src/provider-pool.js';

const balancing = {
  strategy: 'round-robin' as const,
  unhealthyThreshold: 1,
  recoveryIntervalMs: 60_000,
};

describe('ProviderPoolManager', () => {
  it('isolates selection and health by provider pool id', () => {
    const manager = new ProviderPoolManager();
    manager.refreshPoolFromConfig(
      'claude',
      [{ id: 'claude-a', enabled: true, weight: 1 }],
      balancing,
    );
    manager.refreshPoolFromConfig(
      'gpt',
      [{ id: 'gpt-a', enabled: true, weight: 1 }],
      balancing,
    );

    manager.reportFailure('claude', 'claude-a');

    expect(manager.getHealthStatuses('claude')[0].healthy).toBe(false);
    expect(manager.getHealthStatuses('gpt')[0].healthy).toBe(true);
    expect(manager.selectProvider('gpt')).toBe('gpt-a');
  });
});
