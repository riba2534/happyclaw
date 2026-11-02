import fs from 'node:fs';
import { InputUsageProjection } from '../src/input-usage-projection.js';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';
import {
  ActiveChannelTurnRegistry,
  channelTurnScope,
} from '../src/channel-turn-registry.js';
import {
  parseChannelAddress,
  channelConversationJid,
} from '../src/channel-address.js';
import { resolveFeishuCliBoundAccountId } from '../src/feishu-cli-runtime.js';
import type { ChannelTurnContext } from '../src/types.js';
import { writeExclusiveIpcResult } from '../src/ipc-exclusive-result.js';
import { ActiveChannelOutboxScopeRegistry } from '../src/channel-outbox-runtime-scope.js';
import {
  grantWorkspaceMemoryTurnToCurrentRunner,
  issueWorkspaceMemoryWriteCapability,
  verifyAndConsumeWorkspaceMemoryMutation,
} from '../src/workspace-memory-capability.js';
import {
  activateMcpChannelTurn,
  createMcpTools,
  type McpContext,
} from '../container/agent-runner/src/mcp-tools.js';
import { signWorkspaceMemoryMutation } from '../container/agent-runner/src/workspace-memory-auth.js';
import {
  IpcTurnDeliveryTracker,
  IpcTurnOutputCorrelation,
  latestIpcInputMessage,
} from '../container/agent-runner/src/ipc-delivery.js';
import { normalizeChannelTurnContext } from '../container/agent-runner/src/types.js';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config.js', async (original) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  paths.root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-im-warm-context-'));
  return {
    ...(await original<Record<string, unknown>>()),
    DATA_DIR: paths.root,
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/container-runner.js', () => ({ killProcessTree: () => {} }));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({
    maxConcurrentContainers: 10,
    maxConcurrentHostProcesses: 10,
  }),
}));
vi.mock('../src/db.js', () => ({
  getChannelAccount: () => undefined,
}));
const { GroupQueue } = await import('../src/group-queue.js');
const releases: Array<() => void> = [];
const tick = () => new Promise((resolve) => setImmediate(resolve));

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await tick();
  await tick();
  fs.rmSync(paths.root, { recursive: true, force: true });
});

function context(accountId: string, messageId: string): ChannelTurnContext {
  return {
    schemaVersion: 1,
    provider: 'feishu',
    channelAccountId: accountId,
    sourceJid: `feishu:chat-${accountId}#account:${accountId}`,
    bot: { appId: `app-${accountId}` },
    chat: { id: `chat-${accountId}`, type: 'p2p' },
    message: { id: messageId },
    capabilities: ['send_card'],
  };
}

async function fixture(
  options: {
    accountId?: string;
    host?: boolean;
    mode?: 'assistant' | 'proactive';
  } = {},
) {
  const queue = new GroupQueue();
  const jid = 'web:review#agent:agent1';
  const agentId = 'agent1';
  const group = {
    folder: 'review',
    executionMode: options.host ? 'host' : 'container',
    channel_account_id: 'account-a',
  };
  const cold = context('account-a', 'cold-a');
  const warm = context(options.accountId ?? 'account-a', 'warm-b');
  const capabilityScope = {
    groupFolder: 'review',
    agentId,
    taskRunId: null,
  };
  const auth = issueWorkspaceMemoryWriteCapability(capabilityScope, 'cold-a');
  queue.enqueueTask(
    jid,
    'running',
    () => new Promise<void>((resolve) => releases.push(resolve)),
  );
  await tick();
  queue.registerProcess(jid, { kill: () => true, killed: false } as never, {
    containerName: options.host ? null : 'container-a',
    groupFolder: 'review',
    agentId,
    feishuCliAccountId: 'account-a',
    interactionMode: 'assistant',
  });
  // Another session's runner in the folder must never receive this one's
  // sentinel.
  queue.enqueueTask(
    'web:review#agent:sibling',
    'sibling',
    () => new Promise<void>((resolve) => releases.push(resolve)),
  );
  await tick();
  queue.registerProcess(
    'web:review#agent:sibling',
    { kill: () => true, killed: false } as never,
    {
      containerName: 'container-sibling',
      groupFolder: 'review',
      agentId: 'sibling',
      interactionMode: 'assistant',
    },
  );
  const message = {
    id: 'warm-b',
    timestamp: '2026-10-07T00:00:00.000Z',
    source_jid: warm.sourceJid,
    channel_context: warm,
  };
  const registry = new ActiveChannelTurnRegistry();
  const scope = channelTurnScope('review', agentId);
  const outbox = new ActiveChannelOutboxScopeRegistry();
  registry.set(scope, {
    correlationId: 'cold-a',
    sourceJid: cold.sourceJid,
    context: cold,
  });
  const runtimeStart = vi.fn(() => ({
    executionDisposition: 'execute',
    reserveStreamingCard: () => ({}),
    dispose: vi.fn(),
  }));
  const globals: Record<string, any> = {
    agentInputUsageProjection: new InputUsageProjection('cold-a'),
    fs,
    path,
    writeExclusiveIpcResult,
    shuttingDown: false,
    registeredGroups: { [warm.sourceJid]: group },
    getRegisteredGroup: () => group,
    getAgent: () => ({
      chat_jid: 'web:review',
      group_folder: 'review',
      kind: 'conversation',
    }),
    lastAgentTimestamp: {},
    EMPTY_CURSOR: { id: '', timestamp: '' },
    getMessagesSince: () => [message],
    resolveEffectiveGroup: () => ({ effectiveGroup: group }),
    selectRuntimeInteractionBatch: () => ({
      messages: [message],
      interactionMode: options.mode ?? 'assistant',
    }),
    selectChannelReplyBatch: (messages: unknown) => messages,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    collectPersistedReferencedMessageIds: () => new Set(),
    formatMessages: () => '<messages>Warm input</messages>',
    collectMessageImages: () => [],
    createIpcDeliveryTarget: () => ({
      chatJid: jid,
      cursor: { id: 'warm-b', timestamp: message.timestamp },
      coveredCursors: [{ id: 'warm-b', timestamp: message.timestamp }],
    }),
    resolveBatchChannelContext: () => ({
      ...warm,
      workspaceJid: 'web:review',
      sessionAgentId: 'agent1',
    }),
    resolveFeishuCliBoundAccountId,
    queue,
    activeHeldCardFinalizers: new Map(),
    activeAgentBuilderTurns: { enqueueBatch: vi.fn() },
    agentBuilderTurnScope: () => '',
    grantWorkspaceMemoryTurnToCurrentRunner,
    advanceNextPullCursorOnly: vi.fn(),
    processAgentConversation: vi.fn(),
    activeChannelTurns: registry,
    channelTurnScope,
    agentAdmissionKey: scope,
    admittedWarmAgentInputs: new Map(),
    agentInputMessagesByTurn: new Map(),
    resolveInputChannelReplySource: (jid: string | null) =>
      jid?.startsWith('feishu:') ? jid : null,
    parseChannelAddress,
    channelConversationJid,
    currentAgentSessionId: 'sdk-session',
    ChannelTurnRuntime: { start: runtimeStart },
    interactionMode: 'assistant',
    publishesFrameworkAnswer: () => true,
    bindChannelOutboxScope: (
      key: string,
      _runtime: unknown,
      route: any,
      inputTurnId: string,
    ) =>
      outbox.bind(key, {
        ...route,
        inputTurnId,
        owner: 'test',
        turnRunId: 'turn-b',
        logicalBaseChatJid: 'web:review',
      }),
    activeChannelOutboxScopes: outbox,
    agentChannelTurnRuntimes: new Map(),
    agentChannelOutboxScopesByInput: new Map(),
    agentAnyReplyProjectedByInput: new Map(),
    agentGenuineReplyDeliveredByInput: new Map(),
    selectBatchProcessingIndicatorOwners: () => [],
    agentProcessingIndicatorInputsByCompletion: new Map(),
    agentProcessingTypingLeaseIdsByCompletion: new Map(),
    agentProcessingIndicatorJidsByInput: new Map(),
    trackProcessingIndicator: vi.fn(),
    activeRouteAdmissions: new Map(),
    streamingSessionJid: undefined,
    agentId: 'agent1',
    admitWarmSessionInputs: () => true,
    virtualChatJid: jid,
    virtualJid: jid,
    getChannelType: () => 'feishu',
    effectiveGroup: group,
    group,
    chatJid: 'web:review',
    lastProcessed: { id: 'cold-a' },
    currentAgentChannelContext: cold,
    getMessageChannelTurnContext: (_jid: string, id: string) =>
      id === 'warm-b' ? warm : null,
    agentStreamingSessionsByInput: new Map(),
    activeChannelTurnActivators: new Map(),
    healthyAgentCompletedInputTurns: new Set(),
    getAgentBuilderInputMessage: () => null,
    SAFE_REQUEST_ID_RE: /^[A-Za-z0-9-]+$/,
    verifyAndConsumeWorkspaceMemoryMutation,
    canAccessGroup: vi.fn(),
    isFeishuCapabilityMutation: () => false,
    imManager: {
      executeFeishuCapability: vi.fn(async () => ({
        chat: { id: 'warm-chat' },
      })),
    },
  };
  const harness = createRuntimeSourceHarness(globals);
  harness.installCallArgument(
    'realAgentAdmission',
    'processAgentConversation',
    'activeRouteAdmissions.set',
    1,
  );
  globals.activeRouteAdmissions.set(scope, globals.realAgentAdmission);
  harness.install('invokeActiveRouteAdmission');
  harness.install('bindActiveChannelTurn');
  harness.install('createChannelTurnActivator');
  harness.install('isCursorAfter');
  harness.install('activateAgentChannelTurn', 'processAgentConversation');
  globals.activeChannelTurnActivators.set(
    scope,
    globals.activateAgentChannelTurn,
  );
  harness.install('activateRequestedChannelTurn');
  harness.install('processTaskIpc');
  harness.install('writeTaskResult');
  harness.install('resolveImRoute');
  harness.install(
    'activateAgentProjectionForInput',
    'processAgentConversation',
  );
  globals.activateProjectionForInput = globals.activateAgentProjectionForInput;
  harness.install('buildOnAgentMessage');
  const input = path.join(
    paths.root,
    'ipc',
    'review',
    'agents',
    'agent1',
    'input',
  );
  const trigger = () => globals.buildOnAgentMessage()(warm.sourceJid, 'agent1');
  const tasksDir = path.join(path.dirname(input), 'tasks');
  const dispatch = (request: Record<string, unknown>) =>
    globals.processTaskIpc(
      request,
      'review',
      false,
      false,
      group,
      tasksDir,
      agentId,
      null,
    );
  const flushRequest = async (type: string, inputTurnId?: string) => {
    let file = '';
    let request: Record<string, any>;
    await vi.waitFor(() => {
      for (const filename of fs.readdirSync(tasksDir)) {
        if (!filename.endsWith('.json') || filename.includes('_result_'))
          continue;
        const candidate = JSON.parse(
          fs.readFileSync(path.join(tasksDir, filename), 'utf8'),
        );
        if (
          candidate.type === type &&
          (!inputTurnId || candidate.inputTurnId === inputTurnId)
        ) {
          file = filename;
          request = candidate;
          break;
        }
      }
      expect(file).toBeTruthy();
    });
    fs.unlinkSync(path.join(tasksDir, file));
    await dispatch(request!);
    return request!;
  };
  const payloads = () =>
    fs
      .readdirSync(input)
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(input, name), 'utf8')),
      );
  return {
    queue,
    globals,
    registry,
    scope,
    cold,
    warm,
    runtimeStart,
    input,
    trigger,
    payloads,
    tasksDir,
    dispatch,
    flushRequest,
    auth,
    capabilityScope,
    outbox,
    jid,
    agentId,
  };
}

test('same-Bot IM follow-up preserves context and keeps A active until B executes', async () => {
  const f = await fixture();
  f.trigger();
  const [payload] = f.payloads();
  expect(payload.channelContext).toMatchObject(f.warm);
  expect(f.registry.require(f.scope, 'cold-a').context).toEqual(f.cold);
  expect(() => f.registry.require(f.scope, payload.receipt.deliveryId)).toThrow(
    /active input/,
  );
  expect(fs.existsSync(path.join(f.input, '_drain'))).toBe(false);
  await f.globals.activateAgentProjectionForInput('cold-a');
  expect(f.registry.require(f.scope, 'cold-a').context).toEqual(f.cold);
  await f.globals.activateAgentProjectionForInput(payload.receipt.deliveryId);
  // Rendering B or late A output cannot change capability ownership.
  expect(f.registry.require(f.scope, 'cold-a').context).toEqual(f.cold);
});

test('idle injection waits for runner activation before changing the input', async () => {
  const f = await fixture();
  f.queue.markRunnerQueryIdle('web:review#agent:agent1');
  f.trigger();
  const [payload] = f.payloads();
  expect(f.registry.require(f.scope, 'cold-a').context).toEqual(f.cold);
  expect(() => f.registry.require(f.scope, payload.receipt.deliveryId)).toThrow(
    /active input/,
  );
});

test.each([{ accountId: 'account-b' }, { mode: 'proactive' as const }])(
  'incompatible IM input drains only its exact agent safely: %j',
  async (options) => {
    const f = await fixture(options);
    const close = vi.spyOn(f.queue, 'closeStdin');
    f.trigger();
    expect(f.payloads()).toEqual([]);
    expect(f.runtimeStart).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.input, '_drain'))).toBe(true);
    expect(fs.existsSync(path.join(f.input, '_close'))).toBe(false);
    expect(
      fs.existsSync(path.join(paths.root, 'ipc', 'review', 'input', '_drain')),
    ).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(f.registry.require(f.scope, 'cold-a').context).toEqual(f.cold);
  },
);

test('host-mode native Feishu credentials do not impose a container Bot identity', async () => {
  const f = await fixture({ accountId: 'account-b', host: true });
  f.trigger();
  const [payload] = f.payloads();
  expect(payload.channelContext.channelAccountId).toBe('account-b');
  expect(f.runtimeStart).toHaveBeenCalledWith(
    expect.objectContaining({ accountId: 'account-b' }),
  );
  expect(fs.existsSync(path.join(f.input, '_drain'))).toBe(false);
});

function runner(f: Awaited<ReturnType<typeof fixture>>) {
  const input = {
    chatJid: 'web:review',
    channelContext: f.cold,
    queryRunId: f.queue.getActiveQueryId(f.jid)!,
  };
  const ctx: McpContext = {
    get chatJid() {
      return input.channelContext?.sourceJid || input.chatJid;
    },
    groupFolder: 'review',
    isHome: false,
    isAdminHome: false,
    agentBuilderEnabled: false,
    ownerProfileEnabled: false,
    get channelContext() {
      return input.channelContext;
    },
    currentInputTurnId: 'cold-a',
    workspaceMemoryMutationAuth: {
      runnerInstanceId: f.auth.runnerInstanceId,
      secret: f.auth.signingSecret,
      agentId: f.agentId,
    },
    workspaceIpc: path.dirname(f.input),
    workspaceGroup: paths.root,
  };
  const tracker = new IpcTurnDeliveryTracker();
  const globals: Record<string, any> = {
    ipcDeliveryTracker: tracker,
    outputCorrelation: new IpcTurnOutputCorrelation(tracker, 'cold-a'),
    latestIpcInputMessage,
    normalizeChannelTurnContext,
    emitOutput: true,
    mcpToolsContext: ctx,
    containerInput: input,
    activateMcpChannelTurn,
    activeOutputInputTurnId: 'cold-a',
    activeInterruptQueryRunId: input.queryRunId,
  };
  const harness = createRuntimeSourceHarness(
    globals,
    new URL('../container/agent-runner/src/index.ts', import.meta.url),
  );
  harness.install('setCurrentChannelTurn');
  harness.install('activateCurrentInputTurn', 'runQueryAttempt');
  return {
    ctx,
    tracker,
    activate: (fallback?: string) => globals.activateCurrentInputTurn(fallback),
    tools: createMcpTools(ctx),
  };
}

test.each([{ idleRace: false }, { idleRace: true }])(
  'first Feishu tool for B waits for real activation and host ACK before text: %j',
  async ({ idleRace }) => {
    const f = await fixture();
    const r = runner(f);
    r.activate('cold-a');
    f.trigger();
    const [payload] = f.payloads();
    // A's first tool can start after B was published but before B is current.
    const firstA = r.tools
      .find((tool) => tool.name === 'feishu_get_chat')!
      .handler({}, {} as never);
    await f.flushRequest('activate_channel_turn', 'cold-a');
    await f.flushRequest('feishu_capability', 'cold-a');
    await expect(firstA).resolves.toBeDefined();
    expect(f.globals.imManager.executeFeishuCapability).toHaveBeenCalledWith(
      f.cold.sourceJid,
      expect.objectContaining(f.cold),
      expect.objectContaining({ operation: 'get_chat' }),
    );
    f.globals.imManager.executeFeishuCapability.mockClear();
    // Admission and even a forged queued-input activation do not grant ownership.
    await f.dispatch({
      type: 'activate_channel_turn',
      requestId: 'forged-b',
      inputTurnId: payload.receipt.deliveryId,
      queryRunId: payload.queryRunId,
      runnerInstanceId: f.auth.runnerInstanceId,
      activationSequence: 2,
    });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(f.tasksDir, 'activate_channel_turn_result_forged-b.json'),
          'utf8',
        ),
      ).success,
    ).toBe(false);
    expect(f.registry.require(f.scope, 'cold-a').context).toEqual(f.cold);
    if (idleRace) {
      // The file is durable but has not yet reached the runner when A finishes.
      // C reserves a new presentation query while B retains its publication id.
      f.queue.markRunnerQueryIdle(f.jid);
      const cQuery = f.queue.reserveNextQuery(f.jid);
      expect(cQuery).not.toBe(payload.queryRunId);
      expect(
        f.queue.getPublishedIpcQueryId(f.jid, payload.receipt.deliveryId),
      ).toBe(payload.queryRunId);
    }
    // Only now has the runner made B its current input. No host text/result
    // callback has run; the first SDK action is a tool call.
    r.tracker.acceptTurn([payload]);
    expect(r.tracker.currentTurnDeliveryId).toBeUndefined();
    r.tracker.completeNextTurn(); // A's immutable result has been emitted.
    r.activate();
    const tool = r.tools.find(
      (candidate) => candidate.name === 'feishu_get_chat',
    )!;
    const pending = tool.handler({}, {} as never);
    const requests = fs
      .readdirSync(f.tasksDir)
      .filter((filename) => !filename.includes('_result_'))
      .map((filename) =>
        JSON.parse(fs.readFileSync(path.join(f.tasksDir, filename), 'utf8')),
      );
    expect(requests.map((request) => request.type)).toEqual([
      'activate_channel_turn',
    ]);
    expect(f.globals.imManager.executeFeishuCapability).not.toHaveBeenCalled();
    const activation = await f.flushRequest('activate_channel_turn');
    expect(activation).toMatchObject({
      inputTurnId: payload.receipt.deliveryId,
      activationSequence: 2,
      queryRunId: payload.queryRunId,
    });
    const capability = await f.flushRequest('feishu_capability');
    expect(capability.inputTurnId).toBe(payload.receipt.deliveryId);
    await expect(pending).resolves.toMatchObject({
      content: [
        expect.objectContaining({ text: expect.stringContaining('warm-chat') }),
      ],
    });
    expect(f.globals.imManager.executeFeishuCapability).toHaveBeenCalledWith(
      f.warm.sourceJid,
      expect.objectContaining(f.warm),
      expect.objectContaining({ operation: 'get_chat' }),
    );
    // A late output projection and even a newly signed old-input request must
    // not reclaim B's ownership.
    await f.globals.activateProjectionForInput('cold-a');
    const stale: Record<string, unknown> = {
      type: 'activate_channel_turn',
      requestId: 'stale-a',
      inputTurnId: 'cold-a',
      queryRunId: payload.queryRunId,
      runnerInstanceId: f.auth.runnerInstanceId,
      activationSequence: 3,
    };
    stale.mutationSignature = signWorkspaceMemoryMutation(
      f.auth.signingSecret,
      f.capabilityScope,
      stale,
    );
    await f.dispatch(stale);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(f.tasksDir, 'activate_channel_turn_result_stale-a.json'),
          'utf8',
        ),
      ).success,
    ).toBe(false);
    expect(
      f.registry.require(f.scope, payload.receipt.deliveryId).context,
    ).toMatchObject(f.warm);
  },
);

test.each(['rejected', 'timeout'] as const)(
  'activation %s returns a normal tool failure without capability execution',
  async (kind) => {
    const f = await fixture();
    const r = runner(f);
    r.ctx.currentQueryRunId = f.queue.getActiveQueryId(
      'web:review#agent:agent1',
    );
    activateMcpChannelTurn(r.ctx, 40);
    const tool = r.tools.find(
      (candidate) => candidate.name === 'feishu_get_chat',
    )!;
    const pending = tool.handler({}, {} as never);
    const failure = expect(pending).rejects.toThrow(
      kind === 'timeout' ? /IPC result timeout/ : /activation rejected/,
    );
    if (kind === 'rejected') {
      const filename = fs
        .readdirSync(f.tasksDir)
        .find((name) => name.endsWith('.json'))!;
      const request = JSON.parse(
        fs.readFileSync(path.join(f.tasksDir, filename), 'utf8'),
      );
      fs.writeFileSync(
        path.join(
          f.tasksDir,
          `activate_channel_turn_result_${request.requestId}.json`,
        ),
        JSON.stringify({ success: false, error: 'activation rejected' }),
      );
    }
    await failure;
    expect(f.globals.imManager.executeFeishuCapability).not.toHaveBeenCalled();
    expect(
      fs
        .readdirSync(f.tasksDir)
        .filter((name) => !name.includes('_result_'))
        .every(
          (name) =>
            JSON.parse(fs.readFileSync(path.join(f.tasksDir, name), 'utf8'))
              .type === 'activate_channel_turn',
        ),
    ).toBe(true);
  },
);

test('a provider tool failure stays retryable without changing input ownership', async () => {
  const f = await fixture();
  const r = runner(f);
  r.activate('cold-a');
  await f.flushRequest('activate_channel_turn');
  await r.ctx.channelTurnActivation!.ready;
  const tool = r.tools.find(
    (candidate) => candidate.name === 'feishu_get_chat',
  )!;
  f.globals.imManager.executeFeishuCapability.mockRejectedValueOnce(
    new Error('provider unavailable'),
  );
  const failed = tool.handler({}, {} as never);
  const rejection = expect(failed).rejects.toThrow('provider unavailable');
  await f.flushRequest('feishu_capability');
  await rejection;
  expect(f.registry.require(f.scope, 'cold-a').context).toEqual(f.cold);
  const retry = tool.handler({}, {} as never);
  await f.flushRequest('feishu_capability');
  await expect(retry).resolves.toMatchObject({
    content: [
      expect.objectContaining({ text: expect.stringContaining('warm-chat') }),
    ],
  });
});

test.each(['query', 'runner', 'unadmitted'] as const)(
  'rejects a signed activation for the wrong %s',
  async (kind) => {
    const f = await fixture();
    fs.mkdirSync(f.tasksDir, { recursive: true });
    if (kind === 'runner')
      issueWorkspaceMemoryWriteCapability(f.capabilityScope, 'cold-a');
    const request: Record<string, unknown> = {
      type: 'activate_channel_turn',
      requestId: `wrong-${kind}`,
      inputTurnId: kind === 'unadmitted' ? 'unknown-input' : 'cold-a',
      queryRunId:
        kind === 'query'
          ? 'old-query'
          : f.queue.getActiveQueryId('web:review#agent:agent1'),
      runnerInstanceId: f.auth.runnerInstanceId,
      activationSequence: 1,
    };
    request.mutationSignature = signWorkspaceMemoryMutation(
      f.auth.signingSecret,
      f.capabilityScope,
      request,
    );
    await f.dispatch(request);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            f.tasksDir,
            `activate_channel_turn_result_wrong-${kind}.json`,
          ),
          'utf8',
        ),
      ).success,
    ).toBe(false);
    expect(f.registry.require(f.scope, 'cold-a').context).toEqual(f.cold);
  },
);

test('proactive send_message before text uses B admitted outbox before the Feishu activation ACK', async () => {
  const f = await fixture();
  f.trigger();
  const [payload] = f.payloads();
  const r = runner(f);
  r.ctx.interactionMode = 'proactive';
  r.tracker.acceptTurn([payload]);
  r.tracker.completeNextTurn();
  r.activate();
  const send = createMcpTools(r.ctx).find(
    (candidate) => candidate.name === 'send_message',
  )!;
  const pending = send.handler(
    { text: 'B final', delivery_role: 'final' },
    {} as never,
  );
  const messageDir = path.join(path.dirname(f.input), 'messages');
  const [filename] = fs.readdirSync(messageDir);
  const request = JSON.parse(
    fs.readFileSync(path.join(messageDir, filename), 'utf8'),
  );
  expect(request).toMatchObject({
    inputTurnId: payload.receipt.deliveryId,
    chatJid: f.warm.sourceJid,
    interactionMode: 'proactive',
    deliveryRole: 'final',
  });
  expect(f.registry.require(f.scope, 'cold-a').context).toEqual(f.cold);
  const sourceJid = f.globals.resolveImRoute({
    ipcAgentId: 'agent1',
    isHome: false,
    chatJid: request.chatJid,
    sourceGroup: 'review',
    inputTurnId: request.inputTurnId,
  });
  expect(sourceJid).toBe(f.warm.sourceJid);
  expect(
    f.outbox.resolveInput(f.scope, request.inputTurnId, sourceJid),
  ).toMatchObject({
    inputTurnId: payload.receipt.deliveryId,
    sourceJid: f.warm.sourceJid,
  });
  const resultDir = path.join(path.dirname(f.input), 'message-results');
  fs.mkdirSync(resultDir, { recursive: true });
  writeExclusiveIpcResult(
    resultDir,
    path.join(resultDir, `send_message_result_${request.requestId}.json`),
    JSON.stringify({ success: true }),
  );
  await expect(pending).resolves.toBeDefined();
  await f.flushRequest('activate_channel_turn');
  await r.ctx.channelTurnActivation!.ready;
});

test('normal Web runner activation emits no channel IPC', async () => {
  const f = await fixture();
  const r = runner(f);
  const ctx: McpContext = {
    ...r.ctx,
    channelContext: normalizeChannelTurnContext(undefined, 'web:review'),
  };
  activateMcpChannelTurn(ctx);
  await ctx.channelTurnActivation!.ready;
  expect(fs.existsSync(f.tasksDir)).toBe(false);
});

test('Feishu to Web clears ownership and rejects a delayed B activation', async () => {
  const f = await fixture();
  const r = runner(f);
  r.activate('cold-a');
  await f.flushRequest('activate_channel_turn', 'cold-a');
  await r.ctx.channelTurnActivation!.ready;
  f.trigger();
  const [b] = f.payloads();
  r.tracker.acceptTurn([b]);
  r.tracker.completeNextTurn();
  r.activate();
  const bActivation = r.ctx.channelTurnActivation!;
  const web = normalizeChannelTurnContext(undefined, 'web:review')!;
  f.globals.getMessageChannelTurnContext = (_jid: string, id: string) =>
    id === 'web-c' ? web : f.warm;
  const cursor = { id: 'web-c', timestamp: '2026-10-07T00:00:01.000Z' };
  const result = f.queue.sendMessage(
    f.jid,
    'Web C',
    undefined,
    (receipt) => {
      if (receipt)
        grantWorkspaceMemoryTurnToCurrentRunner(
          f.capabilityScope,
          receipt.deliveryId,
        );
    },
    'web:review',
    { chatJid: f.jid, cursor, coveredCursors: [cursor] },
    web,
    (receipt) =>
      f.globals.invokeActiveRouteAdmission(
        'review',
        'web:review',
        receipt,
        f.agentId ?? undefined,
      ),
    { feishuCliAccountId: 'account-a', interactionMode: 'assistant' },
  );
  expect(result).toBe('sent');
  const c = f
    .payloads()
    .find((payload) => payload.receipt.cursor.id === 'web-c');
  r.tracker.acceptTurn([c]);
  r.tracker.completeNextTurn();
  r.activate();
  await f.flushRequest('activate_channel_turn', c.receipt.deliveryId);
  await r.ctx.channelTurnActivation!.ready;
  expect(() => f.registry.require(f.scope, 'cold-a')).toThrow(/active input/);
  expect(() => f.registry.require(f.scope, c.receipt.deliveryId)).toThrow(
    /not a Feishu/,
  );
  const rejected = expect(bActivation.ready).rejects.toThrow(/superseded/);
  await f.flushRequest('activate_channel_turn', b.receipt.deliveryId);
  await rejected;
  expect(() => f.registry.require(f.scope, b.receipt.deliveryId)).toThrow(
    /active input/,
  );
  activateMcpChannelTurn(r.ctx); // Another normal Web activation has no IPC.
  await r.ctx.channelTurnActivation!.ready;
  expect(fs.readdirSync(f.tasksDir)).toEqual([]);
});

test('A tool awaiting activation cannot publish after B becomes current', async () => {
  const f = await fixture();
  const r = runner(f);
  r.activate('cold-a');
  const getChat = r.tools.find((tool) => tool.name === 'feishu_get_chat')!;
  const pending = getChat.handler({}, {} as never);
  const rejected = expect(pending).rejects.toThrow(
    /superseded during activation/,
  );
  f.trigger();
  const [b] = f.payloads();
  r.tracker.acceptTurn([b]);
  r.tracker.completeNextTurn();
  r.activate();
  await f.flushRequest('activate_channel_turn', 'cold-a');
  await rejected;
  expect(f.globals.imManager.executeFeishuCapability).not.toHaveBeenCalled();
  await f.flushRequest('activate_channel_turn', b.receipt.deliveryId);
  await r.ctx.channelTurnActivation!.ready;
  expect(fs.readdirSync(f.tasksDir)).toEqual([]);
});
