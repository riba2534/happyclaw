import { describe, expect, test, vi } from 'vitest';

import {
  ActiveTurnOutputRegistry,
  TurnOutputCoordinator,
} from '../src/turn-output-coordinator.js';
import { channelTurnScope } from '../src/channel-turn-registry.js';

describe('TurnOutputCoordinator answer lanes', () => {
  test('removes streamed process narration when the same assistant response later calls a tool', () => {
    const coordinator = new TurnOutputCoordinator();

    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_start',
      messageUuid: 'assistant-1',
    });
    expect(
      coordinator.reduceStreamEvent({
        eventType: 'text_delta',
        text: '我先查一下这个链接。',
        messageUuid: 'assistant-1',
      }),
    ).toMatchObject({
      answerText: '',
      visibleAnswerText: '我先查一下这个链接。',
      visibleAnswerChanged: true,
      provisionalText: '我先查一下这个链接。',
      answerChanged: false,
      narrationDiscarded: false,
    });

    const rolledBack = coordinator.reduceStreamEvent({
      eventType: 'tool_use_start',
      toolName: 'WebFetch',
      messageUuid: 'assistant-1',
    });
    expect(rolledBack).toMatchObject({
      answerText: '',
      visibleAnswerText: '',
      visibleAnswerChanged: true,
    });
    expect(
      coordinator.reduceStreamEvent({
        eventType: 'raw_sdk_event',
        rawType: 'stream_event/message_stop',
        messageUuid: 'assistant-1',
      }),
    ).toMatchObject({
      answerText: '',
      answerChanged: false,
      visibleAnswerText: '',
      narrationDiscarded: true,
    });
    expect(coordinator.lastNarration).toBe('我先查一下这个链接。');

    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_start',
      messageUuid: 'assistant-2',
    });
    const firstFinalDelta = coordinator.reduceStreamEvent({
      eventType: 'text_delta',
      text: '# 调研结论\n\n',
      messageUuid: 'assistant-2',
    });
    expect(firstFinalDelta).toMatchObject({
      answerText: '',
      visibleAnswerText: '# 调研结论\n\n',
      visibleAnswerChanged: true,
    });
    const secondFinalDelta = coordinator.reduceStreamEvent({
      eventType: 'text_delta',
      text: '最终报告',
      messageUuid: 'assistant-2',
    });
    expect(secondFinalDelta.visibleAnswerText).toBe('# 调研结论\n\n最终报告');
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_stop',
      messageUuid: 'assistant-2',
    });
    expect(coordinator.candidateText).toBe('# 调研结论\n\n最终报告');
  });

  test('tool_use followed by text in the same assistant message is still narration', () => {
    const coordinator = new TurnOutputCoordinator();
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_start',
      messageUuid: 'assistant-tool-first',
    });
    coordinator.reduceStreamEvent({
      eventType: 'tool_use_start',
      toolName: 'Task',
      messageUuid: 'assistant-tool-first',
    });
    coordinator.reduceStreamEvent({
      eventType: 'text_delta',
      text: '任务已经派出，正在等待。',
      messageUuid: 'assistant-tool-first',
    });
    const projection = coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_stop',
      messageUuid: 'assistant-tool-first',
    });

    expect(projection.answerText).toBe('');
    expect(projection.narrationDiscarded).toBe(true);
    expect(coordinator.lastNarration).toBe('任务已经派出，正在等待。');
  });

  test('sub-agent text and nested tools never mutate the primary answer lane', () => {
    const coordinator = new TurnOutputCoordinator();
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_start',
      messageUuid: 'main-1',
    });
    coordinator.reduceStreamEvent({
      eventType: 'text_delta',
      text: '主 Agent 答案',
    });
    coordinator.reduceStreamEvent({
      eventType: 'text_delta',
      text: '子 Agent 过程输出',
      parentToolUseId: 'task-1',
    });
    coordinator.reduceStreamEvent({
      eventType: 'tool_use_start',
      toolName: 'Read',
      parentToolUseId: 'task-1',
    });
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_stop',
      messageUuid: 'main-1',
    });
    expect(coordinator.candidateText).toBe('主 Agent 答案');
  });

  test('nested assistant boundaries cannot replace an in-flight primary message', () => {
    const coordinator = new TurnOutputCoordinator();
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_start',
      messageUuid: 'main-1',
    });
    coordinator.reduceStreamEvent({
      eventType: 'text_delta',
      text: '主答案前半段，',
      messageUuid: 'main-1',
    });
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_start',
      messageUuid: 'nested-1',
      parentToolUseId: 'task-1',
    });
    coordinator.reduceStreamEvent({
      eventType: 'text_delta',
      text: '子 Agent 过程',
      messageUuid: 'nested-1',
      parentToolUseId: 'task-1',
    });
    coordinator.reduceStreamEvent({
      eventType: 'tool_use_start',
      toolName: 'Read',
      messageUuid: 'nested-1',
      parentToolUseId: 'task-1',
    });
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_stop',
      messageUuid: 'nested-1',
      parentToolUseId: 'task-1',
    });
    expect(coordinator.visibleAnswerText).toBe('主答案前半段，');

    coordinator.reduceStreamEvent({
      eventType: 'text_delta',
      text: '主答案后半段。',
      messageUuid: 'main-1',
    });
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_stop',
      messageUuid: 'main-1',
    });

    expect(coordinator.candidateText).toBe('主答案前半段，主答案后半段。');
  });

  test('always treats non-empty SDK Result.success.result as authoritative', () => {
    const coordinator = new TurnOutputCoordinator();
    const narration = '三个调研任务已派出，等待完成。';
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_start',
      messageUuid: 'assistant-1',
    });
    coordinator.reduceStreamEvent({
      eventType: 'text_delta',
      text: narration,
    });
    coordinator.reduceStreamEvent({
      eventType: 'tool_use_start',
      toolName: 'Task',
    });
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_stop',
      messageUuid: 'assistant-1',
    });

    expect(coordinator.resolvePrimaryAnswer(narration)).toEqual({
      text: narration,
      source: 'sdk_final',
    });
  });

  test('SDK final owns the primary answer even when MCP final was staged first', () => {
    const coordinator = new TurnOutputCoordinator();
    expect(coordinator.stageMessage('final', 'MCP 候选答案').accepted).toBe(
      true,
    );
    expect(coordinator.resolvePrimaryAnswer('SDK 权威答案')).toEqual({
      text: 'SDK 权威答案',
      source: 'sdk_final',
    });
  });

  test('staged MCP final is the fallback when SDK result is empty', () => {
    const coordinator = new TurnOutputCoordinator();
    coordinator.stageMessage('final', '工具生成的完整报告');
    expect(coordinator.resolvePrimaryAnswer(null)).toEqual({
      text: '工具生成的完整报告',
      source: 'mcp_final',
    });
  });
});

describe('ActiveTurnOutputRegistry exactly-one staging', () => {
  test('progress and final update one active projection without creating sibling sends', () => {
    const registry = new ActiveTurnOutputRegistry();
    const progress = vi.fn(() => true);
    const final = vi.fn(() => true);
    registry.bind('workspace:main', 'turn-1', {
      onProgress: progress,
      onFinalCandidate: final,
    });

    expect(
      registry.stage({
        scopeKey: 'workspace:main',
        inputTurnId: 'turn-1',
        role: 'progress',
        text: '正在抓取资料',
      }),
    ).toEqual({ accepted: true, duplicate: false });
    expect(
      registry.stage({
        scopeKey: 'workspace:main',
        inputTurnId: 'turn-1',
        role: 'final',
        text: '完整报告',
      }),
    ).toEqual({ accepted: true, duplicate: false });
    expect(progress).toHaveBeenCalledOnce();
    expect(final).toHaveBeenCalledOnce();
  });

  test('replayed staged output is acknowledged but not projected twice', () => {
    const registry = new ActiveTurnOutputRegistry();
    const final = vi.fn(() => true);
    registry.bind('workspace:main', 'turn-1', {
      onProgress: () => true,
      onFinalCandidate: final,
    });
    const input = {
      scopeKey: 'workspace:main',
      inputTurnId: 'turn-1',
      role: 'final' as const,
      text: '同一份报告',
    };

    expect(registry.stage(input)).toEqual({
      accepted: true,
      duplicate: false,
    });
    expect(registry.stage(input)).toEqual({
      accepted: true,
      duplicate: true,
    });
    expect(final).toHaveBeenCalledOnce();
  });

  test('late MCP final is rejected after SDK final owns the answer', () => {
    const registry = new ActiveTurnOutputRegistry();
    const final = vi.fn(() => true);
    const coordinator = registry.bind('workspace:main', 'turn-1', {
      onProgress: () => true,
      onFinalCandidate: final,
    });
    coordinator.resolvePrimaryAnswer('SDK final');
    coordinator.markFinalized();

    expect(
      registry.stage({
        scopeKey: 'workspace:main',
        inputTurnId: 'turn-1',
        role: 'final',
        text: 'late tool final',
      }),
    ).toEqual({
      accepted: false,
      duplicate: false,
      reason: 'finalized',
    });
    expect(final).not.toHaveBeenCalled();
  });

  test('main and conversation-agent scopes stay isolated for the same input ID', () => {
    const registry = new ActiveTurnOutputRegistry();
    const a = vi.fn(() => true);
    const b = vi.fn(() => true);
    const mainScope = channelTurnScope('workspace');
    const agentScope = channelTurnScope('workspace', 'custom-agent');
    registry.bind(mainScope, 'same-turn', {
      onProgress: a,
      onFinalCandidate: a,
    });
    registry.bind(agentScope, 'same-turn', {
      onProgress: b,
      onFinalCandidate: b,
    });

    registry.stage({
      scopeKey: agentScope,
      inputTurnId: 'same-turn',
      role: 'progress',
      text: 'custom agent progress',
    });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
  });

  test('records physical utterances only for the exact active scope and input', () => {
    const registry = new ActiveTurnOutputRegistry();
    const mainDelivered = vi.fn();
    const agentDelivered = vi.fn();
    const mainScope = channelTurnScope('workspace');
    const agentScope = channelTurnScope('workspace', 'conversation-agent');
    const main = registry.bind(mainScope, 'same-turn', {
      onProgress: () => true,
      onFinalCandidate: () => true,
      onUtteranceDelivered: mainDelivered,
    });
    const agent = registry.bind(agentScope, 'same-turn', {
      onProgress: () => true,
      onFinalCandidate: () => true,
      onUtteranceDelivered: agentDelivered,
    });

    expect(
      registry.recordDeliveredUtterance({
        scopeKey: agentScope,
        inputTurnId: 'same-turn',
      }),
    ).toBe(true);
    expect(main.deliveredUtterances).toBe(0);
    expect(agent.deliveredUtterances).toBe(1);
    expect(mainDelivered).not.toHaveBeenCalled();
    expect(agentDelivered).toHaveBeenCalledOnce();

    agent.markFinalized();
    expect(
      registry.recordDeliveredUtterance({
        scopeKey: agentScope,
        inputTurnId: 'same-turn',
      }),
    ).toBe(false);
    expect(agent.deliveredUtterances).toBe(1);
    expect(agentDelivered).toHaveBeenCalledOnce();
  });

  test('projection failure does not poison dedupe or staged-final state', () => {
    const registry = new ActiveTurnOutputRegistry();
    const final = vi
      .fn<(_: string) => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const coordinator = registry.bind('workspace:main', 'turn-1', {
      onProgress: () => true,
      onFinalCandidate: final,
    });
    const input = {
      scopeKey: 'workspace:main',
      inputTurnId: 'turn-1',
      role: 'final' as const,
      text: '不能静默丢失',
    };

    expect(registry.stage(input)).toEqual({
      accepted: false,
      duplicate: false,
      reason: 'projection_unavailable',
    });
    expect(coordinator.resolvePrimaryAnswer(null)).toEqual({
      text: null,
      source: 'empty',
    });
    expect(registry.stage(input)).toEqual({
      accepted: true,
      duplicate: false,
    });
    expect(final).toHaveBeenCalledTimes(2);
  });
});
