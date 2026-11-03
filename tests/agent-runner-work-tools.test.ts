import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { teamDisallowedTools } from '../container/agent-runner/src/builtin-tool-policy.js';
import { createDelegationTools } from '../container/agent-runner/src/delegation-tools.js';
import {
  createMcpTools,
  type McpContext,
} from '../container/agent-runner/src/mcp-tools.js';
import { buildHappyClawPromptPlan } from '../container/agent-runner/src/prompt-plan.js';
import type { TeamRole } from '../container/agent-runner/src/work-items.js';

const runnerRequire = createRequire(
  path.resolve('container/agent-runner/package.json'),
);
const runnerSdk = (await import(
  pathToFileURL(runnerRequire.resolve('@anthropic-ai/claude-agent-sdk')).href
)) as typeof import('@anthropic-ai/claude-agent-sdk');

const ROUTER: TeamRole = { role: 'router' };
const WRITER: TeamRole = {
  role: 'worker',
  workItemId: 'item-1',
  writable: true,
};
const READER: TeamRole = {
  role: 'worker',
  workItemId: 'item-2',
  writable: false,
};
const DELEGATED: TeamRole = {
  role: 'worker',
  workItemId: 'item-3',
  writable: true,
  origin: 'delegated',
};
const DELEGATION_TOOLS = [
  'work_delegate',
  'work_delegations',
  'work_stop',
  'work_followup',
];

/**
 * What a team session does not get: tools that post to the chat directly,
 * automations (and the retired schedule_task) and skill installs.
 */
const WITHHELD_TOOLS = [
  'send_message',
  'send_image',
  'send_file',
  'feishu_send_card',
  'feishu_api_request',
  'schedule_task',
  'automation_create',
  'automation_update',
  'automation_pause',
  'automation_resume',
  'automation_complete',
  'automation_delete',
  'automation_run_now',
  'automation_list',
  'automation_list_runs',
  'automation_notify_current_run',
  'automation_silence_current_run',
  'install_skill',
  'uninstall_skill',
];

const roots: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function context(
  root: string,
  teamRole?: TeamRole,
  workMode?: 'multi',
): McpContext {
  return {
    chatJid: 'web:workspace',
    groupFolder: 'workspace',
    isHome: false,
    isAdminHome: false,
    agentBuilderEnabled: false,
    ownerProfileEnabled: false,
    interactionMode: 'proactive',
    currentInputTurnId: 'turn-1',
    workspaceIpc: root,
    workspaceGroup: root,
    ...(teamRole ? { teamRole } : {}),
    ...(workMode ? { workMode } : {}),
  };
}

/** A Home session's tools, so the skill install tools are among them. */
const definitions = (teamRole?: TeamRole, workMode?: 'multi') =>
  createMcpTools({
    ...context('/tmp/work-tools-ipc', teamRole, workMode),
    isHome: true,
  });
const names = (teamRole?: TeamRole, workMode?: 'multi') =>
  definitions(teamRole, workMode).map((tool) => tool.name);

/** The Runner's real tool set behind a real MCP client, as the CLI sees it. */
async function setup(teamRole?: TeamRole, workMode?: 'multi') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'work-tools-'));
  roots.push(root);
  const ctx = context(root, teamRole, workMode);
  const server = runnerSdk.createSdkMcpServer({
    name: 'happyclaw',
    version: 'test',
    tools: createMcpTools(ctx),
  }) as unknown as { instance: { connect(transport: unknown): Promise<void> } };
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  clients.push(client);
  return { ctx, client, tasksDir: path.join(root, 'tasks') };
}

function requestFiles(tasksDir: string): string[] {
  if (!fs.existsSync(tasksDir)) return [];
  return fs
    .readdirSync(tasksDir)
    .filter((name) => name.endsWith('.json') && !name.includes('_result_'));
}

type WorkRequest = Record<string, unknown> & {
  type: string;
  requestId: string;
};

/** Plays the host: answers the next request once it lands. */
async function answerNext(
  tasksDir: string,
  result: Record<string, unknown>,
): Promise<WorkRequest> {
  let file = '';
  await vi.waitFor(() => {
    file = requestFiles(tasksDir)[0];
    expect(file).toBeTruthy();
  });
  const filePath = path.join(tasksDir, file);
  const request = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WorkRequest;
  fs.unlinkSync(filePath);
  fs.writeFileSync(
    path.join(tasksDir, `${request.type}_result_${request.requestId}.json`),
    JSON.stringify(result),
  );
  return request;
}

/** Call a tool while the host answers; resolves with both sides. */
async function exchange(
  setupResult: Awaited<ReturnType<typeof setup>>,
  name: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
) {
  const call = setupResult.client.callTool({ name, arguments: args });
  const request = await answerNext(setupResult.tasksDir, result);
  return { request, result: await call };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ text: string }>)
    .map((part) => part.text)
    .join('\n');
}

/** The request as the contract specifies it, with the random id checked apart. */
function body(request: WorkRequest): Record<string, unknown> {
  const { requestId, ...rest } = request;
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  return rest;
}

describe('team-mode tool registration', () => {
  test('without a role the tool set is unchanged and has no work tools', () => {
    const plain = names();
    expect(plain).toContain('send_message');
    for (const name of [
      'work_route',
      'work_reply',
      'work_list',
      'work_report',
      'work_ack',
      'work_handback',
    ]) {
      expect(plain).not.toContain(name);
    }
  });

  test('the router swaps the withheld tools for the router tools', () => {
    const plain = names();
    expect(plain).toEqual(expect.arrayContaining(WITHHELD_TOOLS));
    expect(names(ROUTER)).toEqual([
      ...plain.filter((name) => !WITHHELD_TOOLS.includes(name)),
      'work_route',
      'work_reply',
      'work_list',
    ]);
  });

  test('a worker, writable or not, swaps the withheld tools for the worker tools', () => {
    const plain = names();
    for (const role of [WRITER, READER]) {
      expect(names(role)).toEqual([
        ...plain.filter((name) => !WITHHELD_TOOLS.includes(name)),
        'work_ack',
        'work_report',
        'work_handback',
      ]);
    }
  });

  test('the per-turn work tools are always loaded and work_list is read-only', () => {
    const tools = [
      ...createMcpTools(context('/tmp/work-tools-ipc', ROUTER)),
      ...createMcpTools(context('/tmp/work-tools-ipc', WRITER)),
    ];
    const meta = (name: string) =>
      tools.find((tool) => tool.name === name)!._meta?.['anthropic/alwaysLoad'];
    for (const name of ['work_route', 'work_reply', 'work_ack', 'work_report'])
      expect(meta(name)).toBe(true);
    expect(
      tools.find((tool) => tool.name === 'work_list')!.annotations
        ?.readOnlyHint,
    ).toBe(true);
  });
});

describe('team-mode disallowed tools', () => {
  test('no role adds nothing', () => {
    expect(teamDisallowedTools(undefined)).toEqual([]);
  });

  test('the router asks no questions and edits no files', () => {
    expect(teamDisallowedTools(ROUTER)).toEqual([
      'AskUserQuestion',
      'Edit',
      'Write',
      'NotebookEdit',
    ]);
  });

  test('a writable worker only loses AskUserQuestion', () => {
    expect(teamDisallowedTools(WRITER)).toEqual(['AskUserQuestion']);
  });

  test('a read-only worker also loses the edit tools', () => {
    expect(teamDisallowedTools(READER)).toEqual([
      'AskUserQuestion',
      'Edit',
      'Write',
      'NotebookEdit',
    ]);
  });
});

describe('team-mode PromptPlan', () => {
  const sources = {
    interaction: 'interaction',
    security: 'security',
    memory: { id: 'memory-system.workspace' as const, text: 'memory' },
    output: 'output',
    web: 'web',
  };

  test("a team section takes the output contract's place", () => {
    const { output: _output, ...rest } = sources;
    const plan = buildHappyClawPromptPlan({
      ...rest,
      team: { id: 'team-router', text: 'ROUTER_MARKER' },
    });
    expect(plan.errors).toEqual([]);
    expect(plan.blocks.map((block) => block.id)).toEqual([
      'interaction',
      'security-rules',
      'memory-system.workspace',
      'team-router',
      'web-fetch',
    ]);
    expect(plan.blocks[3]).toMatchObject({
      owner: 'platform',
      scope: 'main',
      required: true,
      condition: 'team mode router session',
      text: '<team-router>\nROUTER_MARKER\n</team-router>',
    });
  });

  test('without a team section the output contract stays required', () => {
    const { output: _output, ...rest } = sources;
    expect(buildHappyClawPromptPlan(rest).errors).toEqual([
      'required prompt block is empty: output',
    ]);
  });

  test('without a team section the plan is what it was', () => {
    const plan = buildHappyClawPromptPlan({
      ...sources,
      deliveryContract: 'delivery',
    });
    expect(plan.blocks.map((block) => block.id)).toEqual([
      'interaction',
      'security-rules',
      'memory-system.workspace',
      'output',
      'web-fetch',
      'delivery-contract',
    ]);
    expect(plan.text).toBe(
      [
        '<behavior>\ninteraction\n</behavior>',
        '<security>\nsecurity\n</security>',
        '<memory-system>\nmemory\n</memory-system>',
        '<output-contract>\noutput\n</output-contract>',
        '<web-access>\nweb\n</web-access>',
        '<delivery-contract>\ndelivery\n</delivery-contract>',
      ].join('\n'),
    );
  });
});

describe('router tools over IPC', () => {
  test('work_route sends the items as given and lists each result', async () => {
    const env = await setup(ROUTER);
    const items = [
      {
        kind: 'accept',
        triggerMessageId: 'om_1',
        title: 'Rename the Save button',
        acknowledgement: '收到，把设置页的按钮改成「保存」。',
        note: 'The owner wants it today.',
        ruleAssessments: [
          { ruleId: 'r1', matched: true, reason: 'copy fix' },
          { ruleId: 'r2', matched: false, reason: 'not a test' },
        ],
      },
      { kind: 'attach', triggerMessageId: 'om_2', workItemId: 'item-1' },
      { kind: 'stop', triggerMessageId: 'om_3', workItemId: 'item-2' },
      { kind: 'ignore', triggerMessageId: 'om_4', reason: 'thanks' },
    ];
    const { request, result } = await exchange(
      env,
      'work_route',
      { items },
      {
        ok: true,
        data: {
          results: [
            {
              triggerMessageId: 'om_1',
              ok: true,
              decision: 'accept',
              workItemId: 'item-9',
            },
            { triggerMessageId: 'om_2', ok: false, error: 'not explicit' },
            { triggerMessageId: 'om_3', ok: true, decision: 'stop' },
            { triggerMessageId: 'om_4', ok: true, decision: 'ignore' },
          ],
        },
      },
    );
    expect(body(request)).toEqual({
      type: 'work_route',
      items,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(
      [
        '- om_1: accept, work item item-9',
        '- om_2: refused: not explicit',
        '- om_3: stop',
        '- om_4: ignore',
      ].join('\n'),
    );
  });

  test('work_route refuses incomplete items before sending anything', async () => {
    const env = await setup(ROUTER);
    const result = await env.client.callTool({
      name: 'work_route',
      arguments: {
        items: [
          { kind: 'accept', triggerMessageId: 'om_1', title: 'x' },
          { kind: 'attach', triggerMessageId: 'om_2' },
          { kind: 'ignore', triggerMessageId: 'om_3' },
          {
            kind: 'accept',
            triggerMessageId: 'om_4',
            title: 't',
            acknowledgement: 'ok',
            note: Array.from({ length: 31 }, () => 'word').join(' '),
          },
        ],
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'Nothing was sent; fix these and call again: om_1: accept needs acknowledgement; om_2: attach needs workItemId; om_3: ignore needs reason; om_4: note is 31 words; the limit is 30',
    );
    expect(requestFiles(env.tasksDir)).toEqual([]);
  });

  test('work_route rejects unknown fields and long titles at the schema', async () => {
    const env = await setup(ROUTER);
    const unknown = await env.client.callTool({
      name: 'work_route',
      arguments: {
        items: [
          { kind: 'ignore', triggerMessageId: 'om_1', reason: 'x', plan: 'y' },
        ],
      },
    });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('不支持的参数：plan');
    const longTitle = await env.client.callTool({
      name: 'work_route',
      arguments: {
        items: [
          {
            kind: 'accept',
            triggerMessageId: 'om_1',
            title: 'x'.repeat(61),
            acknowledgement: 'ok',
          },
        ],
      },
    });
    expect(longTitle.isError).toBe(true);
    expect(requestFiles(env.tasksDir)).toEqual([]);
  });

  test('work_reply sends only the fields its purpose uses', async () => {
    const env = await setup(ROUTER);
    const result = await exchange(
      env,
      'work_reply',
      {
        purpose: 'result',
        workItemId: 'item-1',
        text: 'Done: the button reads Save.',
      },
      { ok: true, data: { queued: true } },
    );
    expect(body(result.request)).toEqual({
      type: 'work_reply',
      purpose: 'result',
      workItemId: 'item-1',
      text: 'Done: the button reads Save.',
    });
    expect(textOf(result.result)).toContain('Queued');

    const answer = await exchange(
      env,
      'work_reply',
      { purpose: 'answer', triggerMessageId: 'om_5', text: '是的。' },
      { ok: true, data: { queued: true } },
    );
    expect(body(answer.request)).toEqual({
      type: 'work_reply',
      purpose: 'answer',
      triggerMessageId: 'om_5',
      text: '是的。',
    });
  });

  test('work_reply refuses a missing target or an over-long text locally, and relays a host refusal', async () => {
    const env = await setup(ROUTER);
    const noItem = await env.client.callTool({
      name: 'work_reply',
      arguments: { purpose: 'attention', text: 'Which page?' },
    });
    expect(noItem.isError).toBe(true);
    expect(textOf(noItem)).toBe('Nothing was sent: attention needs workItemId');
    const tooLong = await env.client.callTool({
      name: 'work_reply',
      arguments: {
        purpose: 'answer',
        triggerMessageId: 'om_1',
        text: '字'.repeat(101),
      },
    });
    expect(tooLong.isError).toBe(true);
    expect(textOf(tooLong)).toBe(
      'Nothing was sent: text is 101 words; the limit is 100',
    );
    expect(requestFiles(env.tasksDir)).toEqual([]);

    const refused = await exchange(
      env,
      'work_reply',
      { purpose: 'result', workItemId: 'item-1', text: 'Done.' },
      { ok: false, error: 'the work item is not ready' },
    );
    expect(refused.result.isError).toBe(true);
    expect(textOf(refused.result)).toBe('the work item is not ready');
  });

  test('work_list sends its filters and lists the items', async () => {
    const env = await setup(ROUTER);
    const { request, result } = await exchange(
      env,
      'work_list',
      { status: 'all', limit: 5 },
      {
        ok: true,
        data: {
          items: [
            {
              id: 'item-1',
              seq: 12,
              title: 'Rename the Save button',
              stage: 'answer',
              lastReport: 'progress',
              lastSummary: 'Found the label.',
              attention: 'Save or Apply?',
              sourceMessageId: 'om_1',
            },
          ],
        },
      },
    );
    expect(body(request)).toEqual({
      type: 'work_list',
      status: 'all',
      limit: 5,
    });
    expect(textOf(result)).toBe(
      '- #12 Rename the Save button · id: item-1 · stage: answer · last report: progress · source: om_1 · waiting on a person: Save or Apply? · summary: Found the label.',
    );

    const empty = await exchange(
      env,
      'work_list',
      {},
      { ok: true, data: { items: [] } },
    );
    expect(body(empty.request)).toEqual({
      type: 'work_list',
    });
    expect(textOf(empty.result)).toBe('No work items.');
  });

  test('a request names no input turn, even while one is current', async () => {
    const env = await setup(ROUTER);
    expect(env.ctx.currentInputTurnId).toBe('turn-1');
    const { request } = await exchange(
      env,
      'work_list',
      {},
      { ok: true, data: {} },
    );
    expect(body(request)).toEqual({ type: 'work_list' });
  });
});

describe('worker tools over IPC', () => {
  test('work_ack sends the trigger and text and reports a duplicate', async () => {
    const env = await setup(READER);
    const first = await exchange(
      env,
      'work_ack',
      { triggerMessageId: 'om_1', text: 'On it: reproducing the crash.' },
      { ok: true, data: { duplicate: false } },
    );
    expect(body(first.request)).toEqual({
      type: 'work_ack',
      triggerMessageId: 'om_1',
      text: 'On it: reproducing the crash.',
    });
    expect(textOf(first.result)).toContain('Acknowledgement queued');
    const again = await exchange(
      env,
      'work_ack',
      { triggerMessageId: 'om_1', text: 'On it.' },
      { ok: true, data: { duplicate: true } },
    );
    expect(textOf(again.result)).toBe(
      'Already acknowledged; nothing new was posted.',
    );
  });

  test('work_report sends state, summary and the optional question fields as given', async () => {
    const env = await setup(WRITER);
    const ready = await exchange(
      env,
      'work_report',
      { state: 'ready', summary: 'PR #3 renames the button; tests pass.' },
      { ok: true, data: {} },
    );
    expect(body(ready.request)).toEqual({
      type: 'work_report',
      state: 'ready',
      summary: 'PR #3 renames the button; tests pass.',
    });
    expect(textOf(ready.result)).toBe('Reported to the router.');

    const asking = await exchange(
      env,
      'work_report',
      {
        state: 'progress',
        summary: 'Two labels fit.',
        humanAction: 'Save or Apply?',
        questionForMessageId: 'om_7',
      },
      { ok: true, data: {} },
    );
    expect(body(asking.request)).toEqual({
      type: 'work_report',
      state: 'progress',
      summary: 'Two labels fit.',
      humanAction: 'Save or Apply?',
      questionForMessageId: 'om_7',
    });

    const cleared = await exchange(
      env,
      'work_report',
      { state: 'progress', summary: 'Using Save.', humanAction: null },
      { ok: true, data: {} },
    );
    expect(body(cleared.request)).toMatchObject({ humanAction: null });
    expect(textOf(cleared.result)).toBe('Recorded.');
  });

  test('work_report accepts exactly the report states', async () => {
    const env = await setup(WRITER);
    const listed = await env.client.listTools();
    const schema = listed.tools.find((tool) => tool.name === 'work_report')!
      .inputSchema as {
      additionalProperties?: unknown;
      properties: { state: { enum: string[] } };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.state.enum).toEqual([
      'progress',
      'waiting',
      'ready',
      'blocked',
      'failed',
      'dropped',
    ]);
    const bad = await env.client.callTool({
      name: 'work_report',
      arguments: { state: 'done', summary: 'x' },
    });
    expect(bad.isError).toBe(true);
    expect(requestFiles(env.tasksDir)).toEqual([]);
  });

  test('work_handback sends the trigger and reason', async () => {
    const env = await setup(WRITER);
    const { request, result } = await exchange(
      env,
      'work_handback',
      { triggerMessageId: 'om_8', reason: 'It asks about another page.' },
      { ok: true, data: {} },
    );
    expect(body(request)).toEqual({
      type: 'work_handback',
      triggerMessageId: 'om_8',
      reason: 'It asks about another page.',
    });
    expect(textOf(result)).toBe('Handed back to the router.');
  });
});

describe('multi-task mode tool registration', () => {
  test('only a multi-task conversation without a team role gets the delegation tools, after all the others', () => {
    const single = names();
    for (const name of DELEGATION_TOOLS) expect(single).not.toContain(name);
    expect(names(undefined, 'multi')).toEqual([...single, ...DELEGATION_TOOLS]);
    for (const role of [ROUTER, WRITER, READER, DELEGATED]) {
      expect(names(role, 'multi')).toEqual(names(role));
    }
  });

  test('the work mode leaves every other tool definition as it was', () => {
    const shape = (tool: ReturnType<typeof definitions>[number]) => ({
      name: tool.name,
      description: tool.description,
      annotations: tool.annotations,
      meta: tool._meta,
    });
    const single = definitions().map(shape);
    expect(
      definitions(undefined, 'multi').map(shape).slice(0, single.length),
    ).toEqual(single);
  });

  test('work_delegate is always loaded and work_delegations is read-only', () => {
    const tools = definitions(undefined, 'multi');
    const find = (name: string) => tools.find((tool) => tool.name === name)!;
    expect(find('work_delegate')._meta?.['anthropic/alwaysLoad']).toBe(true);
    expect(find('work_delegations').annotations?.readOnlyHint).toBe(true);
    for (const name of ['work_stop', 'work_followup']) {
      expect(find(name)._meta?.['anthropic/alwaysLoad']).toBeUndefined();
      expect(find(name).annotations?.readOnlyHint).toBeUndefined();
    }
  });

  test("a delegated item's worker swaps the withheld tools for work_report alone", () => {
    const plain = names();
    expect(names(DELEGATED)).toEqual([
      ...plain.filter((name) => !WITHHELD_TOOLS.includes(name)),
      'work_report',
    ]);
  });

  test("a delegated item's worker, writable, only loses AskUserQuestion", () => {
    expect(teamDisallowedTools(DELEGATED)).toEqual(['AskUserQuestion']);
  });
});

describe('delegation tools over IPC', () => {
  test('work_delegate sends the task with the input turn current when it is called', async () => {
    const env = await setup(undefined, 'multi');
    env.ctx.currentInputTurnId = 'turn-2';
    const { request, result } = await exchange(
      env,
      'work_delegate',
      {
        title: ' Run the full test suite ',
        task: 'Run make test and fix what fails.',
        context: 'The owner wants it green before Friday.',
        files: ['src/a.ts', 'tests/a.test.ts'],
      },
      { ok: true, data: { workItemId: 'item-9', seq: 3 } },
    );
    expect(body(request)).toEqual({
      type: 'work_delegate',
      title: 'Run the full test suite',
      task: 'Run make test and fix what fails.',
      context: 'The owner wants it green before Friday.',
      files: ['src/a.ts', 'tests/a.test.ts'],
      inputTurnId: 'turn-2',
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(
      '已派出 #3「Run the full test suite」（id: item-9）。结果会作为 <work_report> 输入自动回到本会话，不要等待或轮询。简短告诉用户已交给后台，然后结束本轮。',
    );
  });

  test('work_delegate leaves out empty context and files, and names no turn when there is none', async () => {
    const env = await setup(undefined, 'multi');
    env.ctx.currentInputTurnId = null;
    const { request } = await exchange(
      env,
      'work_delegate',
      { title: 't', task: 'x', context: '  ', files: [] },
      { ok: true, data: { workItemId: 'item-9', seq: 3 } },
    );
    expect(body(request)).toEqual({
      type: 'work_delegate',
      title: 't',
      task: 'x',
      inputTurnId: null,
    });
  });

  test('work_delegate refuses what is over a limit before sending anything', async () => {
    const env = await setup(undefined, 'multi');
    const valid = { title: 't', task: 'x' };
    for (const args of [
      { ...valid, title: 'x'.repeat(61) },
      { ...valid, title: '   ' },
      { ...valid, task: 'x'.repeat(8001) },
      { ...valid, context: 'x'.repeat(8001) },
      { ...valid, files: Array.from({ length: 51 }, (_, i) => `f${i}`) },
      { ...valid, files: [''] },
      { ...valid, plan: 'y' },
    ]) {
      const result = await env.client.callTool({
        name: 'work_delegate',
        arguments: args,
      });
      expect(result.isError, JSON.stringify(args).slice(0, 80)).toBe(true);
    }
    expect(requestFiles(env.tasksDir)).toEqual([]);
  });

  test("work_delegate relays the host's refusal as it is", async () => {
    const env = await setup(undefined, 'multi');
    const refusal =
      '当前工作区是单任务模式，不能派出后台任务；请在当前会话里完成。';
    const { result } = await exchange(
      env,
      'work_delegate',
      { title: 't', task: 'x' },
      { ok: false, error: refusal },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(refusal);
  });

  test('work_delegations sends nothing but its type and lists the items', async () => {
    const env = await setup(undefined, 'multi');
    const { request, result } = await exchange(
      env,
      'work_delegations',
      {},
      {
        ok: true,
        data: [
          {
            workItemId: 'item-9',
            seq: 3,
            title: 'Run the full test suite',
            stage: 'answer',
            lastReport: 'blocked',
            lastSummary: 'Skip the flaky e2e test?',
            createdAt: '2026-11-04T01:00:00.000Z',
          },
          {
            workItemId: 'item-8',
            seq: 2,
            title: 'Rename files',
            stage: 'working',
            lastReport: null,
            lastSummary: null,
            createdAt: '2026-11-04T00:00:00.000Z',
          },
        ],
      },
    );
    expect(body(request)).toEqual({ type: 'work_delegations' });
    expect(textOf(result)).toBe(
      [
        '- #3 Run the full test suite · id: item-9 · 等用户回答 · 最近回报: blocked · 派出于 2026-11-04T01:00:00.000Z · 摘要: Skip the flaky e2e test?',
        '- #2 Rename files · id: item-8 · 进行中 · 最近回报: 无 · 派出于 2026-11-04T00:00:00.000Z',
      ].join('\n'),
    );
    const empty = await exchange(
      env,
      'work_delegations',
      {},
      { ok: true, data: [] },
    );
    expect(textOf(empty.result)).toBe('本会话没有进行中的后台任务。');
  });

  test('work_stop and work_followup send the item and message as given', async () => {
    const env = await setup(undefined, 'multi');
    const stop = await exchange(
      env,
      'work_stop',
      { item: '#3' },
      { ok: true, data: {} },
    );
    expect(body(stop.request)).toEqual({ type: 'work_stop', item: '#3' });
    expect(textOf(stop.result)).toBe('已停止 #3。');

    const followup = await exchange(
      env,
      'work_followup',
      { item: 'item-9', message: 'Skip it.' },
      { ok: true, data: {} },
    );
    expect(body(followup.request)).toEqual({
      type: 'work_followup',
      item: 'item-9',
      message: 'Skip it.',
    });
    expect(textOf(followup.result)).toBe(
      '已转给 item-9 的 Worker。它的回报会作为 <work_report> 输入回到本会话。',
    );

    const tooLong = await env.client.callTool({
      name: 'work_followup',
      arguments: { item: '#3', message: 'x'.repeat(4001) },
    });
    expect(tooLong.isError).toBe(true);
    expect(requestFiles(env.tasksDir)).toEqual([]);
  });

  test('a timeout says whether a write may have taken effect', async () => {
    const tools = createDelegationTools(
      async () => {
        throw new Error('IPC result timeout');
      },
      () => 'turn-1',
    );
    const run = (name: string, args: Record<string, unknown>) =>
      tools.find((tool) => tool.name === name)!.handler(args, {});
    expect(await run('work_delegations', {})).toEqual({
      content: [{ type: 'text', text: '等待宿主响应超时，请稍后再试。' }],
      isError: true,
    });
    expect(await run('work_delegate', { title: 't', task: 'x' })).toEqual({
      content: [
        {
          type: 'text',
          text: '等待宿主确认超时：work_delegate 可能已经生效。先用 work_delegations 核实，不要直接重试。',
        },
      ],
      isError: true,
    });
  });
});

describe("a delegated item's worker over IPC", () => {
  test('work_report sends state and summary and says what follows', async () => {
    const env = await setup(DELEGATED);
    const replies: Record<string, string> = {
      progress: '已记录。',
      ready: '已回报，任务已结束。结束本轮。',
      blocked: '已回报。结束本轮，回答会作为 <work_followup> 输入回来。',
      failed: '已回报，任务已结束。结束本轮。',
    };
    for (const [state, reply] of Object.entries(replies)) {
      const { request, result } = await exchange(
        env,
        'work_report',
        { state, summary: ` ${state} summary ` },
        { ok: true, data: {} },
      );
      expect(body(request)).toEqual({
        type: 'work_report',
        state,
        summary: `${state} summary`,
      });
      expect(textOf(result)).toBe(reply);
    }
  });

  test('work_report accepts only the delegated states and no question fields', async () => {
    const env = await setup(DELEGATED);
    const listed = await env.client.listTools();
    const schema = listed.tools.find((tool) => tool.name === 'work_report')!
      .inputSchema as {
      additionalProperties?: unknown;
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(['state', 'summary']);
    expect(schema.properties.state.enum).toEqual([
      'progress',
      'ready',
      'blocked',
      'failed',
    ]);
    for (const args of [
      { state: 'waiting', summary: 'x' },
      { state: 'dropped', summary: 'x' },
      { state: 'blocked', summary: 'x', humanAction: 'Which one?' },
    ]) {
      const result = await env.client.callTool({
        name: 'work_report',
        arguments: args,
      });
      expect(result.isError).toBe(true);
    }
    expect(requestFiles(env.tasksDir)).toEqual([]);
  });
});
