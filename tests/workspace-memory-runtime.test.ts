import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createMcpTools,
  fetchWorkspaceMemorySnapshot,
  type McpContext,
  type WorkspaceMemorySnapshot,
} from '../container/agent-runner/src/mcp-tools.js';
import { createSerializedAsyncTrigger } from '../container/agent-runner/src/workspace-memory-context.js';
import { TurnNoteLedger } from '../container/agent-runner/src/turn-notes.js';
import { signWorkspaceMemoryMutation } from '../container/agent-runner/src/workspace-memory-auth.js';
import {
  createWorkspaceMemoryWriteGuard,
  WORKSPACE_MEMORY_WRITE_GUARD_MATCHER,
} from '../container/agent-runner/src/workspace-memory-runtime.js';
import {
  grantWorkspaceMemoryTurnToCurrentRunner,
  issueWorkspaceMemoryWriteCapability,
  revokeWorkspaceMemoryWriteCapability,
  verifyAndConsumeWorkspaceMemoryMutation,
  type WorkspaceMemoryCapabilityScope,
} from '../src/workspace-memory-capability.js';
import {
  buildWorkspaceMemoryUpdateInput,
  isWorkspaceMemoryOwnerTurn,
  workspaceMemoryWriteRejection,
} from '../src/workspace-memory-ipc.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function context(root: string, patch: Partial<McpContext> = {}): McpContext {
  return {
    chatJid: 'web:workspace',
    groupFolder: 'workspace-folder',
    isHome: false,
    isAdminHome: false,
    agentBuilderEnabled: false,
    currentInputTurnId: 'turn-1',
    currentSessionId: 'session-1',
    workspaceIpc: root,
    workspaceGroup: root,
    ...patch,
  };
}

async function readMemoryRequest(
  root: string,
): Promise<Record<string, unknown>> {
  const tasksDir = path.join(root, 'tasks');
  await vi.waitFor(() => {
    expect(fs.existsSync(tasksDir)).toBe(true);
    expect(
      fs
        .readdirSync(tasksDir)
        .filter((name) => !name.startsWith('workspace_memory_result_')),
    ).toHaveLength(1);
  });
  const requestFile = fs
    .readdirSync(tasksDir)
    .find((name) => !name.startsWith('workspace_memory_result_'))!;
  return JSON.parse(
    fs.readFileSync(path.join(tasksDir, requestFile), 'utf8'),
  ) as Record<string, unknown>;
}

function acknowledge(
  root: string,
  requestId: string,
  payload: Record<string, unknown>,
): void {
  fs.writeFileSync(
    path.join(root, 'tasks', `workspace_memory_result_${requestId}.json`),
    JSON.stringify({ success: true, ...payload }),
  );
}

describe('Workspace Memory runtime boundary', () => {
  test('top-level MCP mutation carries a valid HMAC without exposing its signing secret', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workspace-memory-mcp-'),
    );
    roots.push(root);
    const scope = { groupFolder: 'workspace-folder' };
    const capability = issueWorkspaceMemoryWriteCapability(scope, 'turn-1');
    const remember = createMcpTools(
      context(root, {
        workspaceMemoryMutationAuth: {
          runnerInstanceId: capability.runnerInstanceId,
          secret: capability.signingSecret,
        },
      }),
    ).find((tool) => tool.name === 'workspace_memory_remember');
    expect(remember).toBeDefined();

    const pending = remember!.handler(
      {
        kind: 'decision',
        title: 'Use SQLite',
        content: 'SQLite is the canonical workspace memory store.',
      },
      {} as never,
    );
    const request = await readMemoryRequest(root);
    expect(request).toMatchObject({
      type: 'workspace_memory',
      operation: 'create',
      kind: 'decision',
      title: 'Use SQLite',
      sessionId: 'session-1',
      inputTurnId: 'turn-1',
      runnerInstanceId: capability.runnerInstanceId,
    });
    expect(request.mutationSignature).toEqual(expect.any(String));
    expect(request).not.toHaveProperty('workspaceMemoryMutationSigningSecret');
    expect(request).not.toHaveProperty('secret');
    for (const forbidden of [
      'actor',
      'owner',
      'ownerId',
      'workspace',
      'workspaceJid',
      'path',
      'sourceType',
      'provenance',
    ]) {
      expect(request).not.toHaveProperty(forbidden);
    }
    expect(
      verifyAndConsumeWorkspaceMemoryMutation(
        scope,
        request,
        request.mutationSignature,
      ),
    ).toBe(true);

    acknowledge(root, request.requestId as string, {
      storeRevision: 1,
      item: { id: 'mem-1', revision: 1 },
    });
    const response = await pending;
    expect(response).not.toHaveProperty('isError');
    expect(response).toMatchObject({
      content: [
        {
          type: 'text',
          text: expect.stringContaining('"storeRevision":1'),
        },
      ],
    });
    revokeWorkspaceMemoryWriteCapability(scope, capability.runnerInstanceId);
  });

  test('the PreToolUse matcher selects exactly the tools the guard can deny', () => {
    const matcher = new RegExp(WORKSPACE_MEMORY_WRITE_GUARD_MATCHER);
    for (const name of [
      'mcp__happyclaw__workspace_memory_remember',
      'mcp__happyclaw__workspace_memory_update',
      'mcp__happyclaw__workspace_memory_forget',
      'mcp__happyclaw__happyclaw_owner_profile',
    ]) {
      expect(matcher.test(name)).toBe(true);
    }
    for (const name of [
      'Bash',
      'mcp__happyclaw__workspace_memory_search',
      'mcp__happyclaw__workspace_memory_get',
      'mcp__happyclaw__workspace_memory_update_extra',
      'mcp__other__workspace_memory_update',
    ]) {
      expect(matcher.test(name)).toBe(false);
    }
  });

  test('marks read-only and always-loaded HappyClaw tools for Claude Code', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workspace-tool-hints-'),
    );
    roots.push(root);
    const tools = new Map(
      createMcpTools(context(root)).map((tool) => [tool.name, tool]),
    );
    expect(tools.get('get_channel_context')).toMatchObject({
      annotations: { readOnlyHint: true },
      _meta: { 'anthropic/alwaysLoad': true },
    });
    expect(tools.get('workspace_memory_search')).toMatchObject({
      annotations: { readOnlyHint: true },
      _meta: { 'anthropic/alwaysLoad': true },
    });
    expect(tools.get('send_message')?._meta).toEqual({
      'anthropic/alwaysLoad': true,
    });
    expect(
      tools.get('send_message')?.annotations?.readOnlyHint,
    ).toBeUndefined();
    expect(tools.get('automation_list')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get('automation_list')?._meta).toBeUndefined();
    expect(
      tools.get('workspace_memory_remember')?.annotations?.readOnlyHint,
    ).toBeUndefined();
  });

  test('SDK sub-agent write calls are denied while top-level calls pass', async () => {
    const guard = createWorkspaceMemoryWriteGuard();
    const base = {
      hook_event_name: 'PreToolUse',
      session_id: 's',
      transcript_path: '/tmp/t',
      cwd: '/tmp',
      tool_name: 'mcp__happyclaw__workspace_memory_update',
      tool_input: {},
      tool_use_id: 'tool-1',
    } as const;
    const denied = await guard(
      { ...base, agent_id: 'sdk-subagent-1' } as never,
      'tool-1',
      { signal: new AbortController().signal },
    );
    expect(denied).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
    await expect(
      guard(base as never, 'tool-1', {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({});
  });

  test('host admits conversation sessions and automation runs, and rejects spawn, task, and unknown turns', () => {
    expect(
      workspaceMemoryWriteRejection({
        operation: 'create',
        hostTurnKind: 'interactive',
        runtimeAgentId: 'conversation-1',
        runtimeAgentKind: 'conversation',
        capabilityValid: true,
      }),
    ).toBeNull();
    // An automation run writes only proposals (workspaceMemoryWriteMode), and
    // only with the runner's signed capability.
    expect(
      workspaceMemoryWriteRejection({
        operation: 'create',
        hostTurnKind: 'automation',
        runtimeAgentId: null,
        runtimeAgentKind: null,
        capabilityValid: true,
      }),
    ).toBeNull();
    expect(
      workspaceMemoryWriteRejection({
        operation: 'create',
        hostTurnKind: 'automation',
        runtimeAgentId: null,
        runtimeAgentKind: null,
        capabilityValid: false,
      }),
    ).toMatchObject({ code: 'workspace_memory_invalid_capability' });
    for (const runtimeAgentKind of ['spawn', 'task'] as const) {
      expect(
        workspaceMemoryWriteRejection({
          operation: 'delete',
          hostTurnKind: 'interactive',
          runtimeAgentId: 'agent-1',
          runtimeAgentKind,
          capabilityValid: true,
        }),
      ).toMatchObject({ code: 'runtime_agent_memory_read_only' });
    }
    expect(
      workspaceMemoryWriteRejection({
        operation: 'update',
        hostTurnKind: 'unknown',
        runtimeAgentId: null,
        runtimeAgentKind: null,
        capabilityValid: true,
      }),
    ).toMatchObject({ code: 'workspace_memory_no_active_turn' });
    expect(
      workspaceMemoryWriteRejection({
        operation: 'create',
        hostTurnKind: 'interactive',
        runtimeAgentId: null,
        runtimeAgentKind: null,
        capabilityValid: false,
      }),
    ).toMatchObject({ code: 'workspace_memory_invalid_capability' });
    expect(
      workspaceMemoryWriteRejection({
        operation: 'search',
        hostTurnKind: 'automation',
        runtimeAgentId: 'agent-1',
        runtimeAgentKind: 'task',
        capabilityValid: false,
      }),
    ).toBeNull();
  });

  test('conversation namespace verifies signed writes while spawn/task runtimes remain read-only', () => {
    const scope = {
      groupFolder: 'workspace-folder',
      agentId: 'conversation-1',
    };
    const capability = issueWorkspaceMemoryWriteCapability(
      scope,
      'turn-conversation-1',
    );
    const request: Record<string, unknown> = {
      type: 'workspace_memory',
      operation: 'create',
      requestId: 'request-conversation-1',
      idempotencyKey: 'idem-conversation-1',
      kind: 'fact',
      title: 'Shared session memory',
      content: 'Conversation runtime sessions share workspace memory.',
      inputTurnId: 'turn-conversation-1',
      taskId: undefined,
      runnerInstanceId: capability.runnerInstanceId,
    };
    request.mutationSignature = signWorkspaceMemoryMutation(
      capability.signingSecret,
      scope,
      request,
    );
    const capabilityValid = verifyAndConsumeWorkspaceMemoryMutation(
      scope,
      request,
      request.mutationSignature,
    );
    expect(capabilityValid).toBe(true);
    expect(
      workspaceMemoryWriteRejection({
        operation: 'create',
        hostTurnKind: 'interactive',
        runtimeAgentId: 'conversation-1',
        runtimeAgentKind: 'conversation',
        capabilityValid,
      }),
    ).toBeNull();
    for (const runtimeAgentKind of ['spawn', 'task'] as const) {
      expect(
        workspaceMemoryWriteRejection({
          operation: 'create',
          hostTurnKind: 'interactive',
          runtimeAgentId: `${runtimeAgentKind}-1`,
          runtimeAgentKind,
          capabilityValid: true,
        }),
      ).toMatchObject({ code: 'runtime_agent_memory_read_only' });
    }
    revokeWorkspaceMemoryWriteCapability(scope, capability.runnerInstanceId);
  });

  test('mutation HMAC fails closed when omitted, forged, payload-tampered, or replayed', () => {
    const scope: WorkspaceMemoryCapabilityScope = {
      groupFolder: 'workspace-folder',
    };
    const capability = issueWorkspaceMemoryWriteCapability(scope, 'turn-1');
    const request: Record<string, unknown> = {
      type: 'workspace_memory',
      operation: 'update',
      requestId: 'request-1',
      idempotencyKey: 'idem-1',
      itemId: 'memory-1',
      expectedRevision: 2,
      patch: { title: 'Approved' },
      inputTurnId: 'turn-1',
      taskId: null,
      runnerInstanceId: capability.runnerInstanceId,
    };
    const signature = signWorkspaceMemoryMutation(
      capability.signingSecret,
      scope,
      request,
    );
    request.mutationSignature = signature;

    expect(
      verifyAndConsumeWorkspaceMemoryMutation(scope, request, undefined),
    ).toBe(false);
    expect(
      verifyAndConsumeWorkspaceMemoryMutation(scope, request, 'A'.repeat(43)),
    ).toBe(false);
    for (const tampered of [
      { ...request, operation: 'delete' },
      { ...request, requestId: 'request-2' },
      { ...request, idempotencyKey: 'idem-2' },
      { ...request, inputTurnId: 'turn-2' },
      { ...request, taskId: 'task-2' },
      { ...request, patch: { title: 'Tampered' } },
    ]) {
      expect(
        verifyAndConsumeWorkspaceMemoryMutation(scope, tampered, signature),
      ).toBe(false);
    }
    expect(
      verifyAndConsumeWorkspaceMemoryMutation(scope, request, signature),
    ).toBe(true);
    expect(
      verifyAndConsumeWorkspaceMemoryMutation(scope, request, signature),
    ).toBe(false);
    revokeWorkspaceMemoryWriteCapability(scope, capability.runnerInstanceId);
  });

  test('old overlapping runner cannot forge the new active turn or revoke its capability', () => {
    const scope: WorkspaceMemoryCapabilityScope = {
      groupFolder: 'workspace-folder',
    };
    const oldRunner = issueWorkspaceMemoryWriteCapability(scope, 'turn-old');
    const currentRunner = issueWorkspaceMemoryWriteCapability(
      scope,
      'turn-current',
    );

    const signedRequest = (
      runner: typeof oldRunner,
      inputTurnId: string,
      requestId: string,
    ): Record<string, unknown> => {
      const request: Record<string, unknown> = {
        type: 'workspace_memory',
        operation: 'create',
        requestId,
        idempotencyKey: `idem-${requestId}`,
        kind: 'fact',
        title: 'Runner overlap',
        content: 'Only the current runner may write.',
        inputTurnId,
        runnerInstanceId: runner.runnerInstanceId,
      };
      request.mutationSignature = signWorkspaceMemoryMutation(
        runner.signingSecret,
        scope,
        request,
      );
      return request;
    };

    const forgedByOld = signedRequest(
      oldRunner,
      'turn-current',
      'request-old-forged',
    );
    expect(
      verifyAndConsumeWorkspaceMemoryMutation(
        scope,
        forgedByOld,
        forgedByOld.mutationSignature,
      ),
    ).toBe(false);

    const currentCold = signedRequest(
      currentRunner,
      'turn-current',
      'request-current-cold',
    );
    expect(
      verifyAndConsumeWorkspaceMemoryMutation(
        scope,
        currentCold,
        currentCold.mutationSignature,
      ),
    ).toBe(true);

    revokeWorkspaceMemoryWriteCapability(scope, oldRunner.runnerInstanceId);
    const currentAfterOldFinally = signedRequest(
      currentRunner,
      'turn-current',
      'request-current-after-old-finally',
    );
    expect(
      verifyAndConsumeWorkspaceMemoryMutation(
        scope,
        currentAfterOldFinally,
        currentAfterOldFinally.mutationSignature,
      ),
    ).toBe(true);
    revokeWorkspaceMemoryWriteCapability(scope, currentRunner.runnerInstanceId);
  });

  test('current runner accepts admitted cold and warm turns but rejects an ungranted turn', () => {
    const scope: WorkspaceMemoryCapabilityScope = {
      groupFolder: 'workspace-folder',
    };
    const runner = issueWorkspaceMemoryWriteCapability(scope, 'turn-cold');
    expect(grantWorkspaceMemoryTurnToCurrentRunner(scope, 'turn-warm')).toBe(
      true,
    );

    const verifyTurn = (inputTurnId: string, requestId: string): boolean => {
      const request: Record<string, unknown> = {
        type: 'workspace_memory',
        operation: 'delete',
        requestId,
        idempotencyKey: `idem-${requestId}`,
        itemId: 'memory-1',
        expectedRevision: 1,
        inputTurnId,
        runnerInstanceId: runner.runnerInstanceId,
      };
      const signature = signWorkspaceMemoryMutation(
        runner.signingSecret,
        scope,
        request,
      );
      request.mutationSignature = signature;
      return verifyAndConsumeWorkspaceMemoryMutation(scope, request, signature);
    };

    expect(verifyTurn('turn-cold', 'request-cold')).toBe(true);
    expect(verifyTurn('turn-warm', 'request-warm')).toBe(true);
    expect(verifyTurn('turn-ungranted', 'request-ungranted')).toBe(false);
    revokeWorkspaceMemoryWriteCapability(scope, runner.runnerInstanceId);
  });

  test('malformed snapshot result fails open without injecting memory', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workspace-memory-snapshot-'),
    );
    roots.push(root);
    const pending = fetchWorkspaceMemorySnapshot(context(root), 'query B', {
      timeoutMs: 2_000,
    });
    const request = await readMemoryRequest(root);
    expect(request).not.toHaveProperty('mutationSignature');
    acknowledge(root, request.requestId as string, {
      snapshot: {
        workspaceJid: 'web:workspace',
        storeRevision: Number.NaN,
        items: [],
        renderedText: 'malformed',
        retrievalTrace: {
          itemRevisions: [],
          generatedAt: '2026-07-28T00:00:00.000Z',
        },
      },
    });
    await expect(pending).resolves.toBeNull();
  });

  test('a snapshot asks for the changes since the revision the session holds', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workspace-memory-snapshot-'),
    );
    roots.push(root);
    const pending = fetchWorkspaceMemorySnapshot(context(root), 'query C', {
      timeoutMs: 2_000,
      changedSince: 4,
      heldIds: ['gone', 'kept'],
    });
    const request = await readMemoryRequest(root);
    expect(request).toMatchObject({
      operation: 'snapshot',
      changedSince: 4,
      heldIds: ['gone', 'kept'],
    });
    const base = {
      workspaceJid: 'web:workspace',
      storeRevision: 6,
      items: [],
      renderedText: '',
      retrievalTrace: {
        itemRevisions: [],
        generatedAt: '2026-07-28T00:00:00.000Z',
      },
    };
    acknowledge(root, request.requestId as string, {
      snapshot: {
        ...base,
        changes: {
          reset: false,
          items: [{ id: 'gone', revision: 2, status: 'deleted' }],
        },
      },
    });
    await expect(pending).resolves.toMatchObject({
      changes: {
        reset: false,
        items: [{ id: 'gone', revision: 2, status: 'deleted' }],
      },
    });

    // Malformed changes are dropped; the snapshot itself still holds.
    const other = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workspace-memory-snapshot-'),
    );
    roots.push(other);
    const next = fetchWorkspaceMemorySnapshot(context(other), 'query D', {
      timeoutMs: 2_000,
    });
    const second = await readMemoryRequest(other);
    expect(second).not.toHaveProperty('changedSince');
    expect(second).not.toHaveProperty('heldIds');
    acknowledge(other, second.requestId as string, {
      snapshot: { ...base, changes: { reset: 'no', items: [] } },
    });
    const parsed = await next;
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('changes');
  });

  test("a warm turn carries B's snapshot and never A's again", () => {
    const snapshot = (...ids: string[]): WorkspaceMemorySnapshot => ({
      workspaceJid: 'web:workspace',
      storeRevision: 3,
      items: ids.map((id) => ({
        id,
        revision: 1,
        kind: 'fact',
        content: `memory-for-${id}`,
      })),
      renderedText: ids
        .map((id) => `<memory id="${id}">memory-for-${id}</memory>`)
        .join('\n'),
      retrievalTrace: {
        itemRevisions: ids.map((id) => ({ id, revision: 1 })),
        generatedAt: '2026-07-28T00:00:00.000Z',
      },
    });
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    const turn = (uuid: string, memory: WorkspaceMemorySnapshot) => {
      const notes = ledger.stage(uuid, {
        memory,
        ownerProfile: null,
        channelContext: undefined,
      });
      ledger.observeAnswered([uuid]);
      ledger.commitAnswered();
      return notes.memory;
    };

    expect(turn('cold', snapshot('A'))).toContain('memory-for-A');
    // Retrieved again for B's query, A is already in the conversation.
    const warm = turn('warm', snapshot('A', 'B'));
    expect(warm).toContain('memory-for-B');
    expect(warm).not.toContain('memory-for-A');
    expect(turn('again', snapshot('A', 'B'))).toBe('');
  });

  test('async warm-turn drains are serialized in trigger order', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    const onError = vi.fn();
    const trigger = createSerializedAsyncTrigger(async () => {
      call += 1;
      const current = call;
      events.push(`start-${current}`);
      if (current === 1) await firstBlocked;
      events.push(`end-${current}`);
    }, onError);

    trigger();
    trigger();
    await vi.waitFor(() => expect(events).toEqual(['start-1']));
    releaseFirst();
    await vi.waitFor(() =>
      expect(events).toEqual(['start-1', 'end-1', 'start-2', 'end-2']),
    );
    expect(onError).not.toHaveBeenCalled();
  });

  test('untrusted update patch cannot override the host principal', () => {
    const principal = {
      actor: { id: 'owner-1', role: 'member' as const },
      workspaceJid: 'web:workspace-1',
      sourceType: 'agent_runtime' as const,
      provenance: { sourceId: 'turn-1', sessionId: 'session-1' },
    };
    const built = buildWorkspaceMemoryUpdateInput(
      {
        itemId: 'mem-1',
        expectedRevision: 2,
        patch: {
          title: 'corrected',
          actor: { id: 'attacker', role: 'admin' },
          workspaceJid: 'web:victim',
          sourceType: 'web_user',
          provenance: { sourceId: 'forged' },
        },
      },
      principal,
    );
    expect(built).toMatchObject({
      title: 'corrected',
      actor: principal.actor,
      workspaceJid: principal.workspaceJid,
      sourceType: principal.sourceType,
      provenance: principal.provenance,
    });
    expect(built).not.toHaveProperty('patch');
    expect(built).toMatchObject({ proposal: false });
    expect(
      buildWorkspaceMemoryUpdateInput(
        { itemId: 'mem-1', patch: { proposal: false } },
        { ...principal, proposal: true },
      ),
    ).toMatchObject({ proposal: true });
  });

  test("a snapshot is asked for by the senders' words and brings the index", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workspace-memory-snapshot-'),
    );
    roots.push(root);
    const pending = fetchWorkspaceMemorySnapshot(
      context(root),
      '<system_context>\nold</system_context>\n\n<messages>\n<message id="m1" sender="Alice" time="t">\nMac mini 怎么部署 &amp; 回滚</message>\n</messages>',
      { timeoutMs: 2_000 },
    );
    const request = await readMemoryRequest(root);
    expect(request.query).toBe('Mac mini 怎么部署 & 回滚');
    const base = {
      workspaceJid: 'web:workspace',
      storeRevision: 6,
      items: [],
      renderedText: '',
      retrievalTrace: {
        itemRevisions: [],
        generatedAt: '2026-07-28T00:00:00.000Z',
      },
    };
    acknowledge(root, request.requestId as string, {
      snapshot: {
        ...base,
        directory: {
          entries: [{ id: 'wmi_a', kind: 'fact', title: 'Deploy', extra: 1 }],
          total: 3,
        },
      },
    });
    await expect(pending).resolves.toMatchObject({
      directory: {
        entries: [{ id: 'wmi_a', kind: 'fact', title: 'Deploy' }],
        total: 3,
      },
    });

    const other = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workspace-memory-snapshot-'),
    );
    roots.push(other);
    const next = fetchWorkspaceMemorySnapshot(context(other), 'plain', {
      timeoutMs: 2_000,
    });
    const second = await readMemoryRequest(other);
    acknowledge(other, second.requestId as string, {
      snapshot: { ...base, directory: { entries: [{ id: 1 }], total: 1 } },
    });
    const parsed = await next;
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('directory');
  });

  test('a write result names the item, and a proposal says it waits for the owner', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workspace-memory-mcp-'),
    );
    roots.push(root);
    const tools = new Map(
      createMcpTools(context(root)).map((tool) => [tool.name, tool]),
    );
    const pending = tools
      .get('workspace_memory_remember')!
      .handler(
        { kind: 'lesson', title: 'Back up first', content: 'Long content.' },
        {} as never,
      );
    const request = await readMemoryRequest(root);
    acknowledge(root, request.requestId as string, {
      storeRevision: 9,
      item: {
        id: 'wmi_1',
        revision: 1,
        kind: 'lesson',
        title: 'Back up first',
        content: 'Long content.',
        status: 'proposed',
      },
      replayed: false,
    });
    const response = (await pending) as {
      content: Array<{ text: string }>;
    };
    const text = response.content[0].text;
    expect(
      text.startsWith(
        '{"result":"proposed","id":"wmi_1","title":"Back up first"',
      ),
    ).toBe(true);
    expect(JSON.parse(text)).toEqual({
      result: 'proposed',
      id: 'wmi_1',
      title: 'Back up first',
      revision: 1,
      kind: 'lesson',
      storeRevision: 9,
      note: "Submitted, awaiting the workspace owner's confirmation on the Memory page; it is not recalled until confirmed.",
    });
    expect(text).not.toContain('Long content.');
  });

  test("only a batch of the owner's own messages is the owner's turn", () => {
    const registrations: Record<
      string,
      { created_by?: string; owner_im_id?: string; owner_claim_source?: string }
    > = {
      'web:ws': { created_by: 'owner-1' },
      'feishu:oc_group': {
        created_by: 'owner-1',
        owner_im_id: 'ou_owner',
        owner_claim_source: 'auto_feishu',
      },
      'feishu:oc_claimed': {
        created_by: 'owner-1',
        owner_im_id: 'ou_claimer',
        owner_claim_source: 'explicit',
      },
    };
    const lookup = {
      ownerUserId: 'owner-1',
      registration: (jid: string) => registrations[jid],
      ownerRegistrations: () =>
        Object.entries(registrations).map(([jid, row]) => ({ jid, ...row })),
    };
    const turnOf =
      (...inputs: Array<{ sender: string; source_jid: string }>) =>
      (isOwnerInput: (input: never) => boolean) => {
        for (const input of inputs) {
          if (!isOwnerInput({ ...input, is_from_me: 0 } as never)) {
            throw new Error('not the owner');
          }
        }
      };
    const ownerTurn = (requireActiveOwnerTurn: ReturnType<typeof turnOf>) =>
      isWorkspaceMemoryOwnerTurn({ ...lookup, requireActiveOwnerTurn });
    expect(ownerTurn(turnOf({ sender: 'owner-1', source_jid: 'web:ws' }))).toBe(
      true,
    );
    expect(
      ownerTurn(turnOf({ sender: 'ou_owner', source_jid: 'feishu:oc_group' })),
    ).toBe(true);
    expect(
      ownerTurn(
        turnOf(
          { sender: 'ou_owner', source_jid: 'feishu:oc_group' },
          { sender: 'ou_member', source_jid: 'feishu:oc_group' },
        ),
      ),
    ).toBe(false);
    expect(
      ownerTurn(
        turnOf({ sender: 'ou_claimer', source_jid: 'feishu:oc_claimed' }),
      ),
    ).toBe(false);
    expect(
      ownerTurn(() => {
        throw new Error('automation or non-human');
      }),
    ).toBe(false);
  });
});
