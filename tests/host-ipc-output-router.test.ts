import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { channelTurnScope } from '../src/channel-turn-registry.js';
import {
  resolveHostIpcLogicalChatJid,
  routeHostIpcOutput,
} from '../src/host-ipc-output-router.js';
import { ActiveTurnOutputRegistry } from '../src/turn-output-coordinator.js';

describe('host IPC primary output routing', () => {
  test('projects conversation-agent output into its canonical Web session', () => {
    expect(
      resolveHostIpcLogicalChatJid({
        sourceChatJid: 'feishu:oc_chat#thread:omt_topic#root:om_root',
        agentId: 'conversation-agent',
        agentChatJid: 'web:main',
        scheduledTask: false,
      }),
    ).toBe('web:main#agent:conversation-agent');
    expect(
      resolveHostIpcLogicalChatJid({
        sourceChatJid: 'web:workspace',
        taskRunId: 'task-run-1',
        scheduledTask: true,
      }),
    ).toBe('web:workspace#task:task-run-1');
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
        scheduledTask: false,
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
        scheduledTask: false,
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

  test('keeps scheduled and explicitly separate output on the provider lane', () => {
    const activeTurnOutputs = new ActiveTurnOutputRegistry();

    expect(
      routeHostIpcOutput(
        {
          sourceGroup: 'workspace',
          inputTurnId: 'turn-1',
          text: '定时任务通知',
          deliveryRole: 'final',
          authorized: true,
          scheduledTask: true,
        },
        activeTurnOutputs,
      ).path,
    ).toBe('separate_provider');
    expect(
      routeHostIpcOutput(
        {
          sourceGroup: 'workspace',
          inputTurnId: 'turn-1',
          text: '额外通知',
          deliveryRole: 'separate',
          authorized: true,
          scheduledTask: false,
        },
        activeTurnOutputs,
      ).path,
    ).toBe('separate_provider');
  });

  test('proactive mode forces progress and final requests onto independent message delivery', () => {
    const activeTurnOutputs = new ActiveTurnOutputRegistry();
    const projected = vi.fn(() => true);
    activeTurnOutputs.bind(
      channelTurnScope('workspace', 'conversation-agent'),
      'turn-1',
      {
        onProgress: projected,
        onFinalCandidate: projected,
      },
    );

    for (const deliveryRole of ['progress', 'final'] as const) {
      expect(
        routeHostIpcOutput(
          {
            sourceGroup: 'workspace',
            agentId: 'conversation-agent',
            inputTurnId: 'turn-1',
            text: `${deliveryRole} utterance`,
            deliveryRole,
            authorized: true,
            scheduledTask: false,
            interactionMode: 'proactive',
          },
          activeTurnOutputs,
        ),
      ).toMatchObject({
        path: 'separate_provider',
        staged: false,
        deliveryRole,
      });
    }
    expect(projected).not.toHaveBeenCalled();
  });

  test('wires both host execution paths to the live visible answer for interruption persistence', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );

    expect(main).toMatch(
      /streamingAccumulatedText\s*=\s*answerProjection\.visibleAnswerText;/,
    );
    expect(main).toMatch(
      /agentStreamingAccText\s*=\s*agentAnswerProjection\.visibleAnswerText;/,
    );
    expect(main).not.toContain(
      'streamingAccumulatedText = answerProjection.answerText;',
    );
    expect(main).not.toContain(
      'agentStreamingAccText = agentAnswerProjection.answerText;',
    );
  });
});
