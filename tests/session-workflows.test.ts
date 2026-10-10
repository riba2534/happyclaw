import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { DATA_DIR } from '../src/config.js';
import {
  attachSessionWorkflowRuns,
  normalizeWorkflowRun,
} from '../src/session-workflows.js';

const createdGroups: string[] = [];

afterEach(() => {
  for (const group of createdGroups.splice(0)) {
    fs.rmSync(path.join(DATA_DIR, 'sessions', group), {
      recursive: true,
      force: true,
    });
  }
});

function completedWorkflow() {
  return {
    taskId: 'ws4k8unmd',
    runId: 'wf_b870d806-6c4',
    workflowName: 'analyze-github-user',
    summary: '分析 GitHub 用户 riba2534 最近的活跃情况',
    status: 'completed',
    startTime: Date.parse('2026-07-21T06:30:23.529Z'),
    timestamp: '2026-07-21T06:37:30.251Z',
    durationMs: 426_722,
    agentCount: 5,
    totalTokens: 251_749,
    totalToolCalls: 20,
    phases: [
      { title: 'Fetch', detail: '并行抓取四个数据维度' },
      { title: 'Synthesize', detail: '跨维度关联分析' },
    ],
    workflowProgress: [
      { type: 'workflow_phase', index: 1, title: 'Fetch' },
      { type: 'workflow_phase', index: 2, title: 'Synthesize' },
      {
        type: 'workflow_agent',
        index: 1,
        label: 'profile',
        phaseIndex: 1,
        phaseTitle: 'Fetch',
        agentId: 'a-profile',
        model: 'glm-5.2[1m]',
        state: 'done',
        tokens: 41_210,
        toolCalls: 4,
        durationMs: 98_000,
      },
      {
        type: 'workflow_agent',
        index: 5,
        label: 'synthesize',
        phaseIndex: 2,
        phaseTitle: 'Synthesize',
        agentId: 'a-synthesize',
        model: 'glm-5.2[1m]',
        state: 'done',
        tokens: 57_169,
        toolCalls: 0,
        durationMs: 131_063,
      },
    ],
  };
}

describe('Claude Code Workflow session projection', () => {
  test('normalizes phases, agents and authoritative totals', () => {
    const run = normalizeWorkflowRun(completedWorkflow());

    expect(run).toMatchObject({
      taskId: 'ws4k8unmd',
      runId: 'wf_b870d806-6c4',
      status: 'completed',
      agentCount: 5,
      totalTokens: 251_749,
      totalToolCalls: 20,
      durationMs: 426_722,
    });
    expect(run?.phases).toEqual([
      { index: 1, title: 'Fetch', detail: '并行抓取四个数据维度' },
      { index: 2, title: 'Synthesize', detail: '跨维度关联分析' },
    ]);
    expect(run?.agents[1]).toMatchObject({
      label: 'synthesize',
      phaseIndex: 2,
      state: 'done',
      tokens: 57_169,
    });
  });

  test('attaches a completed workflow only to the final assistant message', () => {
    const group = `workflow-test-${process.pid}-${Date.now()}`;
    createdGroups.push(group);
    const sessionId = 'session-1';
    const workflowDir = path.join(
      DATA_DIR,
      'sessions',
      group,
      '.claude',
      'projects',
      `-${os.platform()}-fixture`,
      sessionId,
      'workflows',
    );
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowDir, 'wf_fixture.json'),
      JSON.stringify(completedWorkflow()),
    );
    fs.writeFileSync(
      path.join(workflowDir, '..', '..', `${sessionId}.jsonl`),
      [
        {
          type: 'user',
          uuid: 'user-turn',
          message: { content: '<messages><message>分析</message></messages>' },
        },
        {
          type: 'assistant',
          uuid: 'thinking-sdk',
          message: {
            id: 'assistant-api-call',
            model: 'glm-5.2',
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_read_input_tokens: 30,
            },
            content: [{ type: 'thinking', thinking: '分析中' }],
          },
        },
        {
          type: 'assistant',
          uuid: 'final-sdk',
          message: {
            id: 'assistant-api-call',
            model: 'glm-5.2',
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_read_input_tokens: 30,
            },
            content: [{ type: 'text', text: '最终结果' }],
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    );

    const messages = attachSessionWorkflowRuns(
      [
        {
          id: 'process',
          timestamp: '2026-07-21T06:31:00.000Z',
          session_id: sessionId,
          is_from_me: true,
        },
        {
          id: 'final',
          timestamp: '2026-07-21T06:39:38.000Z',
          session_id: sessionId,
          sdk_message_uuid: 'final-sdk',
          is_from_me: true,
          token_usage: JSON.stringify({
            inputTokens: 0,
            outputTokens: 0,
            durationMs: 296_100,
          }),
        },
      ],
      { groupFolder: group, agentId: null },
    );

    expect(messages[0].workflow_runs).toBeUndefined();
    expect(messages[1].workflow_runs?.[0]).toMatchObject({
      taskId: 'ws4k8unmd',
      totalTokens: 251_749,
    });
    expect(JSON.parse(messages[1].token_usage ?? '{}')).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      durationMs: 296_100,
      modelUsage: {
        'glm-5.2': {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 30,
        },
      },
    });

    // Incremental follow-up: an active session keeps appending to the same
    // transcript. A half-written line must stay invisible until completed,
    // then the next pass parses only the appended bytes.
    const transcript = path.join(workflowDir, '..', '..', `${sessionId}.jsonl`);
    const turn2User = JSON.stringify({
      type: 'user',
      uuid: 'user-turn-2',
      message: { content: '<messages><message>继续</message></messages>' },
    });
    const turn2Assistant = JSON.stringify({
      type: 'assistant',
      uuid: 'final-sdk-2',
      message: {
        id: 'assistant-api-call-2',
        model: 'glm-5.2',
        usage: { input_tokens: 7, output_tokens: 5 },
        content: [{ type: 'text', text: '第二轮' }],
      },
    });
    const half = turn2Assistant.slice(0, 40);
    fs.appendFileSync(transcript, `\n${turn2User}\n${half}`);
    const followUpMessage = () => ({
      id: 'final-2',
      timestamp: '2026-07-21T06:59:38.000Z',
      session_id: sessionId,
      sdk_message_uuid: 'final-sdk-2',
      is_from_me: true,
      token_usage: JSON.stringify({ inputTokens: 0, outputTokens: 0 }),
    });
    const midWrite = attachSessionWorkflowRuns([followUpMessage()], {
      groupFolder: group,
      agentId: null,
    });
    expect(JSON.parse(midWrite[0].token_usage ?? '{}').inputTokens ?? 0).toBe(
      0,
    );

    fs.appendFileSync(transcript, turn2Assistant.slice(40));
    const completed = attachSessionWorkflowRuns([followUpMessage()], {
      groupFolder: group,
      agentId: null,
    });
    expect(JSON.parse(completed[0].token_usage ?? '{}')).toMatchObject({
      inputTokens: 7,
      outputTokens: 5,
    });
  });
});

// Host-side parse caches are module-level and keyed per session. These tests
// observe them only through attachSessionWorkflowRuns: a cached session keeps
// answering from its stored state after an in-place same-size rewrite (same
// inode, same size, same mtime for workflow files), while an evicted session
// is reparsed and reports the rewritten values.
describe('session workflow host caches', () => {
  const CACHE_CAP = 64;
  const FIXED_MTIME = new Date('2026-07-21T06:40:00.000Z');

  function projectDir(group: string): string {
    return path.join(
      DATA_DIR,
      'sessions',
      group,
      '.claude',
      'projects',
      `-${os.platform()}-fixture`,
    );
  }

  function transcriptPath(group: string, sessionId: string): string {
    return path.join(projectDir(group), `${sessionId}.jsonl`);
  }

  function workflowPath(group: string, sessionId: string): string {
    return path.join(projectDir(group), sessionId, 'workflows', 'wf_cap.json');
  }

  function userTurn(label: string): string {
    return JSON.stringify({
      type: 'user',
      message: { content: `<messages><message>${label}</message></messages>` },
    });
  }

  function assistantLine(sdkUuid: string, inputTokens: number): string {
    return JSON.stringify({
      type: 'assistant',
      uuid: sdkUuid,
      message: {
        id: `api-${sdkUuid}`,
        model: 'glm-5.2',
        usage: { input_tokens: inputTokens, output_tokens: 1 },
      },
    });
  }

  /** One turn; `inputTokens` keeps a fixed width so rewrites keep the size. */
  function writeSession(
    group: string,
    sessionId: string,
    inputTokens: number,
    summary: string,
  ): void {
    const transcript = transcriptPath(group, sessionId);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(
      transcript,
      `${userTurn(sessionId)}\n${assistantLine(`${sessionId}-final`, inputTokens)}\n`,
    );
    const workflow = workflowPath(group, sessionId);
    fs.mkdirSync(path.dirname(workflow), { recursive: true });
    fs.writeFileSync(
      workflow,
      JSON.stringify({
        taskId: `task-${sessionId}`,
        summary,
        status: 'completed',
      }),
    );
    fs.utimesSync(workflow, FIXED_MTIME, FIXED_MTIME);
  }

  function view(
    group: string,
    sessionId: string,
    sdkUuid = `${sessionId}-final`,
  ): { inputTokens: number; summary: string | undefined } {
    const [message] = attachSessionWorkflowRuns(
      [
        {
          id: `m-${sessionId}`,
          timestamp: '2026-07-21T06:41:00.000Z',
          session_id: sessionId,
          sdk_message_uuid: sdkUuid,
          is_from_me: true,
          token_usage: JSON.stringify({ inputTokens: 0, outputTokens: 0 }),
        },
      ],
      { groupFolder: group, agentId: null },
    );
    return {
      inputTokens: JSON.parse(message.token_usage ?? '{}').inputTokens ?? 0,
      summary: message.workflow_runs?.[0]?.summary,
    };
  }

  function newGroup(label: string): string {
    const group = `workflow-cache-${label}-${process.pid}-${Date.now()}`;
    createdGroups.push(group);
    return group;
  }

  test('bounds both caches to the most recently viewed sessions', () => {
    const group = newGroup('lru');
    const sessions = Array.from(
      { length: CACHE_CAP + 16 },
      (_, index) => `s${String(index).padStart(3, '0')}`,
    );
    for (const sessionId of sessions) {
      writeSession(group, sessionId, 100, 'AAAA');
      expect(view(group, sessionId)).toEqual({
        inputTokens: 100,
        summary: 'AAAA',
      });
    }
    for (const sessionId of sessions) {
      writeSession(group, sessionId, 200, 'BBBB');
    }

    // The newest CACHE_CAP sessions are still cached (stale answers prove it).
    for (const sessionId of sessions.slice(-CACHE_CAP)) {
      expect(view(group, sessionId)).toEqual({
        inputTokens: 100,
        summary: 'AAAA',
      });
    }
    // The one just past the cap and the very first were evicted and reparse.
    expect(view(group, sessions.at(-CACHE_CAP - 1)!)).toEqual({
      inputTokens: 200,
      summary: 'BBBB',
    });
    expect(view(group, sessions[0])).toEqual({
      inputTokens: 200,
      summary: 'BBBB',
    });
  });

  test('a transcript replaced by rename and grown past the old offset is reparsed', () => {
    const group = newGroup('rename');
    const sessionId = 'renamed';
    const transcript = transcriptPath(group, sessionId);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(
      transcript,
      [
        userTurn('old-1'),
        assistantLine('old-1', 300),
        userTurn('old-2'),
        assistantLine('old-2', 301),
        '',
      ].join('\n'),
    );
    expect(view(group, sessionId, 'old-1').inputTokens).toBe(300);

    // session-trim / history-image-prune: write tmp then rename (new inode),
    // and the agent keeps appending so the file outgrows the old offset.
    const tmp = `${transcript}.tmp`;
    fs.writeFileSync(
      tmp,
      [
        userTurn('new-1'),
        assistantLine('new-1', 100),
        userTurn('new-2'),
        assistantLine('new-2', 101),
        userTurn('new-3'),
        assistantLine('new-3', 102),
        userTurn('new-4'),
        assistantLine('new-4', 103),
        '',
      ].join('\n'),
    );
    fs.renameSync(tmp, transcript);

    expect(view(group, sessionId, 'new-1').inputTokens).toBe(100);
    expect(view(group, sessionId, 'new-4').inputTokens).toBe(103);
  });

  test('an append-only transcript is read incrementally from the stored offset', () => {
    const group = newGroup('append');
    const sessionId = 'appending';
    const transcript = transcriptPath(group, sessionId);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(
      transcript,
      `${userTurn('turn-1')}\n${assistantLine('turn-1', 100)}\n`,
    );
    expect(view(group, sessionId, 'turn-1').inputTokens).toBe(100);

    // Overwrite already-consumed bytes in place (same inode, same length).
    // If the next pass re-read them it would report 900 for turn 1.
    const original = fs.readFileSync(transcript, 'utf8');
    const fd = fs.openSync(transcript, 'r+');
    try {
      fs.writeSync(
        fd,
        original.replace('"input_tokens":100', '"input_tokens":900'),
        0,
      );
    } finally {
      fs.closeSync(fd);
    }
    fs.appendFileSync(
      transcript,
      `${userTurn('turn-2')}\n${assistantLine('turn-2', 7)}\n`,
    );

    expect(view(group, sessionId, 'turn-1').inputTokens).toBe(100);
    expect(view(group, sessionId, 'turn-2').inputTokens).toBe(7);
  });

  test('does not read the transcript when every assistant row already has tokens', () => {
    const group = newGroup('recorded');
    const sessionId = 'recorded';
    writeSession(group, sessionId, 100, 'AAAA');
    const transcript = transcriptPath(group, sessionId);
    const openSpy = vi.spyOn(fs, 'openSync');
    try {
      const [message] = attachSessionWorkflowRuns(
        [
          {
            id: 'm-recorded',
            timestamp: '2026-07-21T06:41:00.000Z',
            session_id: sessionId,
            sdk_message_uuid: `${sessionId}-final`,
            is_from_me: true,
            token_usage: JSON.stringify({ inputTokens: 42, outputTokens: 3 }),
          },
        ],
        { groupFolder: group, agentId: null },
      );
      expect(
        openSpy.mock.calls.some(([target]) => String(target) === transcript),
      ).toBe(false);
      // Recorded usage stays authoritative; workflows still attach.
      expect(JSON.parse(message.token_usage ?? '{}').inputTokens).toBe(42);
      expect(message.workflow_runs?.[0]?.summary).toBe('AAAA');
    } finally {
      openSpy.mockRestore();
    }
    // A row missing usage still recovers it from the same transcript.
    expect(view(group, sessionId).inputTokens).toBe(100);
  });

  test('a session whose transcript and workflows are gone is dropped from the caches', () => {
    const group = newGroup('missing');
    const sessions = Array.from(
      { length: CACHE_CAP + 1 },
      (_, index) => `m${String(index).padStart(3, '0')}`,
    );
    const filled = sessions.slice(0, CACHE_CAP);
    for (const sessionId of filled) {
      writeSession(group, sessionId, 100, 'AAAA');
      view(group, sessionId);
    }

    // The last filled session loses its files; viewing it must free its slot.
    const gone = filled.at(-1)!;
    fs.rmSync(transcriptPath(group, gone));
    fs.rmSync(path.join(projectDir(group), gone), {
      recursive: true,
      force: true,
    });
    expect(view(group, gone)).toEqual({ inputTokens: 0, summary: undefined });

    // A recreated transcript of the same size is parsed afresh, not answered
    // from the forgotten state.
    writeSession(group, gone, 200, 'BBBB');
    expect(view(group, gone)).toEqual({ inputTokens: 200, summary: 'BBBB' });
    fs.rmSync(transcriptPath(group, gone));
    fs.rmSync(path.join(projectDir(group), gone), {
      recursive: true,
      force: true,
    });
    view(group, gone);

    // With the freed slot, one more session fits without evicting the oldest.
    writeSession(group, sessions.at(-1)!, 100, 'AAAA');
    view(group, sessions.at(-1)!);
    writeSession(group, filled[0], 200, 'BBBB');
    expect(view(group, filled[0])).toEqual({
      inputTokens: 100,
      summary: 'AAAA',
    });
  });
});
