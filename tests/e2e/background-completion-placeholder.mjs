#!/usr/bin/env node
// E2E: merged background-task completions must not surface as empty results.
//
// Since Claude Code 2.1.274 / claude-agent-sdk 0.3.274, completions that are
// already queued share one model call. Each still gets its own `result`, but
// every one except the last is an empty placeholder (`num_turns: 0`,
// `origin.kind: 'task-notification'`). The runner used to treat such a
// placeholder as a completion candidate held back only by a 100ms quiet
// period, so any delay before the shared call (here a 1s UserPromptSubmit
// hook, as a workspace or plugin may configure) published an extra
// `success` frame with `result: null`, `inputTurnCompleted` and `queryIdle`.
//
// Scenario: the main turn starts two background Bash commands that finish
// while its reply is still streaming, so both notifications are queued and
// answered together after the turn ends.
//
// Not part of `npm test`: it needs the built runner and takes ~25s.
//
// Usage:
//   npm --prefix container/agent-runner run build
//   node tests/e2e/background-completion-placeholder.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const RUNNER = path.join(
  REPO_ROOT,
  'container',
  'agent-runner',
  'dist',
  'index.js',
);
const START = '---HAPPYCLAW_OUTPUT_START---';
const END = '---HAPPYCLAW_OUTPUT_END---';
const BACKGROUND_TASKS = 2;

function sendMessage(res, blocks, stopReason) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const write = (data) =>
    res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  write({
    type: 'message_start',
    message: {
      id: `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      type: 'message',
      role: 'assistant',
      model: 'stub-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  blocks.forEach((block, index) => {
    const isText = block.type === 'text';
    write({
      type: 'content_block_start',
      index,
      content_block: isText
        ? { type: 'text', text: '' }
        : { type: 'tool_use', id: block.id, name: block.name, input: {} },
    });
    write({
      type: 'content_block_delta',
      index,
      delta: isText
        ? { type: 'text_delta', text: block.text }
        : {
            type: 'input_json_delta',
            partial_json: JSON.stringify(block.input),
          },
    });
    write({ type: 'content_block_stop', index });
  });
  write({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  write({ type: 'message_stop' });
  res.end();
}

function startStub() {
  let mainCalls = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (
        req.url.includes('/count_tokens') ||
        !req.url.includes('/v1/messages')
      ) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ input_tokens: 1 }));
      }
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* answer it as an auxiliary call */
      }
      // Auxiliary CLI calls carry no tool list; only the main loop is scripted.
      if (!Array.isArray(body.tools) || body.tools.length === 0) {
        return sendMessage(res, [{ type: 'text', text: 'aux' }], 'end_turn');
      }
      mainCalls += 1;
      if (mainCalls === 1) {
        return sendMessage(
          res,
          Array.from({ length: BACKGROUND_TASKS }, (_, index) => ({
            type: 'tool_use',
            id: `toolu_background_${index}`,
            name: 'Bash',
            input: {
              command: `sleep 1; echo BACKGROUND_${index}_DONE`,
              description: `background ${index}`,
              run_in_background: true,
            },
          })),
          'tool_use',
        );
      }
      if (mainCalls === 2) {
        // Both commands finish while this reply is pending, so their
        // notifications are queued behind the turn and merged afterwards.
        setTimeout(
          () =>
            sendMessage(
              res,
              [{ type: 'text', text: 'BACKGROUND_STARTED' }],
              'end_turn',
            ),
          3_000,
        );
        return;
      }
      return sendMessage(
        res,
        [{ type: 'text', text: `BACKGROUND_SUMMARY_${mainCalls}` }],
        'end_turn',
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: server.address().port }),
    ),
  );
}

function parseFrames(buf) {
  const out = [];
  for (let i = 0; ; ) {
    const s = buf.indexOf(START, i);
    if (s === -1) break;
    const e = buf.indexOf(END, s);
    if (e === -1) break;
    try {
      out.push(JSON.parse(buf.slice(s + START.length, e).trim()));
    } catch {
      /* ignore an unparsable frame */
    }
    i = e + END.length;
  }
  return out;
}

if (!fs.existsSync(RUNNER)) {
  console.error(
    `agent-runner is not built: ${RUNNER}\nRun: npm --prefix container/agent-runner run build`,
  );
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-bg-placeholder-e2e-'));
const ipcDir = path.join(tmp, 'ipc');
const workDir = path.join(tmp, 'workspace');
const configDir = path.join(tmp, 'claude-config');
fs.mkdirSync(ipcDir, { recursive: true });
fs.mkdirSync(path.join(workDir, '.claude'), { recursive: true });
fs.mkdirSync(configDir, { recursive: true });
// A slow prompt hook holds the CLI between the placeholder and the shared call.
fs.writeFileSync(
  path.join(workDir, '.claude', 'settings.json'),
  JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'sleep 1' }] }],
    },
  }),
);

const stub = await startStub();
const env = { ...process.env };
for (const k of Object.keys(env)) {
  if (/^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|VERTEX_)/.test(k)) delete env[k];
}
env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${stub.port}`;
env.ANTHROPIC_API_KEY = 'stub-key-not-a-real-credential';
env.ANTHROPIC_MODEL = 'stub-model';
env.CLAUDE_CONFIG_DIR = configDir;
env.HAPPYCLAW_WORKSPACE_IPC = ipcDir;
env.HAPPYCLAW_WORKSPACE_GROUP = workDir;
env.HAPPYCLAW_REQUIRE_BUNDLED_CLAUDE = '1';
env.HAPPYCLAW_AGENT_RUNNER_MODE = 'development';

const child = spawn(process.execPath, [RUNNER], {
  cwd: workDir,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => (stdout += d));
child.stderr.on('data', (d) => (stderr += d));
child.stdin.end(
  JSON.stringify({
    prompt: 'start two background jobs',
    groupFolder: 'hc-bg-placeholder',
    chatJid: 'web:hc-bg-placeholder',
    isMain: false,
    isHome: false,
    isAdminHome: false,
    turnId: 'bg-placeholder-turn',
  }),
);

// A healthy runner parks waiting for the next IPC message after the summary.
const finished = (frames) =>
  frames.some(
    (f) =>
      f.status === 'success' &&
      typeof f.result === 'string' &&
      f.result.startsWith('BACKGROUND_SUMMARY_'),
  );
const deadline = Date.now() + 45_000;
while (Date.now() < deadline && !finished(parseFrames(stdout))) {
  await new Promise((r) => setTimeout(r, 250));
}
// Leave room for a late frame that a regression would publish afterwards.
await new Promise((r) => setTimeout(r, 2_000));
child.kill('SIGKILL');
await new Promise((r) => child.on('exit', r));
stub.server.close();
fs.rmSync(tmp, { recursive: true, force: true });

const results = parseFrames(stdout).filter((f) => f.status === 'success');
for (const f of results) {
  console.log(
    `success result=${JSON.stringify(f.result)} inputTurnCompleted=${f.inputTurnCompleted} queryIdle=${f.queryIdle}`,
  );
}
const empty = results.filter((f) => !f.result?.trim());
const summaries = results.filter((f) =>
  f.result?.startsWith('BACKGROUND_SUMMARY_'),
);
const ok = empty.length === 0 && summaries.length === 1;
if (!ok) console.error(`runner stderr (tail):\n${stderr.slice(-3000)}`);
console.log(
  `\n${ok ? 'PASS' : 'FAIL'}  empty success frames=${empty.length}  summaries=${summaries.length} (expected 0 and 1)`,
);
process.exit(ok ? 0 : 1);
