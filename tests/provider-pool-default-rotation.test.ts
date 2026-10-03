import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-default-rotation-'));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runtimeConfig = await import('../src/runtime-config.js');
const db = await import('../src/db.js');
const {
  closeRunnerAfterRotatingProviderTurn,
  trySelectPoolProvider,
  willClearSessionOnProviderSwitch,
} = await import('../src/container-runner.js');
const { providerPool } = await import('../src/provider-pool.js');

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'groups'), { recursive: true });
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('automatic enabled-model pool', () => {
  const created: string[] = [];

  beforeAll(() => {
    for (const name of ['Account A', 'Account B', 'Account C']) {
      created.push(
        runtimeConfig.createProvider({
          name,
          type: 'official',
          anthropicApiKey: `${name.replace(/\s+/g, '-').toLowerCase()}-key`,
          anthropicModel: 'claude-fable-5',
          enabled: true,
        }).id,
      );
    }
  });

  test('rotates across enabled providers when no Agent pinned a configuration', () => {
    const picked = new Set<string>();
    // Distinct groupFolders: each is a fresh session, so sticky binding never
    // applies and every call is a real pool selection.
    for (let i = 0; i < 12; i += 1) {
      const result = trySelectPoolProvider(`rotation-group-${i}`, null, null);
      expect(result).not.toBeNull();
      picked.add(result!.profileId);
    }
    expect(picked.size).toBeGreaterThan(1);
  });

  test('a completed warm turn closes before the next request and reselects with history reset', () => {
    runtimeConfig.saveBalancingConfig({ strategy: 'round-robin' });
    const groupFolder = 'warm-turn-rotation';
    const first = trySelectPoolProvider(groupFolder, null, null);
    expect(first).not.toBeNull();

    const closeRunner = vi.fn();
    expect(
      closeRunnerAfterRotatingProviderTurn(
        true,
        false,
        { providerFailure: false, inputTurnCompleted: true },
        closeRunner,
      ),
    ).toBe(true);
    expect(closeRunner).toHaveBeenCalledOnce();
    // Host shutdown drops the resumable SDK session but retains the previous
    // provider binding, so prompt construction predicts the switch and injects
    // persisted history before the next cold runner starts.
    db.deleteSession(groupFolder, null);
    db.setSessionProviderId(groupFolder, null, first!.profileId);
    expect(willClearSessionOnProviderSwitch(groupFolder, null, null)).toBe(
      true,
    );

    const second = trySelectPoolProvider(groupFolder, null, null);
    expect(second).not.toBeNull();
    expect(second!.profileId).not.toBe(first!.profileId);
    expect(second!.resetSession).toBe(true);
  });

  test('rotation never closes a runner that still holds background tasks', () => {
    const closeRunner = vi.fn();
    expect(
      closeRunnerAfterRotatingProviderTurn(
        true,
        false,
        { providerFailure: false, inputTurnCompleted: true, pendingBgTasks: 2 },
        closeRunner,
      ),
    ).toBe(false);
    expect(closeRunner).not.toHaveBeenCalled();

    // Once the tasks settle, the next healthy completion schedules rotation.
    expect(
      closeRunnerAfterRotatingProviderTurn(
        true,
        false,
        { providerFailure: false, inputTurnCompleted: true, pendingBgTasks: 0 },
        closeRunner,
      ),
    ).toBe(true);
    expect(closeRunner).toHaveBeenCalledOnce();
  });

  test.each(['round-robin', 'weighted-round-robin'] as const)(
    'transient replay stays on its first provider under %s',
    (strategy) => {
      runtimeConfig.saveBalancingConfig({ strategy });
      const first = trySelectPoolProvider(
        `transient-${strategy}-first`,
        null,
        null,
      )!;
      const replay = trySelectPoolProvider(
        `transient-${strategy}-replay`,
        null,
        null,
        first.profileId,
      )!;
      expect(replay.profileId).toBe(first.profileId);
      expect(providerPool.getHealthStatus(first.profileId).healthy).toBe(true);
    },
  );

  test('transient replay pin is ignored after health or model-tier eligibility changes', () => {
    runtimeConfig.saveBalancingConfig({ strategy: 'round-robin' });
    const unhealthy = trySelectPoolProvider(
      'transient-ineligible-health-first',
      null,
      null,
    )!;
    providerPool.reportFailure(unhealthy.profileId, true);
    const healthFallback = trySelectPoolProvider(
      'transient-ineligible-health-replay',
      null,
      null,
      unhealthy.profileId,
    )!;
    expect(healthFallback.profileId).not.toBe(unhealthy.profileId);
    providerPool.resetHealth(unhealthy.profileId);

    const modelWall = trySelectPoolProvider(
      'transient-ineligible-tier-first',
      null,
      null,
    )!;
    providerPool.reportModelFailure(modelWall.profileId, 'claude-fable-5');
    const tierFallback = trySelectPoolProvider(
      'transient-ineligible-tier-replay',
      null,
      null,
      modelWall.profileId,
    )!;
    expect(tierFallback.profileId).not.toBe(modelWall.profileId);
    providerPool.resetModelQuarantine(modelWall.profileId);
  });

  test('an explicit Agent model configuration still pins selection', () => {
    for (let i = 0; i < 5; i += 1) {
      const result = trySelectPoolProvider(
        `pinned-group-${i}`,
        null,
        created[2],
      );
      expect(result?.profileId).toBe(created[2]);
    }
  });

  test('a single enabled provider still resolves through the default', () => {
    runtimeConfig.setProviderEnabled(created[1], false);
    runtimeConfig.setProviderEnabled(created[2], false);
    const result = trySelectPoolProvider('single-provider-group', null, null);
    expect(result?.profileId).toBe(created[0]);
    runtimeConfig.setProviderEnabled(created[1], true);
    runtimeConfig.setProviderEnabled(created[2], true);
  });

  /**
   * A sticky binding quarantined long ago must be reused once the recovery
   * interval has elapsed. selectProvider() applies the time-based recovery
   * rule internally, but the sticky-health read happens before that call, so
   * without an explicit refresh a long-idle group keeps switching away from a
   * provider that recovered ages ago — clearing the session and reinjecting
   * history for nothing.
   */
  test('sticky binding is reused after the recovery interval expires', () => {
    vi.useFakeTimers();
    try {
      // failover makes the no-sticky fallback deterministic: it would always
      // pick created[0], so reuse of created[2] can only come from stickiness.
      runtimeConfig.saveBalancingConfig({
        strategy: 'failover',
        recoveryIntervalMs: 300_000,
      });

      db.setSessionProviderId('sticky-quarantine-group', null, created[2]);
      providerPool.reportFailure(created[2], true);

      const during = trySelectPoolProvider(
        'sticky-quarantine-group',
        null,
        null,
      );
      expect(during?.profileId).toBe(created[0]);
      expect(during?.resetSession).toBe(true);

      db.setSessionProviderId('sticky-recovered-group', null, created[2]);
      vi.setSystemTime(Date.now() + 300_000 + 1);

      const after = trySelectPoolProvider('sticky-recovered-group', null, null);
      expect(after?.profileId).toBe(created[2]);
      expect(after?.resetSession ?? false).toBe(false);
    } finally {
      vi.useRealTimers();
      runtimeConfig.saveBalancingConfig({ strategy: 'round-robin' });
    }
  });
});
