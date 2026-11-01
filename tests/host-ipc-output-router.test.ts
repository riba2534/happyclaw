import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { channelTurnScope } from '../src/channel-turn-registry.js';
import {
  NATIVE_ROUTE_UNAVAILABLE_ERROR,
  resolveHostIpcLogicalChatJid,
  routeHostIpcOutput,
} from '../src/host-ipc-output-router.js';
import { ActiveTurnOutputRegistry } from '../src/turn-output-coordinator.js';
import { hasUnfinishedProactiveOutput } from '../src/turn-outcome.js';

describe('host IPC primary output routing', () => {
  test('projects conversation-agent output into its canonical Web session', () => {
    expect(
      resolveHostIpcLogicalChatJid({
        sourceChatJid: 'feishu:oc_chat#thread:omt_topic#root:om_root',
        agentId: 'conversation-agent',
        agentChatJid: 'web:main',
      }),
    ).toBe('web:main#agent:conversation-agent');
  });

  test('attributes a bound IM chat output to its workspace, not the IM row', () => {
    // The runner reports channelContext.sourceJid, so without the fold this
    // reply would be stored under the IM row whose folder/created_by still
    // belong to the channel account owner.
    const resolveWorkspaceJid = (chatJid: string) =>
      chatJid === 'qq:c2c:CHAT_A' ? 'web:ws-b' : null;

    expect(
      resolveHostIpcLogicalChatJid({
        sourceChatJid: 'qq:c2c:CHAT_A',
        resolveWorkspaceJid,
      }),
    ).toBe('web:ws-b');
    // An explicit agent JID still wins over the folded source.
    expect(
      resolveHostIpcLogicalChatJid({
        sourceChatJid: 'qq:c2c:CHAT_A',
        agentId: 'agent-1',
        agentChatJid: 'web:ws-c',
        resolveWorkspaceJid,
      }),
    ).toBe('web:ws-c#agent:agent-1');
  });

  test('keeps the raw source JID when the chat has no workspace binding', () => {
    expect(
      resolveHostIpcLogicalChatJid({
        sourceChatJid: 'qq:c2c:CHAT_UNBOUND',
        resolveWorkspaceJid: () => null,
      }),
    ).toBe('qq:c2c:CHAT_UNBOUND');
    // No resolver injected at all (legacy call sites) must not change.
    expect(
      resolveHostIpcLogicalChatJid({
        sourceChatJid: 'qq:c2c:CHAT_UNBOUND',
      }),
    ).toBe('qq:c2c:CHAT_UNBOUND');
  });

  test('keeps delayed text and image output in the workspace frozen for the turn', () => {
    // The chat was admitted under ws-a, then rebound to ws-b while the model
    // was still working. Both IPC paths call this helper and must prefer the
    // immutable runtime scope over the output-time binding lookup.
    const reboundWorkspace = () => 'web:ws-b';
    const delayedTextJid = resolveHostIpcLogicalChatJid({
      sourceChatJid: 'qq:c2c:CHAT_A',
      runtimeChatJid: 'web:ws-a',
      resolveWorkspaceJid: reboundWorkspace,
    });
    const delayedImageJid = resolveHostIpcLogicalChatJid({
      sourceChatJid: 'qq:c2c:CHAT_A',
      runtimeChatJid: 'web:ws-a',
      resolveWorkspaceJid: reboundWorkspace,
    });

    expect(delayedTextJid).toBe('web:ws-a');
    expect(delayedImageJid).toBe('web:ws-a');
  });

  test('stages a custom-agent final in its exact scope without a separate provider send', async () => {
    const activeTurnOutputs = new ActiveTurnOutputRegistry();
    const projectedFinal = vi.fn(() => true);
    const sendImWithRetry = vi.fn(async () => true);
    const sourceGroup = 'research-workspace';
    const agentId = 'research-agent';
    activeTurnOutputs.bind(
      channelTurnScope(sourceGroup, agentId),
      'input-turn-7',
      {
        onProgress: () => true,
        onFinalCandidate: projectedFinal,
      },
    );

    const route = routeHostIpcOutput(
      {
        sourceGroup,
        agentId,
        inputTurnId: 'input-turn-7',
        text: '最终调研报告',
        deliveryRole: 'final',
        authorized: true,
      },
      activeTurnOutputs,
    );
    if (route.path === 'separate_provider') {
      await sendImWithRetry();
    }

    expect(route).toMatchObject({
      path: 'primary_projection',
      delivered: true,
      staged: true,
      disposition: 'staged_final',
      deliveryRole: 'final',
    });
    expect(projectedFinal).toHaveBeenCalledOnce();
    expect(projectedFinal).toHaveBeenCalledWith('最终调研报告');
    expect(sendImWithRetry).not.toHaveBeenCalled();
  });

  test('consumes a failed primary stage instead of falling through to a sibling message', async () => {
    const activeTurnOutputs = new ActiveTurnOutputRegistry();
    const sendImWithRetry = vi.fn(async () => true);

    const route = routeHostIpcOutput(
      {
        sourceGroup: 'research-workspace',
        agentId: 'research-agent',
        inputTurnId: 'inactive-turn',
        text: '迟到的答案',
        deliveryRole: 'final',
        authorized: true,
      },
      activeTurnOutputs,
    );
    if (route.path === 'separate_provider') {
      await sendImWithRetry();
    }

    expect(route).toMatchObject({
      path: 'primary_projection',
      delivered: false,
      staged: false,
      stageResult: {
        accepted: false,
        reason: 'inactive_turn',
      },
    });
    expect(sendImWithRetry).not.toHaveBeenCalled();
  });

  test('keeps explicitly separate output on the provider lane', () => {
    const activeTurnOutputs = new ActiveTurnOutputRegistry();

    expect(
      routeHostIpcOutput(
        {
          sourceGroup: 'workspace',
          inputTurnId: 'turn-1',
          text: '额外通知',
          deliveryRole: 'separate',
          authorized: true,
        },
        activeTurnOutputs,
      ).path,
    ).toBe('separate_provider');
  });

  test("proactive mode stages a Web turn's progress on the active turn and keeps final on independent message delivery", () => {
    const activeTurnOutputs = new ActiveTurnOutputRegistry();
    const projectedProgress = vi.fn(() => true);
    const projectedFinal = vi.fn(() => true);
    activeTurnOutputs.bind(
      channelTurnScope('workspace', 'conversation-agent'),
      'turn-1',
      {
        onProgress: projectedProgress,
        onFinalCandidate: projectedFinal,
      },
    );

    expect(
      routeHostIpcOutput(
        {
          sourceGroup: 'workspace',
          agentId: 'conversation-agent',
          inputTurnId: 'turn-1',
          text: 'progress utterance',
          deliveryRole: 'progress',
          authorized: true,
          interactionMode: 'proactive',
          turnSource: 'web',
        },
        activeTurnOutputs,
      ),
    ).toMatchObject({
      path: 'primary_projection',
      delivered: true,
      staged: true,
      disposition: 'staged_progress',
      deliveryRole: 'progress',
    });
    expect(projectedProgress).toHaveBeenCalledOnce();
    expect(projectedProgress).toHaveBeenCalledWith('progress utterance');

    expect(
      routeHostIpcOutput(
        {
          sourceGroup: 'workspace',
          agentId: 'conversation-agent',
          inputTurnId: 'turn-1',
          text: 'final utterance',
          deliveryRole: 'final',
          authorized: true,
          interactionMode: 'proactive',
          turnSource: 'web',
        },
        activeTurnOutputs,
      ),
    ).toMatchObject({
      path: 'separate_provider',
      staged: false,
      deliveryRole: 'final',
    });
    expect(projectedFinal).not.toHaveBeenCalled();
  });

  test('proactive progress of an IM turn is sent as a message of its own', () => {
    // A channel cannot fold a process: staging it there would leave the user
    // without a word until the final.
    const activeTurnOutputs = new ActiveTurnOutputRegistry();
    const projectedProgress = vi.fn(() => true);
    const scope = channelTurnScope('workspace');
    activeTurnOutputs.bind(scope, 'turn-im', {
      onProgress: projectedProgress,
      onFinalCandidate: () => true,
    });

    // An IM turn with its route, and a turn of unknown source (no inputTurnId,
    // or no bound turn), go the way they did on main.
    for (const [turnSource, inputTurnId] of [
      ['im', 'turn-im'],
      [undefined, 'turn-im'],
      [undefined, undefined],
    ] as const) {
      expect(
        routeHostIpcOutput(
          {
            sourceGroup: 'workspace',
            inputTurnId,
            text: '正在查看日志',
            deliveryRole: 'progress',
            authorized: true,
            interactionMode: 'proactive',
            turnSource,
            imRouteAvailable: true,
          },
          activeTurnOutputs,
        ),
      ).toEqual({
        path: 'separate_provider',
        delivered: false,
        staged: false,
        deliveryRole: 'progress',
        attemptedFinalRecorded: false,
      });
    }
    expect(projectedProgress).not.toHaveBeenCalled();
    // It is no final: the final lane is still open for the real answer.
    expect(activeTurnOutputs.get(scope, 'turn-im')?.attemptedFinalText).toBe(
      null,
    );
  });

  test('proactive progress of an IM turn whose route is gone fails closed', () => {
    // A recalled input, or an address without its account: the Agent is told
    // nothing was delivered, and nothing is staged for the Web instead.
    const activeTurnOutputs = new ActiveTurnOutputRegistry();
    const projectedProgress = vi.fn(() => true);
    activeTurnOutputs.bind(channelTurnScope('workspace'), 'turn-im', {
      source: 'im',
      onProgress: projectedProgress,
      onFinalCandidate: () => true,
    });
    expect(
      routeHostIpcOutput(
        {
          sourceGroup: 'workspace',
          inputTurnId: 'turn-im',
          text: '正在查看日志',
          deliveryRole: 'progress',
          authorized: true,
          interactionMode: 'proactive',
          turnSource: activeTurnOutputs.sourceOf(
            channelTurnScope('workspace'),
            'turn-im',
          ),
          imRouteAvailable: false,
        },
        activeTurnOutputs,
      ),
    ).toEqual({
      path: 'rejected',
      delivered: false,
      staged: false,
      deliveryRole: 'progress',
      reason: 'native_route_unavailable',
    });
    expect(projectedProgress).not.toHaveBeenCalled();
    // What the Agent is told: nothing went out, and trying again is no use,
    // for the final either (it takes the same route).
    expect(NATIVE_ROUTE_UNAVAILABLE_ERROR).toContain('Do not retry it.');
    expect(NATIVE_ROUTE_UNAVAILABLE_ERROR).toContain(
      'the final uses the same route, so if it fails as well, do not retry it either',
    );
  });

  test('the source a turn was bound with is the one routing reads', () => {
    const activeTurnOutputs = new ActiveTurnOutputRegistry();
    const scope = channelTurnScope('workspace', 'session');
    activeTurnOutputs.bind(scope, 'web-turn', {
      source: 'web',
      onProgress: () => true,
      onFinalCandidate: () => true,
    });
    activeTurnOutputs.bind(scope, 'im-turn', {
      source: 'im',
      onProgress: () => true,
      onFinalCandidate: () => true,
    });
    expect(activeTurnOutputs.sourceOf(scope, 'web-turn')).toBe('web');
    expect(activeTurnOutputs.sourceOf(scope, 'im-turn')).toBe('im');
    expect(activeTurnOutputs.sourceOf(scope, 'gone')).toBeUndefined();
    activeTurnOutputs.unbind(scope, 'im-turn');
    expect(activeTurnOutputs.sourceOf(scope, 'im-turn')).toBeUndefined();
  });

  test('an Assistant turn stages progress whatever its source', () => {
    const activeTurnOutputs = new ActiveTurnOutputRegistry();
    const projectedProgress = vi.fn(() => true);
    activeTurnOutputs.bind(channelTurnScope('workspace'), 'turn-a', {
      onProgress: projectedProgress,
      onFinalCandidate: () => true,
    });

    expect(
      routeHostIpcOutput(
        {
          sourceGroup: 'workspace',
          inputTurnId: 'turn-a',
          text: '正在处理',
          deliveryRole: 'progress',
          authorized: true,
          interactionMode: 'assistant',
          turnSource: 'im',
        },
        activeTurnOutputs,
      ),
    ).toMatchObject({ path: 'primary_projection', staged: true });
    expect(projectedProgress).toHaveBeenCalledOnce();
  });

  test('progress without a final never settles a proactive turn, by either lane', () => {
    // Staged (Web) and sent (IM) progress both count as non-terminal output, so
    // the host still refuses to settle the input until a final arrives.
    for (const turnSource of ['web', 'im'] as const) {
      const activeTurnOutputs = new ActiveTurnOutputRegistry();
      const scope = channelTurnScope('workspace');
      let nonTerminal = false;
      let final = false;
      activeTurnOutputs.bind(scope, 'turn-x', {
        onProgress: () => true,
        onFinalCandidate: () => true,
        onNonTerminalDelivered: () => {
          nonTerminal = true;
        },
        onUtteranceDelivered: () => {
          final = true;
        },
      });
      const route = routeHostIpcOutput(
        {
          sourceGroup: 'workspace',
          inputTurnId: 'turn-x',
          text: '先看一下',
          deliveryRole: 'progress',
          authorized: true,
          interactionMode: 'proactive',
          turnSource,
          imRouteAvailable: true,
        },
        activeTurnOutputs,
      );
      // The IPC watcher records a separately delivered message on its turn.
      if (route.path === 'separate_provider') {
        activeTurnOutputs.recordDeliveredUtterance({
          scopeKey: scope,
          inputTurnId: 'turn-x',
          role: 'progress',
          text: '先看一下',
        });
      }
      expect(
        hasUnfinishedProactiveOutput({
          interactionMode: 'proactive',
          nonTerminalDelivered: nonTerminal,
          finalDelivered: final,
        }),
      ).toBe(true);
    }
  });

  test('records the exact Proactive final before entering provider delivery', () => {
    const activeTurnOutputs = new ActiveTurnOutputRegistry();
    const scope = channelTurnScope('workspace', 'conversation-agent');
    const coordinator = activeTurnOutputs.bind(scope, 'turn-1', {
      onProgress: () => true,
      onFinalCandidate: () => true,
    });

    const route = routeHostIpcOutput(
      {
        sourceGroup: 'workspace',
        agentId: 'conversation-agent',
        inputTurnId: 'turn-1',
        text: '准确的完整总结正文',
        deliveryRole: 'final',
        authorized: true,
        interactionMode: 'proactive',
      },
      activeTurnOutputs,
    );

    expect(route).toMatchObject({
      path: 'separate_provider',
      deliveryRole: 'final',
      attemptedFinalRecorded: true,
    });
    expect(coordinator.attemptedFinalText).toBe('准确的完整总结正文');
    expect(
      activeTurnOutputs.recordAttemptedFinal({
        scopeKey: scope,
        inputTurnId: 'turn-1',
        text: '另一个不应替换首个 final 的正文',
      }),
    ).toBe(false);
    expect(coordinator.attemptedFinalText).toBe('准确的完整总结正文');
  });

  test('rejects a second different Proactive final before provider delivery', async () => {
    const activeTurnOutputs = new ActiveTurnOutputRegistry();
    const scope = channelTurnScope('workspace', 'conversation-agent');
    activeTurnOutputs.bind(scope, 'turn-1', {
      onProgress: () => true,
      onFinalCandidate: () => true,
    });
    const sendImWithRetry = vi.fn(async () => true);

    expect(
      routeHostIpcOutput(
        {
          sourceGroup: 'workspace',
          agentId: 'conversation-agent',
          inputTurnId: 'turn-1',
          text: '第一份 final',
          deliveryRole: 'final',
          authorized: true,
          interactionMode: 'proactive',
        },
        activeTurnOutputs,
      ),
    ).toMatchObject({
      path: 'separate_provider',
      attemptedFinalRecorded: true,
    });

    const second = routeHostIpcOutput(
      {
        sourceGroup: 'workspace',
        agentId: 'conversation-agent',
        inputTurnId: 'turn-1',
        text: '第二份不同 final',
        deliveryRole: 'final',
        authorized: true,
        interactionMode: 'proactive',
      },
      activeTurnOutputs,
    );
    if (second.path === 'separate_provider') await sendImWithRetry();

    expect(second).toEqual({
      path: 'rejected',
      delivered: false,
      staged: false,
      deliveryRole: 'final',
      reason: 'conflicting_final',
    });
    expect(sendImWithRetry).not.toHaveBeenCalled();
  });

  test('wires the session lane to the live visible answer for interruption persistence', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );

    expect(main).toMatch(
      /agentStreamingAccText\s*=\s*agentAnswerProjection\.visibleAnswerText;/,
    );
    expect(main).not.toContain(
      'agentStreamingAccText = agentAnswerProjection.answerText;',
    );
  });
});
