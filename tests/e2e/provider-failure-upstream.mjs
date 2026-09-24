#!/usr/bin/env node
// E2E: what the agent runner actually decides for each upstream failure mode.
//
// Why this exists
// ---------------
// The provider failure classification is a claim about upstream behaviour:
// that an overloaded/server error arrives as an SDK assistant error, that a
// bad model name is distinguishable from a quota wall, and so on. Unit tests
// can only check the classifier against inputs we invented. This harness
// checks the inputs themselves, by standing up a fake Anthropic-compatible
// endpoint and running the real runner against it.
//
// It also showed that a 401 and a 429 may be retried silently by the Claude CLI
// until the liveness watchdog fires. The host therefore cannot infer an
// account verdict from repetition: a healthy account behind a stalled gateway
// is observationally identical and must not be quarantined without evidence.
//
// Not part of `npm test`: it needs the built runner and the stall scenarios
// each burn the full 60s liveness deadline.
//
// Usage:
//   npm run build            # or: npm --prefix container/agent-runner run build
//   node tests/e2e/provider-failure-upstream.mjs            # every scenario
//   node tests/e2e/provider-failure-upstream.mjs fast       # skip the 60s ones
//   node tests/e2e/provider-failure-upstream.mjs http:404 hang
//
// Exit code is non-zero if any scenario deviates from its expectation.

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
const MODEL = 'stub-model';

// Measured on Claude Code 2.1.238 and unchanged on 2.1.280. `expect` is the
// providerFailureClass the runner must report; null means the turn has to
// succeed normally.
const SCENARIOS = [
  { mode: 'ok', expect: null, slow: false, note: 'healthy turn' },
  {
    mode: 'http:404',
    expect: 'config',
    slow: false,
    note: 'unservable model name',
  },
  {
    mode: 'hang',
    expect: 'transient',
    slow: true,
    note: 'upstream never responds',
  },
  { mode: 'http:529', expect: 'transient', slow: true, note: 'overloaded' },
  { mode: 'http:500', expect: 'transient', slow: true, note: 'server error' },
  // 401/429 are NOT account-classified here: the CLI retries them silently, so
  // the runner only ever sees the watchdog and the host keeps them transient.
  {
    mode: 'http:401',
    expect: 'transient',
    slow: true,
    note: 'auth failure, retried by the CLI',
  },
  {
    mode: 'http:429',
    expect: 'transient',
    slow: true,
    note: 'rate limit, retried by the CLI',
  },
];

// ── fake upstream ──────────────────────────────────────────────────────────

function startStub() {
  let mode = 'ok';
  const okEvents = (text) => [
    {
      type: 'message_start',
      message: {
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/__mode' && req.method === 'POST') {
        try {
          mode = JSON.parse(body).mode;
        } catch {
          /* keep previous */
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ mode }));
      }
      // Token counting is CLI housekeeping, not the turn under test — always
      // answer it, or `hang` would stall on the wrong request.
      if (
        req.url.includes('/count_tokens') ||
        !req.url.includes('/v1/messages')
      ) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ input_tokens: 100 }));
      }
      if (mode === 'hang') return; // never respond
      if (mode.startsWith('http:')) {
        const status = Number(mode.split(':')[1] || 500);
        const type =
          status === 529
            ? 'overloaded_error'
            : status === 429
              ? 'rate_limit_error'
              : status === 404
                ? 'not_found_error'
                : status === 401
                  ? 'authentication_error'
                  : 'api_error';
        res.writeHead(status, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            type: 'error',
            error: { type, message: `stub ${status}` },
          }),
        );
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      for (const e of okEvents('STUB_OK'))
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        port: server.address().port,
        setMode: (m) => (mode = m),
      }),
    );
  });
}

// ── runner driver ──────────────────────────────────────────────────────────

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
      /* ignore an unparsable frame; the assertions below only read known ones */
    }
    i = e + END.length;
  }
  return out;
}

async function runScenario({ mode, port, timeoutMs, tmp }) {
  const ipcDir = path.join(tmp, 'ipc');
  const workDir = path.join(tmp, 'workspace');
  fs.mkdirSync(ipcDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  // Inherit the environment the real runner gets (the Claude CLI needs more
  // than PATH/HOME), but strip every real provider credential first so this
  // harness can only ever reach the stub.
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|VERTEX_)/.test(k)) delete env[k];
  }
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  env.ANTHROPIC_API_KEY = 'stub-key-not-a-real-credential';
  env.ANTHROPIC_MODEL = MODEL;
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
      prompt: 'reply with exactly: STUB_PROBE',
      groupFolder: 'hc-stub',
      chatJid: 'web:hc-stub',
      isMain: false,
      isHome: false,
      isAdminHome: false,
      turnId: `stub-${mode.replace(/[^a-z0-9]/gi, '-')}`,
    }),
  );

  const startedAt = Date.now();
  // A healthy runner parks waiting for the next IPC message, so the success
  // case is expected to be killed here rather than to exit on its own.
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  await new Promise((r) => child.on('exit', r));
  clearTimeout(timer);

  const frames = parseFrames(stdout);
  const failure = frames.find((f) => f.providerFailure);
  const answered = frames.find(
    (f) => f.sourceKind === 'sdk_final' && typeof f.result === 'string',
  );
  return {
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
    actual: failure ? (failure.providerFailureClass ?? '(unclassified)') : null,
    livenessTimeout: failure?.providerLivenessTimeout === true,
    answer: answered?.result?.slice(0, 40),
    stderr: stderr.slice(-2000),
  };
}

// ── main ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const selected = argv.includes('fast')
  ? SCENARIOS.filter((s) => !s.slow)
  : argv.length
    ? SCENARIOS.filter((s) => argv.includes(s.mode))
    : SCENARIOS;

if (!fs.existsSync(RUNNER)) {
  console.error(
    `agent-runner is not built: ${RUNNER}\nRun: npm --prefix container/agent-runner run build`,
  );
  process.exit(1);
}
if (!selected.length) {
  console.error(
    `No scenario matched. Known: ${SCENARIOS.map((s) => s.mode).join(', ')}`,
  );
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-provider-e2e-'));
const stub = await startStub();
console.log(`stub upstream on 127.0.0.1:${stub.port}, scratch dir ${tmp}\n`);

let failed = 0;
for (const scenario of selected) {
  stub.setMode(scenario.mode);
  const timeoutMs = scenario.slow ? 95_000 : 40_000;
  const r = await runScenario({
    mode: scenario.mode,
    port: stub.port,
    timeoutMs,
    tmp,
  });
  const ok =
    scenario.expect === null
      ? r.actual === null && r.answer === 'STUB_OK'
      : r.actual === scenario.expect;
  if (!ok) failed += 1;
  const detail =
    scenario.expect === null
      ? `answer=${JSON.stringify(r.answer)}`
      : `class=${r.actual}${r.livenessTimeout ? ' +livenessTimeout' : ''}`;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${scenario.mode.padEnd(12)} ${String(r.elapsedSec).padStart(3)}s  ` +
      `expect=${scenario.expect ?? 'no failure'}  ${detail}  (${scenario.note})`,
  );
  if (!ok && r.stderr) {
    console.error(`runner stderr (${scenario.mode}):\n${r.stderr}`);
  }
}

stub.server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(
  `\n${selected.length - failed}/${selected.length} scenarios matched expectation`,
);
process.exit(failed ? 1 : 0);
