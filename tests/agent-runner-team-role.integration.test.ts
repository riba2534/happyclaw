import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import type { TeamRole } from '../container/agent-runner/src/work-items.js';

/**
 * Starts the real Agent Runner (tsx, bundled Claude Code CLI, real SDK) with
 * each team role, and as a multi-task workspace's conversation, and reads the
 * first main-loop request it sends to a local fake Anthropic endpoint: the
 * tools the model is offered and the system prompt it gets, exactly as
 * upstream would see them.
 */

const repoRoot = process.cwd();
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const runnerEntry = path.join(
  repoRoot,
  'container',
  'agent-runner',
  'src',
  'index.ts',
);
const MODEL = 'claude-sonnet-4-5-20250929';
const scratchRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-team-role-'),
);

interface MainRequest {
  system: string;
  tools: string[];
  messages: string;
}

function systemText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map((block) =>
      block && typeof block === 'object' && 'text' in block
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .join('\n');
}

function runnerEnv(
  baseUrl: string,
  dirs: { group: string; ipc: string; config: string; home: string },
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        !entry[0].startsWith('HAPPYCLAW_') &&
        !entry[0].startsWith('ANTHROPIC_') &&
        !['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'].includes(entry[0]),
    ),
  );
  return {
    ...env,
    HAPPYCLAW_WORKSPACE_GROUP: dirs.group,
    HAPPYCLAW_WORKSPACE_IPC: dirs.ipc,
    HAPPYCLAW_REQUIRE_BUNDLED_CLAUDE: '1',
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: 'fake-local-runner-token',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: MODEL,
    CLAUDE_CONFIG_DIR: dirs.config,
    HOME: dirs.home,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

/** Answer Workspace Memory snapshot requests at once; drop everything else. */
function answerMemoryRequests(tasksDir: string): void {
  for (const name of fs.readdirSync(tasksDir)) {
    if (!name.endsWith('.json') || name.includes('_result_')) continue;
    const file = path.join(tasksDir, name);
    let request: { type?: string; requestId?: string };
    try {
      request = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    fs.rmSync(file, { force: true });
    if (request.type !== 'workspace_memory' || !request.requestId) continue;
    fs.writeFileSync(
      path.join(tasksDir, `workspace_memory_result_${request.requestId}.json`),
      JSON.stringify({ success: false, error: 'no memory store in test' }),
    );
  }
}

/** The first main-loop request of a runner started with `teamRole`. */
async function firstMainRequest(
  name: string,
  teamRole: TeamRole | undefined,
  workMode?: 'multi',
): Promise<MainRequest> {
  const scratch = path.join(scratchRoot, name);
  const dirs = {
    group: path.join(scratch, 'group'),
    ipc: path.join(scratch, 'ipc'),
    config: path.join(scratch, 'claude-config'),
    home: path.join(scratch, 'home'),
  };
  const inputDir = path.join(dirs.ipc, 'input');
  const tasksDir = path.join(dirs.ipc, 'tasks');
  for (const dir of [dirs.group, inputDir, tasksDir, dirs.config, dirs.home]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  let captured: MainRequest | undefined;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      let body: {
        system?: unknown;
        tools?: Array<{ name: string }>;
        messages?: unknown;
      } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // Not a message request.
      }
      // The main loop offers Bash; a side query may carry only Skill.
      if (
        !captured &&
        Array.isArray(body.tools) &&
        body.tools.some((tool) => tool.name === 'Bash')
      ) {
        captured = {
          system: systemText(body.system),
          tools: body.tools.map((tool) => tool.name),
          messages: JSON.stringify(body.messages ?? []),
        };
        fs.writeFileSync(path.join(inputDir, '_close'), '');
      }
      // Fail every call: only the request matters, and the runner exits.
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');

  const child = spawn(tsxBin, [runnerEntry], {
    cwd: repoRoot,
    env: runnerEnv(`http://127.0.0.1:${address.port}`, dirs),
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  const memoryResponder = setInterval(() => answerMemoryRequests(tasksDir), 20);
  const killGuard = setTimeout(() => child.kill('SIGKILL'), 50_000);
  child.stdin.end(
    JSON.stringify({
      prompt: 'Cold start.',
      groupFolder: 'team-role',
      chatJid: 'web:team-role',
      turnId: 'cold-turn-1',
      queryRunId: 'query-run-1',
      isHome: false,
      isAdminHome: false,
      interactionMode: 'proactive',
      // A Feishu input, so the plain session gets the channel's format note.
      channelContext: {
        schemaVersion: 1,
        provider: 'feishu',
        sourceJid: 'feishu:oc_team_role',
      },
      ...(teamRole ? { teamRole } : {}),
      ...(workMode ? { workMode } : {}),
    }),
  );
  await new Promise((resolve) => child.once('close', resolve));
  clearTimeout(killGuard);
  clearInterval(memoryResponder);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!captured) throw new Error(`${name}: the runner sent no main request`);
  return captured;
}

const ROUTER_TOOLS = ['work_route', 'work_reply', 'work_list'].map(
  (name) => `mcp__happyclaw__${name}`,
);
const WORKER_TOOLS = ['work_report', 'work_ack', 'work_handback'].map(
  (name) => `mcp__happyclaw__${name}`,
);
const FILE_EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
/** Tools that post to the chat directly; a team session has none of them. */
const POSTING_TOOLS = [
  'send_message',
  'send_image',
  'send_file',
  'feishu_send_card',
  'feishu_api_request',
].map((name) => `mcp__happyclaw__${name}`);
/**
 * Automations would freeze the group as their route; the session (not Home)
 * has no skill install tools to withhold.
 */
const AUTOMATION_TOOLS = [
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
].map((name) => `mcp__happyclaw__${name}`);

const DELEGATION_TOOLS = [
  'work_delegate',
  'work_delegations',
  'work_stop',
  'work_followup',
].map((name) => `mcp__happyclaw__${name}`);

const promptsDir = path.join(repoRoot, 'container', 'agent-runner', 'prompts');
/** A prompt file as the PromptPlan wraps it. */
const block = (tag: string, file: string) =>
  `<${tag}>\n${fs.readFileSync(path.join(promptsDir, file), 'utf8').trimEnd()}\n</${tag}>`;

const runs: Record<string, MainRequest> = {};

beforeAll(async () => {
  const [plain, router, writer, reader, multi, delegated] = await Promise.all([
    firstMainRequest('plain', undefined),
    firstMainRequest('router', { role: 'router' }),
    firstMainRequest('worker-writable', {
      role: 'worker',
      workItemId: 'item-1',
      writable: true,
    }),
    firstMainRequest('worker-read-only', {
      role: 'worker',
      workItemId: 'item-2',
      writable: false,
    }),
    firstMainRequest('multi', undefined, 'multi'),
    firstMainRequest('worker-delegated', {
      role: 'worker',
      workItemId: 'item-3',
      writable: true,
      origin: 'delegated',
    }),
  ]);
  Object.assign(runs, {
    plain,
    router,
    writer,
    reader,
    multi,
    delegated,
  });
}, 90_000);

afterAll(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

/** The tools a role adds to and removes from the session without one. */
function toolDelta(run: MainRequest) {
  const before = new Set(runs.plain.tools);
  const after = new Set(run.tools);
  return {
    added: run.tools.filter((name) => !before.has(name)).sort(),
    removed: runs.plain.tools.filter((name) => !after.has(name)).sort(),
  };
}

describe('Agent Runner team roles, as the model sees them', () => {
  test('without a role the session keeps send_message, AskUserQuestion, the edit tools and the delivery contract', () => {
    expect(runs.plain.tools).toEqual(
      expect.arrayContaining([
        'mcp__happyclaw__send_message',
        'AskUserQuestion',
        ...FILE_EDIT_TOOLS,
      ]),
    );
    expect(runs.plain.tools.some((name) => name.includes('work_'))).toBe(false);
    expect(runs.plain.system).toContain('<delivery-contract>');
    expect(runs.plain.system).not.toContain('<team-');
  });

  test('the router routes and replies: work tools in, send_message, AskUserQuestion and edits out', () => {
    expect(toolDelta(runs.router)).toEqual({
      added: [...ROUTER_TOOLS].sort(),
      removed: [
        'AskUserQuestion',
        ...FILE_EDIT_TOOLS,
        ...POSTING_TOOLS,
        ...AUTOMATION_TOOLS,
      ].sort(),
    });
  });

  test('a writable worker keeps its edit tools and loses only send_message and AskUserQuestion', () => {
    expect(toolDelta(runs.writer)).toEqual({
      added: [...WORKER_TOOLS].sort(),
      removed: [
        'AskUserQuestion',
        ...POSTING_TOOLS,
        ...AUTOMATION_TOOLS,
      ].sort(),
    });
  });

  test('a read-only worker also runs without the edit tools', () => {
    expect(toolDelta(runs.reader)).toEqual({
      added: [...WORKER_TOOLS].sort(),
      removed: [
        'AskUserQuestion',
        ...FILE_EDIT_TOOLS,
        ...POSTING_TOOLS,
        ...AUTOMATION_TOOLS,
      ].sort(),
    });
  });

  test('each role gets its own section and no guidance built on send_message', () => {
    expect(runs.plain.system).toContain('<background-tasks>');
    expect(runs.plain.messages).toContain(
      '<channel_format provider=\\"feishu\\">',
    );
    for (const [run, own, other] of [
      [runs.router, 'team-router', 'team-worker'],
      [runs.writer, 'team-worker', 'team-router'],
      [runs.reader, 'team-worker', 'team-router'],
    ] as const) {
      expect(run.system).toContain(`<${own}>`);
      expect(run.system).not.toContain(`<${other}>`);
      expect(run.system).not.toContain('<output-contract>');
      expect(run.system).not.toContain('<delivery-contract>');
      // The background guidance is the team version.
      expect(run.system).toContain('<background-tasks>');
      expect(run.system).toContain('mcp__happyclaw__work_report');
      for (const tool of POSTING_TOOLS) {
        expect(run.system).not.toContain(tool.replace('mcp__happyclaw__', ''));
      }
      // The channel note points at send_image/send_file; a team role has neither.
      expect(run.messages).not.toContain('<channel_format');
      // Everything ahead of the team section is the session without a role.
      const prefix = run.system.slice(0, run.system.indexOf(`<${own}>`));
      expect(runs.plain.system.startsWith(prefix)).toBe(true);
    }
  });
});

describe('Agent Runner multi-task mode, as the model sees it', () => {
  test('a multi-task conversation adds the delegation tools and removes nothing', () => {
    expect(toolDelta(runs.multi)).toEqual({
      added: [...DELEGATION_TOOLS].sort(),
      removed: [],
    });
  });

  test('its only prompt change is the background-task guidance', () => {
    const single = block('background-tasks', 'background-tasks.md');
    const multi = block('background-tasks', 'background-tasks.multi.md');
    expect(runs.plain.system).toContain(single);
    expect(runs.multi.system).toBe(runs.plain.system.replace(single, multi));
  });

  test("a delegated item's worker only reports, and loses what a team worker loses", () => {
    expect(toolDelta(runs.delegated)).toEqual({
      added: ['mcp__happyclaw__work_report'],
      removed: [
        'AskUserQuestion',
        ...POSTING_TOOLS,
        ...AUTOMATION_TOOLS,
      ].sort(),
    });
  });

  test('it gets the delegated worker section and background guidance, nothing built on send_message', () => {
    const run = runs.delegated;
    expect(run.system).toContain(
      block('delegated-worker', 'delegated-worker.md'),
    );
    expect(run.system).toContain(
      block('background-tasks', 'background-tasks.delegated.md'),
    );
    for (const tag of [
      '<team-router>',
      '<team-worker>',
      '<output-contract>',
      '<delivery-contract>',
    ]) {
      expect(run.system).not.toContain(tag);
    }
    expect(run.messages).not.toContain('<channel_format');
    // Everything ahead of its section is the session without a role.
    const prefix = run.system.slice(
      0,
      run.system.indexOf('<delegated-worker>'),
    );
    expect(runs.plain.system.startsWith(prefix)).toBe(true);
  });
});
