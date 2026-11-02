import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-provider-runtime-apply-'),
);

const auth = vi.hoisted(() => ({ role: 'admin' as 'admin' | 'member' }));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: tmpDir,
  STORE_DIR: path.join(tmpDir, 'db'),
  GROUPS_DIR: path.join(tmpDir, 'groups'),
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/middleware/auth.ts')>();
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: 'provider-runtime-admin',
        username: 'provider-runtime-admin',
        display_name: 'Provider Runtime Admin',
        role: auth.role,
        status: 'active',
        permissions: [],
        must_change_password: false,
      });
      return next();
    },
  };
});

const web = await import('../src/web.js');
const db = await import('../src/db.js');
const runtimeConfig = await import('../src/runtime-config.js');
const { GroupQueue } = await import('../src/group-queue.js');

const app = web.createAppForTest({
  queue: {
    stopGroup: vi.fn(async () => {}),
    listDescendantJids: () => [],
    pauseGroupsForMutation: () => ({ id: 0 }),
    resumeGroupsAfterMutation: vi.fn(),
  },
  getRegisteredGroups: () => ({}),
  sessions: {},
} as any);

let sequence = 0;
let liveQueue: InstanceType<typeof GroupQueue> | null = null;

function unique(label: string): string {
  sequence += 1;
  return `${label}-${sequence}`;
}

function registerWorkspace(jid: string, folder: string) {
  const group = {
    name: folder,
    folder,
    added_at: new Date().toISOString(),
    executionMode: 'container' as const,
    created_by: 'provider-runtime-admin',
  };
  db.setRegisteredGroup(jid, group);
  return group;
}

function bindDeps(
  groups: Record<string, ReturnType<typeof registerWorkspace>>,
  queue: unknown,
  sessions: Record<string, string> = {},
): void {
  web.createAppForTest({
    queue,
    getRegisteredGroups: () => groups,
    sessions,
  } as any);
}

async function patchProvider(
  providerId: string,
  patch: Record<string, unknown>,
): Promise<Response> {
  return app.request(`/api/config/claude/providers/${providerId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

async function setProviderEnabled(
  providerId: string,
  enabled: boolean,
): Promise<Response> {
  return app.request(`/api/config/claude/providers/${providerId}/toggle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

async function deleteProvider(providerId: string): Promise<Response> {
  return app.request(`/api/config/claude/providers/${providerId}`, {
    method: 'DELETE',
  });
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  db.initDatabase();
});

beforeEach(() => {
  auth.role = 'admin';
  fs.rmSync(path.join(tmpDir, 'config'), { recursive: true, force: true });
  fs.rmSync(path.join(tmpDir, 'container-env'), {
    recursive: true,
    force: true,
  });
});

afterEach(async () => {
  if (liveQueue) {
    await liveQueue.shutdown(0);
    liveQueue = null;
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('connection WebFetch policy API', () => {
  function bindPolicyQueue() {
    const folder = unique('webfetch-policy');
    const jid = `web:${folder}`;
    const group = registerWorkspace(jid, folder);
    const queue = {
      listDescendantJids: () => [],
      pauseGroupsForMutation: vi.fn(() => ({ id: 9 })),
      resumeGroupsAfterMutation: vi.fn(),
      stopGroup: vi.fn(async () => {}),
      drainProviderRunnersForCredentialRefresh: vi.fn((_id: string) => 0),
    };
    const sessionId = unique('preserved-session');
    const sessions = { [folder]: sessionId };
    db.setSession(folder, sessionId);
    bindDeps({ [jid]: group }, queue, sessions);
    return { folder, sessionId, sessions, queue };
  }

  function createPolicyProvider(webFetchPreflightPolicy?: 'check' | 'skip') {
    return runtimeConfig.createProvider({
      name: unique('policy-connection'),
      type: 'third_party',
      anthropicBaseUrl: 'https://webfetch.example.test',
      anthropicAuthToken: 'test-policy-key',
      anthropicModel: 'test-model',
      webFetchPreflightPolicy,
    });
  }

  test.each([
    [undefined, 'skip', 1],
    ['skip', 'check', 1],
    [undefined, 'check', 0],
    ['skip', 'skip', 0],
  ] as const)(
    'saving %s as %s drains this connection %i times after persistence and keeps its session',
    async (from, to, drains) => {
      const { folder, sessionId, sessions, queue } = bindPolicyQueue();
      const target = createPolicyProvider(from);
      const other = createPolicyProvider();
      db.setSessionProviderId(folder, '', target.id);
      queue.drainProviderRunnersForCredentialRefresh.mockImplementation(
        (id: string) => {
          expect(
            runtimeConfig.toPublicProvider(runtimeConfig.getProviderById(id)!)
              .webFetchPreflightPolicy,
          ).toBe(to);
          return 1;
        },
      );
      const response = await patchProvider(target.id, {
        webFetchPreflightPolicy: to,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        provider: { id: target.id, webFetchPreflightPolicy: to },
        applied: { success: true, persisted: true, stoppedCount: 0 },
      });
      expect(
        runtimeConfig.getProviderById(other.id)!.webFetchPreflightPolicy,
      ).toBeUndefined();
      expect(queue.drainProviderRunnersForCredentialRefresh.mock.calls).toEqual(
        Array(drains).fill([target.id]),
      );
      expect(queue.pauseGroupsForMutation).not.toHaveBeenCalled();
      expect(queue.stopGroup).not.toHaveBeenCalled();
      expect(db.getSession(folder)).toBe(sessionId);
      expect(sessions[folder]).toBe(sessionId);
    },
  );

  test.each(['official', 'third_party'] as const)(
    'creation persists skip for %s connections',
    async (type) => {
      bindPolicyQueue();
      const response = await app.request('/api/config/claude/providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: unique('created-policy'),
          type,
          ...(type === 'official'
            ? { anthropicApiKey: 'test-key' }
            : {
                anthropicBaseUrl: 'https://test.example.test',
                anthropicAuthToken: 'test-key',
              }),
          webFetchPreflightPolicy: 'skip',
        }),
      });
      expect(response.status).toBe(201);
      const created = await response.json();
      expect(created.webFetchPreflightPolicy).toBe('skip');
      expect(
        runtimeConfig.getProviderById(created.id)!.webFetchPreflightPolicy,
      ).toBe('skip');
    },
  );

  test('lists a connection without a stored policy as check without rewriting it', async () => {
    bindPolicyQueue();
    const target = createPolicyProvider();
    const file = path.join(tmpDir, 'config', 'claude-provider.json');
    const original = fs.readFileSync(file, 'utf8');
    const response = await app.request('/api/config/claude/providers');
    expect(response.status).toBe(200);
    const listed = await response.json();
    expect(
      listed.providers.find((item: { id: string }) => item.id === target.id),
    ).toMatchObject({ webFetchPreflightPolicy: 'check' });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  test('rejects invalid policies and unauthorized users before saving or draining', async () => {
    const { queue } = bindPolicyQueue();
    const target = createPolicyProvider();
    for (const policy of ['off', 'disabled', true, null]) {
      expect(
        (await patchProvider(target.id, { webFetchPreflightPolicy: policy }))
          .status,
      ).toBe(400);
    }
    auth.role = 'member';
    expect(
      (await patchProvider(target.id, { webFetchPreflightPolicy: 'skip' }))
        .status,
    ).toBe(403);
    expect(
      runtimeConfig.getProviderById(target.id)!.webFetchPreflightPolicy,
    ).toBeUndefined();
    expect(
      queue.drainProviderRunnersForCredentialRefresh,
    ).not.toHaveBeenCalled();
  });

  test('a persistence failure drains no runner and keeps the saved value', async () => {
    const { queue } = bindPolicyQueue();
    const target = createPolicyProvider();
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('simulated disk failure');
    });
    try {
      expect(
        (await patchProvider(target.id, { webFetchPreflightPolicy: 'skip' }))
          .status,
      ).toBe(400);
    } finally {
      write.mockRestore();
    }
    expect(
      runtimeConfig.getProviderById(target.id)!.webFetchPreflightPolicy,
    ).toBeUndefined();
    expect(
      queue.drainProviderRunnersForCredentialRefresh,
    ).not.toHaveBeenCalled();
  });

  test('mixed protocol and policy edits keep the existing stop and session invalidation path', async () => {
    const { folder, queue } = bindPolicyQueue();
    const target = createPolicyProvider();
    db.setSessionProviderId(folder, '', target.id);
    const response = await patchProvider(target.id, {
      anthropicBaseUrl: 'https://new.example.test',
      webFetchPreflightPolicy: 'skip',
    });
    expect(response.status).toBe(200);
    expect(queue.stopGroup).toHaveBeenCalled();
    expect(
      queue.drainProviderRunnersForCredentialRefresh,
    ).not.toHaveBeenCalled();
    expect(db.getSession(folder)).toBeUndefined();
    expect(
      runtimeConfig.getProviderById(target.id)!.webFetchPreflightPolicy,
    ).toBe('skip');
  });
});

describe('provider runtime apply is a lossless configuration mutation', () => {
  test('lists connections with no default, pool or health', async () => {
    bindDeps(
      {},
      {
        listDescendantJids: () => [],
        pauseGroupsForMutation: () => ({ id: 10 }),
        resumeGroupsAfterMutation: vi.fn(),
        stopGroup: vi.fn(async () => {}),
      },
    );
    const initial = runtimeConfig.createProvider({
      name: unique('initial-model'),
      type: 'official',
      anthropicApiKey: 'initial-key',
    });
    const replacement = runtimeConfig.createProvider({
      name: unique('second-model'),
      type: 'third_party',
      anthropicBaseUrl: 'https://replacement.example.test',
      anthropicAuthToken: 'replacement-token',
      anthropicModel: 'replacement-model',
    });
    const response = await app.request('/api/config/claude/providers');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty('defaultModelConfigId');
    expect(body).not.toHaveProperty('balancing');
    expect(body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: initial.id, roles: {} }),
        expect.objectContaining({
          id: replacement.id,
          models: [{ id: 'replacement-model' }],
        }),
      ]),
    );
  });

  test('the default, enable, balancing and health routes are gone', async () => {
    const target = runtimeConfig.createProvider({
      name: unique('gone-routes'),
      type: 'official',
      anthropicApiKey: 'gone-key',
    });
    const json = { 'content-type': 'application/json' };
    for (const [method, url, body] of [
      ['PUT', '/api/config/claude/default', { modelConfigId: target.id }],
      ['PUT', '/api/config/claude/balancing', { strategy: 'failover' }],
      ['POST', `/api/config/claude/providers/${target.id}/reset-health`, {}],
      ['GET', '/api/config/claude/providers/health', undefined],
    ] as const) {
      const response = await app.request(url, {
        method,
        headers: json,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(response.status, `${method} ${url}`).toBe(404);
    }
    expect((await setProviderEnabled(target.id, true)).status).toBe(404);
    expect(runtimeConfig.readLegacyModelDefaults().defaultModelConfigId).toBe(
      null,
    );
  });

  test("blocks deleting an Agent's connection", async () => {
    bindDeps(
      {},
      {
        listDescendantJids: () => [],
        pauseGroupsForMutation: () => ({ id: 11 }),
        resumeGroupsAfterMutation: vi.fn(),
        stopGroup: vi.fn(async () => {}),
      },
    );
    const target = runtimeConfig.createProvider({
      name: unique('agent-model-target'),
      type: 'official',
      anthropicApiKey: 'target-key',
    });
    runtimeConfig.createProvider({
      name: unique('agent-model-fallback'),
      type: 'official',
      anthropicApiKey: 'fallback-key',
    });
    const profile = db.createAgentProfile({
      ownerUserId: 'provider-runtime-admin',
      name: unique('bound-agent'),
      modelConfigId: target.id,
    });

    const deleteResponse = await deleteProvider(target.id);
    expect(deleteResponse.status).toBe(400);
    expect(await deleteResponse.json()).toMatchObject({
      error: expect.stringContaining('智能体'),
    });
    expect(
      runtimeConfig
        .getProviders()
        .some((provider) => provider.id === target.id),
    ).toBe(true);

    expect(db.archiveAgentProfile(profile.id, 'provider-runtime-admin')).toBe(
      'ok',
    );
  });

  test('keeps a capacity-queued descendant task instead of dropping it', async () => {
    const folder = unique('queued-work');
    const jid = `web:${folder}`;
    const descendantJid = `${jid}#agent:queued`;
    const group = registerWorkspace(jid, folder);
    const queue = new GroupQueue();
    liveQueue = queue;
    queue.setSerializationKeyResolver((candidate) => {
      const agentSeparator = candidate.indexOf('#agent:');
      if (agentSeparator >= 0) {
        return `${folder}#${candidate.slice(agentSeparator + 7)}`;
      }
      return candidate === jid ? folder : candidate;
    });
    let capacityAllowed = false;
    queue.setUserConcurrentLimitChecker(() => ({
      allowed: capacityAllowed,
    }));

    let dropped = 0;
    let runs = 0;
    expect(
      queue.enqueueTask(
        descendantJid,
        'queued',
        async () => {
          runs += 1;
        },
        {
          onDropped: () => {
            dropped += 1;
          },
        },
      ),
    ).toBe(true);
    expect(queue.listDescendantJids(jid)).toEqual([descendantJid]);

    bindDeps({ [jid]: group }, queue);
    const provider = runtimeConfig.createProvider({
      name: unique('third-party'),
      type: 'third_party',
      anthropicBaseUrl: 'https://old.example.test',
      anthropicAuthToken: 'test-token',
      anthropicModel: 'old-model',
      enabled: true,
    });

    const response = await patchProvider(provider.id, {
      anthropicModel: 'new-model',
    });

    expect(response.status).toBe(200);
    expect(dropped).toBe(0);
    expect(queue.listDescendantJids(jid)).toEqual([descendantJid]);
    capacityAllowed = true;
    (
      queue as unknown as {
        drainWaiting: () => void;
      }
    ).drainWaiting();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(runs).toBe(1);
    expect(dropped).toBe(0);
  });

  test('never stops the same descendant concurrently when sibling JIDs share a folder', async () => {
    const folder = unique('sibling-stop');
    const webJid = `web:${folder}`;
    const imJid = `feishu:${folder}`;
    const descendantJid = `${webJid}#agent:researcher`;
    const webGroup = registerWorkspace(webJid, folder);
    const imGroup = registerWorkspace(imJid, folder);
    const inFlight = new Set<string>();
    let overlappingDuplicateStops = 0;
    const stopOptions: unknown[] = [];
    const queue = {
      listDescendantJids: () => [descendantJid],
      pauseGroupsForMutation: () => ({ id: 1 }),
      resumeGroupsAfterMutation: vi.fn(),
      stopGroup: vi.fn(async (target: string, options?: unknown) => {
        stopOptions.push(options);
        if (inFlight.has(target)) overlappingDuplicateStops += 1;
        inFlight.add(target);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight.delete(target);
      }),
    };
    bindDeps({ [webJid]: webGroup, [imJid]: imGroup }, queue);
    const provider = runtimeConfig.createProvider({
      name: unique('dedupe-provider'),
      type: 'third_party',
      anthropicBaseUrl: 'https://old.example.test',
      anthropicAuthToken: 'test-token',
      anthropicModel: 'old-model',
      enabled: true,
    });

    const response = await patchProvider(provider.id, {
      anthropicModel: 'new-model',
    });

    expect(response.status).toBe(200);
    expect(overlappingDuplicateStops).toBe(0);
    expect(stopOptions).not.toContain(undefined);
    expect(stopOptions).toSatisfy((options) =>
      options.every(
        (option) =>
          (option as { force?: boolean }).force === true &&
          (option as { preserveQueuedWork?: boolean }).preserveQueuedWork ===
            true,
      ),
    );
  });

  test('does not commit a provider update when pre-commit runtime quiesce fails', async () => {
    const folder = unique('pre-commit-failure');
    const jid = `web:${folder}`;
    const group = registerWorkspace(jid, folder);
    bindDeps(
      { [jid]: group },
      {
        listDescendantJids: () => [],
        pauseGroupsForMutation: () => ({ id: 2 }),
        resumeGroupsAfterMutation: vi.fn(),
        stopGroup: vi.fn(async () => {
          throw new Error('simulated stop failure');
        }),
      },
    );
    const provider = runtimeConfig.createProvider({
      name: unique('failed-provider'),
      type: 'third_party',
      anthropicBaseUrl: 'https://old.example.test',
      anthropicAuthToken: 'test-token',
      anthropicModel: 'old-model',
      enabled: true,
    });

    const response = await patchProvider(provider.id, {
      anthropicModel: 'must-not-commit',
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      error: expect.stringContaining('not updated'),
      applied: { success: false, persisted: false },
    });
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.anthropicModel,
    ).toBe('old-model');
  });

  test('repairs a stale provider session on an exact retry after post-commit quiesce fails', async () => {
    const folder = unique('post-commit-failure');
    const jid = `web:${folder}`;
    const group = registerWorkspace(jid, folder);
    const staleSessionId = unique('stale-session');
    let stopCalls = 0;
    const blockGroupsForRuntimeSafety = vi.fn();
    const unblockGroupsForRuntimeSafety = vi.fn();
    const queue = {
      listDescendantJids: () => [],
      pauseGroupsForMutation: () => ({ id: 4 }),
      resumeGroupsAfterMutation: vi.fn(),
      blockGroupsForRuntimeSafety,
      unblockGroupsForRuntimeSafety,
      stopGroup: vi.fn(async () => {
        stopCalls += 1;
        if (stopCalls === 2) {
          // Reproduce a runner finishing late after the transactional cleanup
          // and writing its old provider session back into SQLite.
          db.setSession(folder, staleSessionId);
          db.setSessionProviderId(folder, '', provider.id);
          throw new Error('simulated post-commit stop failure');
        }
      }),
    };
    bindDeps({ [jid]: group }, queue);
    const provider = runtimeConfig.createProvider({
      name: unique('partially-applied-provider'),
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicModel: 'old-model',
      enabled: true,
    });
    db.setSession(folder, unique('initial-session'));
    db.setSessionProviderId(folder, '', provider.id);

    const response = await patchProvider(provider.id, {
      anthropicModel: 'persisted-model',
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      error: expect.stringContaining('saved'),
      provider: { anthropicModel: 'persisted-model' },
      applied: { success: false, persisted: true, phase: 'post_commit' },
    });
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.anthropicModel,
    ).toBe('persisted-model');
    expect(db.getSession(folder)).toBe(staleSessionId);
    expect(blockGroupsForRuntimeSafety).toHaveBeenCalledWith(
      [jid],
      expect.stringContaining('post-commit provider runtime cleanup failed'),
      'provider-config-mutation',
    );
    expect(unblockGroupsForRuntimeSafety).not.toHaveBeenCalled();

    // A process restart creates a fresh in-memory queue. The durable pending
    // marker must rebuild its safety block when web dependencies are injected.
    const restartedQueue = new GroupQueue();
    liveQueue = restartedQueue;
    bindDeps({ [jid]: group }, restartedQueue);
    expect(restartedQueue.isGroupRuntimeSafetyBlocked(jid)).toBe(true);

    // The desired value is already persisted. The retry must still replay the
    // pending invalidation instead of treating this as a no-op.
    const retryResponse = await patchProvider(provider.id, {
      anthropicModel: 'persisted-model',
    });
    expect(retryResponse.status).toBe(200);
    expect(restartedQueue.isGroupRuntimeSafetyBlocked(jid)).toBe(false);
    expect(db.getSession(folder)).toBeUndefined();
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.anthropicModel,
    ).toBe('persisted-model');
  });

  test('unblocks a restarted workspace after an exact retry repairs pending session cleanup', async () => {
    const folder = unique('disabled-provider-repair');
    const jid = `web:${folder}`;
    const group = registerWorkspace(jid, folder);
    const staleSessionId = unique('disabled-repair-stale-session');
    let stopCalls = 0;
    const initialQueue = {
      listDescendantJids: () => [],
      pauseGroupsForMutation: () => ({ id: 8 }),
      resumeGroupsAfterMutation: vi.fn(),
      blockGroupsForRuntimeSafety: vi.fn(),
      unblockGroupsForRuntimeSafety: vi.fn(),
      stopGroup: vi.fn(async () => {
        stopCalls += 1;
        if (stopCalls === 2) {
          db.setSession(folder, staleSessionId);
          db.setSessionProviderId(folder, '', target.id);
          throw new Error('simulated post-commit stop failure');
        }
      }),
    };
    bindDeps({ [jid]: group }, initialQueue);
    const target = runtimeConfig.createProvider({
      name: unique('disabled-repair-target'),
      type: 'official',
      anthropicApiKey: 'target-key',
      anthropicModel: 'old-model',
      enabled: true,
    });
    runtimeConfig.createProvider({
      name: unique('disabled-repair-fallback'),
      type: 'official',
      anthropicApiKey: 'fallback-key',
      enabled: true,
    });
    db.setSession(folder, unique('disabled-repair-initial-session'));
    db.setSessionProviderId(folder, '', target.id);

    const failedPatch = await patchProvider(target.id, {
      anthropicModel: 'persisted-model',
    });
    expect(failedPatch.status).toBe(503);

    const restartedQueue = new GroupQueue();
    liveQueue = restartedQueue;
    bindDeps({ [jid]: group }, restartedQueue, {
      [folder]: staleSessionId,
    });
    expect(restartedQueue.isGroupRuntimeSafetyBlocked(jid)).toBe(true);

    const repairResponse = await patchProvider(target.id, {
      anthropicModel: 'persisted-model',
    });
    expect(repairResponse.status).toBe(200);
    expect(db.getSession(folder)).toBeUndefined();
    expect(restartedQueue.isGroupRuntimeSafetyBlocked(jid)).toBe(false);
  });

  test('deletes a pending provider through lossless runtime mutation and clears its gate', async () => {
    const folder = unique('pending-provider-delete');
    const jid = `web:${folder}`;
    const group = registerWorkspace(jid, folder);
    const staleSessionId = unique('delete-stale-session');
    let stopCalls = 0;
    const stopOptions: unknown[] = [];
    const unblockGroupsForRuntimeSafety = vi.fn();
    const queue = {
      listDescendantJids: () => [],
      pauseGroupsForMutation: vi.fn(() => ({ id: 9 })),
      resumeGroupsAfterMutation: vi.fn(),
      blockGroupsForRuntimeSafety: vi.fn(),
      unblockGroupsForRuntimeSafety,
      stopGroup: vi.fn(async (_targetJid: string, options?: unknown) => {
        stopCalls += 1;
        stopOptions.push(options);
        if (stopCalls === 2) {
          db.setSession(folder, staleSessionId);
          db.setSessionProviderId(folder, '', target.id);
          throw new Error('simulated post-commit stop failure');
        }
      }),
    };
    bindDeps({ [jid]: group }, queue);
    const target = runtimeConfig.createProvider({
      name: unique('delete-target'),
      type: 'official',
      anthropicApiKey: 'target-key',
      anthropicModel: 'old-model',
      enabled: true,
    });
    runtimeConfig.createProvider({
      name: unique('delete-fallback'),
      type: 'official',
      anthropicApiKey: 'fallback-key',
      enabled: true,
    });
    db.setSession(folder, unique('delete-initial-session'));
    db.setSessionProviderId(folder, '', target.id);

    const failedPatch = await patchProvider(target.id, {
      anthropicModel: 'persisted-model',
    });
    expect(failedPatch.status).toBe(503);
    expect(db.getSession(folder)).toBe(staleSessionId);

    const deleteResponse = await deleteProvider(target.id);
    expect(deleteResponse.status).toBe(200);
    expect(
      runtimeConfig
        .getProviders()
        .some((provider) => provider.id === target.id),
    ).toBe(false);
    expect(stopCalls).toBe(4);
    expect(stopOptions).toSatisfy((options) =>
      options.every(
        (option) =>
          (option as { force?: boolean }).force === true &&
          (option as { preserveQueuedWork?: boolean }).preserveQueuedWork ===
            true,
      ),
    );
    expect(db.getSession(folder)).toBeUndefined();
    expect(
      db.getRouterState(`provider_session_invalidation_pending:${target.id}`),
    ).toBeUndefined();
    expect(unblockGroupsForRuntimeSafety).toHaveBeenCalledWith(
      [jid],
      'provider-config-mutation',
    );
  });

  test('does not release a runtime safety block owned by another mutation source', async () => {
    const folder = unique('cross-source-runtime-block');
    const jid = `web:${folder}`;
    const group = registerWorkspace(jid, folder);
    const queue = new GroupQueue();
    liveQueue = queue;
    bindDeps({ [jid]: group }, queue);
    queue.blockGroupsForRuntimeSafety(
      [jid],
      'capability mutation requires manual repair',
    );
    const provider = runtimeConfig.createProvider({
      name: unique('cross-source-provider'),
      type: 'third_party',
      anthropicBaseUrl: 'https://same.example.test',
      anthropicAuthToken: 'test-token',
      anthropicModel: 'old-model',
      enabled: true,
    });

    const response = await patchProvider(provider.id, {
      anthropicModel: 'new-model',
    });

    expect(response.status).toBe(200);
    expect(queue.isGroupRuntimeSafetyBlocked(jid)).toBe(true);
  });

  test('serializes manual apply with a concurrent provider mutation', async () => {
    const folder = unique('manual-apply-lock');
    const jid = `web:${folder}`;
    const group = registerWorkspace(jid, folder);
    let releaseFirstStop!: () => void;
    const firstStopGate = new Promise<void>((resolve) => {
      releaseFirstStop = resolve;
    });
    let stopCalls = 0;
    bindDeps(
      { [jid]: group },
      {
        listDescendantJids: () => [],
        pauseGroupsForMutation: () => ({ id: 5 }),
        resumeGroupsAfterMutation: vi.fn(),
        blockGroupsForRuntimeSafety: vi.fn(),
        unblockGroupsForRuntimeSafety: vi.fn(),
        stopGroup: vi.fn(async () => {
          stopCalls += 1;
          if (stopCalls === 1) await firstStopGate;
        }),
      },
    );
    const provider = runtimeConfig.createProvider({
      name: unique('locked-provider'),
      type: 'third_party',
      anthropicBaseUrl: 'https://same.example.test',
      anthropicAuthToken: 'test-token',
      anthropicModel: 'old-model',
      enabled: true,
    });

    const patchRequest = patchProvider(provider.id, {
      anthropicModel: 'new-model',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopCalls).toBe(1);

    const manualApplyRequest = app.request('/api/config/claude/apply', {
      method: 'POST',
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopCalls).toBe(1);

    releaseFirstStop();
    const [patchResponse, applyResponse] = await Promise.all([
      patchRequest,
      manualApplyRequest,
    ]);
    expect(patchResponse.status).toBe(200);
    expect(applyResponse.status).toBe(200);
    expect(stopCalls).toBe(4);
  });

  test.each([
    { label: 'pre-commit', failAt: 1, persisted: false },
    { label: 'post-commit', failAt: 2, persisted: true },
  ])(
    'returns a non-2xx status when manual apply fails in the $label pass',
    async ({ failAt, persisted }) => {
      const folder = unique('manual-apply-failure');
      const jid = `web:${folder}`;
      const group = registerWorkspace(jid, folder);
      let stopCalls = 0;
      bindDeps(
        { [jid]: group },
        {
          listDescendantJids: () => [],
          pauseGroupsForMutation: () => ({ id: 7 }),
          resumeGroupsAfterMutation: vi.fn(),
          blockGroupsForRuntimeSafety: vi.fn(),
          unblockGroupsForRuntimeSafety: vi.fn(),
          stopGroup: vi.fn(async () => {
            stopCalls += 1;
            if (stopCalls === failAt) {
              throw new Error('simulated manual apply failure');
            }
          }),
        },
      );

      const response = await app.request('/api/config/claude/apply', {
        method: 'POST',
      });
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(response.ok).toBe(false);
      expect(body).toMatchObject({ success: false, persisted });
    },
  );
});

describe('provider session invalidation only removes attributable sessions', () => {
  function bindIdleWorkspace(jid: string, folder: string, sessionId: string) {
    const group = registerWorkspace(jid, folder);
    const sessions = { [folder]: sessionId };
    bindDeps(
      { [jid]: group },
      {
        listDescendantJids: () => [],
        pauseGroupsForMutation: () => ({ id: 3 }),
        resumeGroupsAfterMutation: vi.fn(),
        stopGroup: vi.fn(async () => {}),
      },
      sessions,
    );
    return sessions;
  }

  test('preserves an unbound session owned by a workspace-level env override', async () => {
    const folder = unique('env-override');
    const jid = `web:${folder}`;
    const sessionId = unique('override-session');
    bindIdleWorkspace(jid, folder, sessionId);
    db.setSession(folder, sessionId);
    runtimeConfig.saveContainerEnvConfig(folder, {
      anthropicBaseUrl: 'https://workspace.example.test',
      anthropicAuthToken: 'workspace-token',
      anthropicModel: 'workspace-model',
    });
    const provider = runtimeConfig.createProvider({
      name: unique('official'),
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicModel: 'old-model',
      enabled: true,
    });

    const response = await patchProvider(provider.id, {
      anthropicModel: 'new-model',
    });

    expect(response.status).toBe(200);
    expect(db.getSession(folder)).toBe(sessionId);
  });

  test('preserves an unbound session with a workspace model-only override during a global model-only update', async () => {
    const folder = unique('model-only-override');
    const jid = `web:${folder}`;
    const sessionId = unique('model-override-session');
    bindIdleWorkspace(jid, folder, sessionId);
    db.setSession(folder, sessionId);
    runtimeConfig.saveContainerEnvConfig(folder, {
      anthropicModel: 'workspace-model',
    });
    const provider = runtimeConfig.createProvider({
      name: unique('official'),
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicModel: 'old-global-model',
      enabled: true,
    });

    const response = await patchProvider(provider.id, {
      anthropicModel: 'new-global-model',
    });

    expect(response.status).toBe(200);
    expect(db.getSession(folder)).toBe(sessionId);
  });

  test('clears an unbound session when credentials override but the changed model does not', async () => {
    const folder = unique('credential-only-override');
    const jid = `web:${folder}`;
    const sessionId = unique('credential-override-session');
    bindIdleWorkspace(jid, folder, sessionId);
    db.setSession(folder, sessionId);
    runtimeConfig.saveContainerEnvConfig(folder, {
      anthropicAuthToken: 'workspace-token',
    });
    const provider = runtimeConfig.createProvider({
      name: unique('official'),
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicModel: 'old-global-model',
      enabled: true,
    });

    const response = await patchProvider(provider.id, {
      anthropicModel: 'new-global-model',
    });

    expect(response.status).toBe(200);
    expect(db.getSession(folder)).toBeUndefined();
  });

  test('clears an unbound session unless every changed protocol field is overridden', async () => {
    const folder = unique('partial-protocol-override');
    const jid = `web:${folder}`;
    const sessionId = unique('partial-override-session');
    bindIdleWorkspace(jid, folder, sessionId);
    db.setSession(folder, sessionId);
    runtimeConfig.saveContainerEnvConfig(folder, {
      anthropicModel: 'workspace-model',
    });
    const provider = runtimeConfig.createProvider({
      name: unique('official'),
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicBaseUrl: 'https://old-global.example.test',
      anthropicModel: 'old-global-model',
      enabled: true,
    });

    const response = await patchProvider(provider.id, {
      anthropicBaseUrl: 'https://new-global.example.test',
      anthropicModel: 'new-global-model',
    });

    expect(response.status).toBe(200);
    expect(db.getSession(folder)).toBeUndefined();
  });

  test('repairs a corrupt durable invalidation marker instead of leaving a permanent gate', async () => {
    const folder = unique('corrupt-pending-marker');
    const jid = `web:${folder}`;
    const sessionId = unique('corrupt-marker-session');
    const group = registerWorkspace(jid, folder);
    db.setSession(folder, sessionId);
    const provider = runtimeConfig.createProvider({
      name: unique('official'),
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicModel: 'unchanged-model',
      enabled: true,
    });
    db.setSessionProviderId(folder, '', provider.id);
    db.setRouterState(
      `provider_session_invalidation_pending:${provider.id}`,
      '{corrupt-json',
    );
    const restartedQueue = new GroupQueue();
    liveQueue = restartedQueue;
    bindDeps({ [jid]: group }, restartedQueue, {
      [folder]: sessionId,
    });

    expect(restartedQueue.isGroupRuntimeSafetyBlocked(jid)).toBe(true);
    const response = await patchProvider(provider.id, {
      anthropicModel: 'unchanged-model',
    });

    expect(response.status).toBe(200);
    expect(db.getSession(folder)).toBeUndefined();
    expect(restartedQueue.isGroupRuntimeSafetyBlocked(jid)).toBe(false);
    expect(
      db.getRouterState(`provider_session_invalidation_pending:${provider.id}`),
    ).toBeUndefined();
  });

  test('preserves ambiguous unbound sessions when another provider is configured but disabled', async () => {
    const folder = unique('ambiguous-unbound');
    const jid = `web:${folder}`;
    const sessionId = unique('ambiguous-session');
    bindIdleWorkspace(jid, folder, sessionId);
    db.setSession(folder, sessionId);
    const provider = runtimeConfig.createProvider({
      name: unique('official'),
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicModel: 'old-model',
      enabled: true,
    });
    runtimeConfig.createProvider({
      name: unique('disabled-third-party'),
      type: 'third_party',
      anthropicBaseUrl: 'https://disabled.example.test',
      anthropicAuthToken: 'disabled-token',
      enabled: false,
    });

    const response = await patchProvider(provider.id, {
      anthropicModel: 'new-model',
    });

    expect(response.status).toBe(200);
    expect(db.getSession(folder)).toBe(sessionId);
  });

  test('still clears a legacy unbound session in a true single-provider workspace', async () => {
    const folder = unique('single-provider');
    const jid = `web:${folder}`;
    const sessionId = unique('legacy-session');
    bindIdleWorkspace(jid, folder, sessionId);
    db.setSession(folder, sessionId);
    const provider = runtimeConfig.createProvider({
      name: unique('official'),
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicModel: 'old-model',
      enabled: true,
    });

    const response = await patchProvider(provider.id, {
      anthropicModel: 'new-model',
    });

    expect(response.status).toBe(200);
    expect(db.getSession(folder)).toBeUndefined();
  });

  test('clears a bound third-party session for a model-only change', async () => {
    const folder = unique('third-party-model');
    const jid = `web:${folder}`;
    const sessionId = unique('bound-session');
    bindIdleWorkspace(jid, folder, sessionId);
    db.setSession(folder, sessionId);
    const provider = runtimeConfig.createProvider({
      name: unique('third-party'),
      type: 'third_party',
      anthropicBaseUrl: 'https://same.example.test',
      anthropicAuthToken: 'third-party-token',
      anthropicModel: 'old-model',
      enabled: true,
    });
    db.setSessionProviderId(folder, '', provider.id);

    const response = await patchProvider(provider.id, {
      anthropicModel: 'new-model',
    });

    expect(response.status).toBe(200);
    expect(db.getSession(folder)).toBeUndefined();
    expect(db.getSessionProviderId(folder)).toBeUndefined();
  });

  test('does not clear a provider session when the requested config is invalid', async () => {
    const folder = unique('invalid-provider-patch');
    const jid = `web:${folder}`;
    const sessionId = unique('invalid-patch-session');
    bindIdleWorkspace(jid, folder, sessionId);
    db.setSession(folder, sessionId);
    const provider = runtimeConfig.createProvider({
      name: unique('official'),
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicBaseUrl: 'https://valid.example.test',
      anthropicModel: 'old-model',
      enabled: true,
    });
    db.setSessionProviderId(folder, '', provider.id);

    const response = await patchProvider(provider.id, {
      anthropicBaseUrl: 'not-a-url',
    });

    expect(response.status).toBe(400);
    expect(db.getSession(folder)).toBe(sessionId);
    expect(db.getSessionProviderId(folder)).toBe(provider.id);
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.anthropicBaseUrl,
    ).toBe('https://valid.example.test');
  });

  test('keeps the main-session cache when only a target-provider agent session is invalidated', async () => {
    const folder = unique('agent-only-invalidation');
    const jid = `web:${folder}`;
    const mainSessionId = unique('main-session');
    const agentSessionId = unique('agent-session');
    const sessions = bindIdleWorkspace(jid, folder, mainSessionId);
    db.setSession(folder, mainSessionId);
    const target = runtimeConfig.createProvider({
      name: unique('official-target'),
      type: 'official',
      anthropicApiKey: 'target-key',
      anthropicModel: 'old-model',
      enabled: true,
    });
    const other = runtimeConfig.createProvider({
      name: unique('other-provider'),
      type: 'third_party',
      anthropicBaseUrl: 'https://other.example.test',
      anthropicAuthToken: 'other-token',
      enabled: false,
    });
    db.setSessionProviderId(folder, '', other.id);
    db.setSession(folder, agentSessionId, 'agent-a');
    db.setSessionProviderId(folder, 'agent-a', target.id);

    const response = await patchProvider(target.id, {
      anthropicModel: 'new-model',
    });

    expect(response.status).toBe(200);
    expect(db.getSession(folder)).toBe(mainSessionId);
    expect(db.getSession(folder, 'agent-a')).toBeUndefined();
    expect(sessions[folder]).toBe(mainSessionId);
  });
});
