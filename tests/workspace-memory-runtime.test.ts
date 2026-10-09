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
import {
  createSerializedAsyncTrigger,
  loadWorkspaceMemoryTurnContext,
} from '../container/agent-runner/src/workspace-memory-context.js';
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
    isScheduledTask: false,
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
          text: expect.stringContaining('"storeRevision": 1'),
        },
      ],
    });
    revokeWorkspaceMemoryWriteCapability(scope, capability.runnerInstanceId);
  });

  test('scheduled/group-task MCP surfaces are read-only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-memory-ro-'));
    roots.push(root);
    for (const ctx of [
      context(root, { isScheduledTask: true }),
      context(root, { currentTaskId: 'task-1' }),
    ]) {
      const names = createMcpTools(ctx).map((tool) => tool.name);
      expect(names).toContain('workspace_memory_search');
      expect(names).not.toContain('workspace_memory_remember');
      expect(names).not.toContain('workspace_memory_update');
      expect(names).not.toContain('workspace_memory_forget');
    }
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
    expect(tools.get('list_tasks')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get('list_tasks')?._meta).toBeUndefined();
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

  test('host allows ordinary conversation sessions and rejects scheduled, spawn, task, and unknown turns', () => {
    expect(
      workspaceMemoryWriteRejection({
        operation: 'create',
        hostTurnKind: 'interactive',
        runtimeAgentId: 'conversation-1',
        runtimeAgentKind: 'conversation',
        capabilityValid: true,
      }),
    ).toBeNull();
    expect(
      workspaceMemoryWriteRejection({
        operation: 'create',
        hostTurnKind: 'scheduled',
        runtimeAgentId: null,
        runtimeAgentKind: null,
        capabilityValid: true,
      }),
    ).toMatchObject({ code: 'scheduled_memory_read_only' });
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
        hostTurnKind: 'scheduled',
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

  test('warm turn fetches a fresh B snapshot and never reuses A snapshot', async () => {
    const seenQueries: string[] = [];
    const fetchSnapshot = async (
      query: string,
    ): Promise<WorkspaceMemorySnapshot> => {
      seenQueries.push(query);
      return {
        workspaceJid: 'web:workspace',
        storeRevision: seenQueries.length,
        items: [],
        renderedText: `memory-for-${query}`,
        retrievalTrace: {
          itemRevisions: [
            { id: `memory-${query}`, revision: seenQueries.length },
          ],
          query,
          generatedAt: '2026-07-28T00:00:00.000Z',
        },
      };
    };

    const initial = await loadWorkspaceMemoryTurnContext('A', fetchSnapshot);
    const warm = await loadWorkspaceMemoryTurnContext('B', fetchSnapshot);
    expect(seenQueries).toEqual(['A', 'B']);
    expect(initial.block).toContain('memory-for-A');
    expect(warm.block).toContain('memory-for-B');
    expect(warm.block).not.toContain('memory-for-A');
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
  });
});
