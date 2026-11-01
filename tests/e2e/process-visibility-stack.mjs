#!/usr/bin/env node
// E2E: process visibility, reconnect snapshots and persisted turn traces, over
// the whole stack.
//
// A real HappyClaw server (scratch cwd, data directory and HOME), the real host
// Runner and Claude CLI, and real WebSocket clients, against a scripted
// Anthropic upstream: thinking -> Bash tool call -> thinking -> answer (or, in a
// proactive workspace, a send_message call). No real model, no credentials,
// nothing outside the scratch directory; every real provider variable is
// removed from the environment first.
//
// What it proves that unit tests cannot: the events the Web is actually sent
// for each interaction mode and process visibility (the privacy gate: a
// proactive workspace never streams answer text, `hidden` shows only the run
// lifecycle, `activity` strips tool output and reasoning, `full` adds the
// reasoning and the narration written before a tool call, never the text that
// ends a turn; every level shows the progress a proactive Agent sent), what a
// reconnecting client is handed mid-run, what is stored for a settled turn and
// who may read it, and that a client that was handed the proactive reply
// mid-turn is told when its trace is stored.
//
// Usage:
//   npm run build:all
//   node tests/e2e/process-visibility-stack.mjs
//
// Exit code is non-zero if any check fails.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const require = createRequire(path.join(REPO, 'package.json'));
const WebSocket = require('ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const NONCE = `N${Date.now().toString(36)}`;
const THINK1 = '**Planning the demo**\n\nI will run one shell command first.';
const THINK2 =
  '**Wrapping up**\n\nThe command finished, so I can report the result.';
const NARRATION = `Let me run the demo command first (${NONCE}).`;
const ANSWER = `DEMO_DONE_${NONCE}`;
const PROACTIVE_TEXT = `DEMO_PROACTIVE_${NONCE}`;
const PROGRESS_TEXT = `DEMO_PROGRESS_${NONCE}`;
const SENTINEL = '<!--HAPPYCLAW_PROACTIVE_FINAL_DELIVERED-->';
const CLOSING_THOUGHT =
  '**Nothing more**\n\nThe reply is sent; the turn can end.';
const MODEL = 'stub-model';

const results = [];
function check(scenario, name, ok, detail = '') {
  results.push({ scenario, name, ok: !!ok, detail });
  console.log(
    `${ok ? '  PASS' : '  FAIL'}  ${name}${ok || !detail ? '' : `  -> ${detail}`}`,
  );
}

// ── stub upstream ─────────────────────────────────────────────────────────
function chunks(text, n) {
  const out = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out;
}

function messageEvents(blocks, stopReason, n) {
  const ev = [
    {
      type: 'message_start',
      message: {
        id: `msg_stub_${n}`,
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    },
  ];
  blocks.forEach((b, i) => {
    if (b.type === 'thinking') {
      ev.push({
        type: 'content_block_start',
        index: i,
        content_block: { type: 'thinking', thinking: '' },
      });
      for (const c of chunks(b.text, 20))
        ev.push({
          type: 'content_block_delta',
          index: i,
          delta: { type: 'thinking_delta', thinking: c },
        });
      ev.push({
        type: 'content_block_delta',
        index: i,
        delta: { type: 'signature_delta', signature: 'c3R1Yi1zaWduYXR1cmU=' },
      });
      ev.push({ type: 'content_block_stop', index: i });
    } else if (b.type === 'text') {
      ev.push({
        type: 'content_block_start',
        index: i,
        content_block: { type: 'text', text: '' },
      });
      for (const c of chunks(b.text, 12))
        ev.push({
          type: 'content_block_delta',
          index: i,
          delta: { type: 'text_delta', text: c },
        });
      ev.push({ type: 'content_block_stop', index: i });
    } else if (b.type === 'tool_use') {
      ev.push({
        type: 'content_block_start',
        index: i,
        content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} },
      });
      ev.push({
        type: 'content_block_delta',
        index: i,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(b.input),
        },
      });
      ev.push({ type: 'content_block_stop', index: i });
    }
  });
  ev.push({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 24 },
  });
  ev.push({ type: 'message_stop' });
  return ev;
}

function roundOf(messages) {
  let round = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const blocks = Array.isArray(m.content)
      ? m.content
      : [{ type: 'text', text: String(m.content) }];
    if (blocks.some((b) => b.type === 'tool_result')) round++;
    else break;
  }
  return round;
}

function startStub() {
  const state = {
    mode: 'assistant',
    // 'demo': thinking -> Bash. 'facts': three tools at once (Glob, a Bash that
    // fails, Read), to see what the Runner reads out of their results.
    script: 'demo',
    factsFile: '',
    // A proactive turn's last request, after it spoke: a real model takes a
    // moment (and may reason) to decide it is done.
    closingDelayMs: 0,
    // A proactive turn that ends after its work without sending its final.
    skipFinal: false,
    calls: 0,
    agentRequests: 0,
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      if (
        req.url.includes('/count_tokens') ||
        !req.url.includes('/v1/messages')
      ) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ input_tokens: 100 }));
      }
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* keep empty */
      }
      const n = ++state.calls;
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      let blocks;
      let stop = 'end_turn';
      if (!hasTools) {
        blocks = [{ type: 'text', text: 'ok' }]; // background / housekeeping call
      } else {
        state.agentRequests += 1;
        // A proactive demo turn first acknowledges with a progress statement,
        // then goes on as the other scripts do, one round later.
        const acknowledges =
          state.mode === 'proactive' && state.script === 'demo';
        const round = roundOf(body.messages || []) - (acknowledges ? 1 : 0);
        if (round === -1) {
          blocks = [
            {
              type: 'tool_use',
              id: `toolu_progress_${n}`,
              name: 'mcp__happyclaw__send_message',
              input: { text: PROGRESS_TEXT, delivery_role: 'progress' },
            },
          ];
          stop = 'tool_use';
        } else if (round === 0 && state.script === 'facts') {
          blocks = [
            {
              type: 'tool_use',
              id: `toolu_glob_${n}`,
              name: 'Glob',
              input: { pattern: '*' },
            },
            {
              type: 'tool_use',
              id: `toolu_fail_${n}`,
              name: 'Bash',
              input: { command: 'echo partial-out; exit 3' },
            },
            {
              type: 'tool_use',
              id: `toolu_read_${n}`,
              name: 'Read',
              input: { file_path: state.factsFile },
            },
          ];
          stop = 'tool_use';
        } else if (round === 0) {
          blocks = [
            { type: 'thinking', text: THINK1 },
            { type: 'text', text: NARRATION },
            {
              type: 'tool_use',
              id: `toolu_bash_${n}`,
              name: 'Bash',
              input: {
                command: 'sleep 2; echo stub-demo-ok',
                description: 'Demo command',
              },
            },
          ];
          stop = 'tool_use';
        } else if (state.mode === 'assistant') {
          blocks = [
            { type: 'thinking', text: THINK2 },
            { type: 'text', text: ANSWER },
          ];
        } else if (round === 1 && state.skipFinal) {
          blocks = [{ type: 'text', text: SENTINEL }];
        } else if (round === 1) {
          blocks = [
            { type: 'thinking', text: THINK2 },
            {
              type: 'tool_use',
              id: `toolu_send_${n}`,
              name: 'mcp__happyclaw__send_message',
              input: { text: PROACTIVE_TEXT, delivery_role: 'final' },
            },
          ];
          stop = 'tool_use';
        } else if (state.closingDelayMs > 0) {
          await sleep(state.closingDelayMs);
          blocks = [
            { type: 'thinking', text: CLOSING_THOUGHT },
            { type: 'text', text: SENTINEL },
          ];
        } else {
          blocks = [{ type: 'text', text: SENTINEL }];
        }
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      for (const e of messageEvents(blocks, stop, n)) {
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        await sleep(e.type === 'content_block_delta' ? 70 : 10);
      }
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        port: server.address().port,
        setMode: (m) => (state.mode = m),
        setScript: (name) => (state.script = name),
        state,
      }),
    ),
  );
}

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// ── server under test ─────────────────────────────────────────────────────
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-e2e-full-'));
const home = path.join(scratch, 'home');
fs.mkdirSync(path.join(scratch, 'data'), { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.symlinkSync(path.join(REPO, 'container'), path.join(scratch, 'container'));
// The server serves ./web/dist: the browser scenario opens the real Web.
fs.symlinkSync(path.join(REPO, 'web'), path.join(scratch, 'web'));

const stub = await startStub();
const FACTS_TEXT = `alpha-${NONCE}\nbeta\ngamma\n`;
const factsFile = path.join(scratch, 'facts.txt');
fs.writeFileSync(factsFile, FACTS_TEXT);
stub.state.factsFile = factsFile;
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

const env = { ...process.env };
for (const k of Object.keys(env)) {
  if (
    /^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|VERTEX_|HAPPYCLAW_|WEB_|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)/i.test(
      k,
    )
  )
    delete env[k];
}
Object.assign(env, {
  HOME: home,
  WEB_PORT: String(port),
  HAPPYCLAW_SKIP_MIGRATION_BACKUP: '1',
  HAPPYCLAW_REQUIRE_BUNDLED_CLAUDE: '1',
  HAPPYCLAW_AGENT_RUNNER_MODE: 'development',
  LOG_LEVEL: 'info',
});

const serverLog = path.join(scratch, 'server.log');
const logFd = fs.openSync(serverLog, 'w');
const server = spawn(process.execPath, [path.join(REPO, 'dist', 'index.js')], {
  cwd: scratch,
  env,
  detached: true, // own process group: cleanup kills only what we started
  stdio: ['ignore', logFd, logFd],
});
let serverExited = false;
server.on('exit', () => (serverExited = true));

function killTree() {
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

async function http_(method, route, { cookie, body, headers = {} } = {}) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

async function waitForHealth() {
  for (let i = 0; i < 90; i++) {
    if (serverExited)
      throw new Error(
        `server exited early:\n${fs.readFileSync(serverLog, 'utf8').slice(-3000)}`,
      );
    try {
      const r = await http_('GET', '/api/health');
      if (r.status === 200) return;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error('server did not become healthy');
}

function openWs(cookie) {
  const events = [];
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, {
    headers: { Cookie: cookie, Origin: base },
    handshakeTimeout: 30_000,
  });
  ws.on('message', (data) => {
    try {
      events.push({ at: Date.now(), ...JSON.parse(data.toString()) });
    } catch {
      /* ignore non-JSON frames */
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, events, ready };
}

async function waitUntil(pred, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Open a session in a workspace; every Web input names one. */
async function openSession(cookie, jid, name) {
  const r = await http_('POST', `/api/groups/${enc(jid)}/sessions`, {
    cookie,
    body: { name },
  });
  if (r.status >= 300 || !r.json?.session?.id)
    throw new Error(`session: HTTP ${r.status} ${JSON.stringify(r.json)}`);
  const sessionId = r.json.session.id;
  return { jid, sessionId, sessionJid: `${jid}#agent:${sessionId}` };
}

/**
 * A session's events: run lifecycle and snapshots under its JID, everything
 * else under the workspace JID with its agentId.
 */
const ofSession =
  ({ jid, sessionId }) =>
  (e) =>
    e.chatJid === `${jid}#agent:${sessionId}` ||
    (e.chatJid === jid && e.agentId === sessionId);

function sendTo(ws, { jid, sessionId }, content) {
  ws.send(
    JSON.stringify({
      type: 'send_message',
      chatJid: jid,
      agentId: sessionId,
      content,
    }),
  );
}

/** Its stored history, newest page. */
const historyOf = (cookie, { jid, sessionId }) =>
  http_('GET', `/api/groups/${enc(jid)}/messages?agentId=${enc(sessionId)}`, {
    cookie,
  });

/** One settled turn of it; a trace is stored under the session's chat. */
const traceOf = (cookie, { sessionJid }, turnId) =>
  http_('GET', `/api/groups/${enc(sessionJid)}/turn-traces/${enc(turnId)}`, {
    cookie,
  });

// ── scenarios ─────────────────────────────────────────────────────────────
const UNSAFE_TYPES = new Set([
  'text_delta',
  'usage',
  'memory_recall',
  'prompt_suggestion',
  'raw_sdk_event',
]);
/**
 * A frame the Runner wrote for the turn (the host's own `idle` names the
 * input instead): the model's request, its reasoning and its tools.
 */
const isRunnerFrame = (e) =>
  !!e.turnId &&
  (e.eventType.startsWith('thinking_') ||
    e.eventType.startsWith('tool_') ||
    (e.eventType === 'status' && e.statusText === 'requesting'));

const typeCounts = (events) => {
  const counts = {};
  for (const e of events) {
    if (e.type !== 'stream_event') continue;
    const t = e.event?.eventType ?? '?';
    counts[t] = (counts[t] ?? 0) + 1;
  }
  return counts;
};

async function runScenario(ctx, { label, interaction, visibility, expect }) {
  console.log(`\n== ${label}`);
  stub.setMode(interaction);
  const created = await http_('POST', '/api/groups', {
    cookie: ctx.cookie,
    body: {
      name: `${label}-${NONCE}`,
      execution_mode: 'host',
      agent_profile_id: ctx.profileId,
      interaction_mode: interaction,
      ...(visibility ? { process_visibility: visibility } : {}),
    },
  });
  if (created.status >= 300)
    throw new Error(
      `create workspace: HTTP ${created.status} ${JSON.stringify(created.json).slice(0, 300)}`,
    );
  const jid = created.json.jid;
  check(
    label,
    `POST /api/groups echoes process_visibility (${created.json.group?.process_visibility})`,
    created.json.group?.process_visibility === (visibility ?? 'activity'),
    JSON.stringify(created.json.group)?.slice(0, 160),
  );
  if (interaction === 'proactive') {
    const listed = await http_('GET', '/api/groups', { cookie: ctx.cookie });
    const g = listed.json.groups?.[jid];
    check(
      label,
      `GET /api/groups returns process_visibility=${visibility}`,
      g?.process_visibility === visibility,
      `got ${g?.process_visibility}`,
    );
  }

  const session = await openSession(ctx.cookie, jid, label);
  const conn = openWs(ctx.cookie);
  await conn.ready;
  const mine = ofSession(session);
  sendTo(conn.ws, session, 'run the demo');

  // Mid-run reconnect: a second client joins while the Bash tool is running.
  const conn2 = openWs(ctx.cookie);
  await conn2.ready;
  const toolSeen = expect.toolVisible
    ? waitUntil(
        () =>
          conn.events.some(
            (e) =>
              mine(e) &&
              e.event?.eventType === 'tool_use_start' &&
              e.event?.toolName === 'Bash',
          ),
        90_000,
        'the Bash tool_use_start on WS1',
      )
    : waitUntil(
        () =>
          conn.events.some(
            (e) =>
              mine(e) &&
              (interaction === 'proactive'
                ? e.event?.eventType === 'commentary' && e.event?.progress
                : e.type === 'run_started'),
          ),
        90_000,
        'the run (and a proactive turn its progress) on WS1',
      ).then(() => sleep(interaction === 'proactive' ? 300 : 1800));
  await toolSeen;
  if (expect.toolVisible) await sleep(400);
  // A reconnecting client is sent the in-flight state once its socket opens, so
  // open a fresh one now (the first connect above predates the run).
  const conn3 = openWs(ctx.cookie);
  await conn3.ready;
  await sleep(1200);
  const snapshotMsg = conn3.events.find(
    (e) => mine(e) && e.type === 'stream_snapshot',
  );

  await waitUntil(
    () => conn.events.some((e) => mine(e) && e.type === 'run_finished'),
    150_000,
    'run_finished',
  );
  await sleep(1500);
  const live = conn.events.filter(mine);
  const counts = typeCounts(live);
  console.log(`   web-visible stream events: ${JSON.stringify(counts)}`);

  // 0. The context ring follows the turn, and GET reads the same numbers.
  const usageNotices = live.filter((e) => e.type === 'context_usage');
  const lastUsage = usageNotices.at(-1);
  check(
    label,
    'the context ring is told how full the context is after the turn',
    !!lastUsage &&
      lastUsage.usedTokens > 0 &&
      lastUsage.contextWindow > 0 &&
      typeof lastUsage.percentage === 'number' &&
      typeof lastUsage.model === 'string',
    JSON.stringify(usageNotices),
  );
  const usageRead = await http_(
    'GET',
    `/api/groups/${enc(jid)}/context-usage?agentId=${enc(session.sessionId)}`,
    { cookie: ctx.cookie },
  );
  check(
    label,
    'GET context-usage reads what the ring was told',
    usageRead.status === 200 &&
      usageRead.json?.usedTokens === lastUsage?.usedTokens &&
      usageRead.json?.contextWindow === lastUsage?.contextWindow,
    `HTTP ${usageRead.status} ${JSON.stringify(usageRead.json)}`,
  );

  // 1. What the Web may see live.
  const streamEvents = live
    .filter((e) => e.type === 'stream_event')
    .map((e) => e.event);
  for (const t of expect.never) {
    check(
      label,
      `no '${t}' reaches the Web`,
      !streamEvents.some((e) => e.eventType === t),
      `saw ${counts[t]}`,
    );
  }
  for (const t of expect.always) {
    check(
      label,
      `'${t}' reaches the Web`,
      streamEvents.some((e) => e.eventType === t),
      `counts=${JSON.stringify(counts)}`,
    );
  }
  if (expect.onlyLifecycleStatus) {
    const odd = streamEvents.filter(
      (e) =>
        !(e.eventType === 'commentary' && e.progress === true) &&
        (e.eventType !== 'status' ||
          !['requesting', 'idle', 'interrupted'].includes(e.statusText)),
    );
    check(
      label,
      'only requesting/idle/interrupted status and the progress the Agent sent reach the Web',
      odd.length === 0,
      JSON.stringify(odd.slice(0, 2)),
    );
  }
  if (interaction === 'proactive') {
    const sent = streamEvents.filter(
      (e) => e.eventType === 'commentary' && e.progress === true,
    );
    check(
      label,
      'the progress the Agent sent reaches the Web once, whole, at this level',
      sent.length === 1 && sent[0].text === PROGRESS_TEXT,
      JSON.stringify(sent),
    );
    // The card it lands on is the one the turn's own frames build.
    const runnerTurnIds = new Set(
      streamEvents.filter(isRunnerFrame).map((e) => e.turnId),
    );
    check(
      label,
      "and carries the turn id of the Runner's own frames",
      sent.length === 1 &&
        runnerTurnIds.size === 1 &&
        runnerTurnIds.has(sent[0].turnId),
      `${sent[0]?.turnId} vs ${JSON.stringify([...runnerTurnIds])}`,
    );
    check(
      label,
      'and is no chat message: the Web turn keeps it in its process',
      !live.some(
        (e) =>
          e.type === 'new_message' &&
          e.message?.content?.includes(PROGRESS_TEXT),
      ),
      '',
    );
  }
  if (expect.thinkingText) {
    const joined = streamEvents
      .filter((e) => e.eventType === 'thinking_delta' && !e.parentToolUseId)
      .map((e) => e.text)
      .join('');
    check(
      label,
      'streamed thinking text is the model reasoning',
      joined.includes('Planning the demo') && joined.includes('Wrapping up'),
      JSON.stringify(joined.slice(0, 80)),
    );
  }
  const notes = streamEvents.filter(
    (e) => e.eventType === 'commentary' && !e.progress,
  );
  if (expect.narration) {
    const joined = notes.map((e) => e.text).join('\n');
    check(
      label,
      'the narration written before the Bash call reaches the Web whole',
      joined === NARRATION,
      JSON.stringify(joined.slice(0, 100)),
    );
    const noteAt = streamEvents.findIndex((e) => e.eventType === 'commentary');
    const bashAt = streamEvents.findIndex(
      (e) => e.eventType === 'tool_use_start' && e.toolName === 'Bash',
    );
    check(
      label,
      'and arrives ahead of the call it introduces',
      noteAt >= 0 && bashAt > noteAt,
      `commentary at ${noteAt}, Bash at ${bashAt}`,
    );
    const seen = JSON.stringify(streamEvents);
    check(
      label,
      'neither the reply nor the text that ends the turn is ever narration',
      !seen.includes(PROACTIVE_TEXT) &&
        !seen.includes(SENTINEL) &&
        notes.length === 1,
      `commentary events: ${notes.length}`,
    );
  }
  if (expect.stripped) {
    const result = streamEvents.find((e) => e.eventType === 'tool_result');
    const start = streamEvents.find(
      (e) => e.eventType === 'tool_use_start' && e.toolName === 'Bash',
    );
    check(
      label,
      'tool_result carries no output text',
      !!result &&
        result.toolResult === undefined &&
        result.detail === undefined,
      JSON.stringify(result)?.slice(0, 160),
    );
    check(
      label,
      'tool_use_start carries no toolInput (summary kept)',
      !!start && start.toolInput === undefined,
      JSON.stringify(start)?.slice(0, 160),
    );
  }
  if (expect.thinkingTiming) {
    const end = streamEvents.find((e) => e.eventType === 'thinking_end');
    check(
      label,
      'thinking_end reports a duration',
      typeof end?.thinkingDurationMs === 'number' && end.thinkingDurationMs > 0,
      JSON.stringify(end)?.slice(0, 140),
    );
  }
  const answerText = streamEvents
    .filter((e) => e.eventType === 'text_delta' && !e.parentToolUseId)
    .map((e) => e.text)
    .join('');
  if (expect.answerStreamed)
    check(
      label,
      'assistant answer text is streamed',
      answerText.includes(ANSWER),
      JSON.stringify(answerText.slice(0, 80)),
    );

  // 2. Reconnect snapshot.
  const snap = snapshotMsg?.snapshot;
  if (interaction === 'proactive') {
    check(
      label,
      'a reconnecting client is handed the progress the Agent sent, at this level',
      !!snap &&
        Array.isArray(snap.progress) &&
        snap.progress.length === 1 &&
        snap.progress[0].text === PROGRESS_TEXT &&
        typeof snap.progress[0].at === 'number',
      JSON.stringify(snap?.progress),
    );
  }
  if (expect.snapshot === 'progress-only') {
    check(
      label,
      'and nothing else of the process',
      !!snap &&
        (snap.activeTools || []).length === 0 &&
        !snap.thinkingText &&
        !snap.partialText &&
        (snap.traceEvents || []).length === 0,
      JSON.stringify(snap)?.slice(0, 200),
    );
  } else if (expect.snapshot === 'none') {
    check(
      label,
      'no in-flight snapshot is sent to a reconnecting client',
      !snapshotMsg,
      JSON.stringify(snap)?.slice(0, 160),
    );
  } else if (expect.snapshot) {
    check(
      label,
      'a reconnecting client receives the in-flight snapshot',
      !!snap,
      'none received',
    );
    if (snap) {
      check(
        label,
        'snapshot lists the running Bash tool',
        (snap.activeTools || []).some((t) => t.toolName === 'Bash'),
        JSON.stringify(snap.activeTools)?.slice(0, 200),
      );
      check(
        label,
        'snapshot carries the finished thinking duration',
        typeof snap.thinkingDurationMs === 'number' &&
          snap.thinkingDurationMs > 0,
        JSON.stringify({
          d: snap.thinkingDurationMs,
          s: snap.thinkingStartedAt,
          p: snap.phaseStartedAt,
        }),
      );
      if (expect.snapshot === 'thinking')
        check(
          label,
          'snapshot carries the thinking text',
          (snap.thinkingText || '').includes('Planning the demo'),
          JSON.stringify(snap.thinkingText)?.slice(0, 80),
        );
      if (expect.snapshot === 'activity')
        check(
          label,
          'snapshot carries no thinking text',
          !snap.thinkingText,
          JSON.stringify(snap.thinkingText)?.slice(0, 80),
        );
      check(
        label,
        'snapshot never carries answer text in a proactive workspace',
        interaction !== 'proactive' || !snap.partialText,
        JSON.stringify(snap.partialText)?.slice(0, 80),
      );
    }
  }

  // 3. Persisted history + trace.
  const history = await historyOf(ctx.cookie, session);
  const agentMessages = (history.json.messages || []).filter(
    (m) => m.is_from_me,
  );
  const finalMsg =
    interaction === 'assistant'
      ? agentMessages.find(
          (m) => m.source_kind === 'sdk_final' && m.content?.includes(ANSWER),
        )
      : agentMessages.find((m) => m.content?.includes(PROACTIVE_TEXT));
  check(
    label,
    'the reply was delivered and stored',
    !!finalMsg,
    `agent messages: ${JSON.stringify(agentMessages.map((m) => m.content?.slice(0, 40)))}`,
  );
  if (interaction === 'proactive') {
    check(
      label,
      'the progress was stored as no message of its own',
      !agentMessages.some((m) => m.content?.includes(PROGRESS_TEXT)),
      JSON.stringify(agentMessages.map((m) => m.content?.slice(0, 40))),
    );
  }
  // Every frame of the turn names the input it answers, the reply's turn_id:
  // what lets the Web settle the live card in place while the run closes.
  const frames = live.filter((e) => e.type === 'stream_event');
  check(
    label,
    'every stream frame names the input the reply answers',
    frames.length > 0 &&
      frames.every((e) => e.event?.inputTurnId === finalMsg?.turn_id),
    `${JSON.stringify([...new Set(frames.map((e) => e.event?.inputTurnId))])} reply=${finalMsg?.turn_id}`,
  );
  const flagged = agentMessages.filter((m) => m.has_trace === true);
  // A proactive reply is announced mid-turn, before its trace exists: the
  // client is told afterwards which message carries it. An assistant reply
  // carries `has_trace` itself.
  const traceNotices = live.filter(
    (e) => e.type === 'message_trace' && mine(e),
  );
  if (interaction === 'proactive' && expect.trace !== 'none') {
    check(
      label,
      'the client that streamed the turn is told which message carries the trace',
      traceNotices.length === 1 &&
        traceNotices[0].messageId === finalMsg?.id &&
        traceNotices[0].turnId === finalMsg?.turn_id &&
        traceNotices[0].messageChatJid === finalMsg?.chat_jid,
      `notices=${JSON.stringify(traceNotices.map((e) => ({ id: e.messageId, turn: e.turnId })))} message=${finalMsg?.id}/${finalMsg?.turn_id}`,
    );
    const live_ = live.find(
      (e) =>
        e.type === 'new_message' &&
        e.message?.content?.includes(PROACTIVE_TEXT),
    );
    check(
      label,
      'the reply itself was announced without has_trace (it predates its trace)',
      !!live_ && !live_.message.has_trace,
      JSON.stringify(live_?.message?.has_trace),
    );
  } else {
    check(
      label,
      'no trace notice is sent when there is nothing to announce',
      traceNotices.length === 0,
      `got ${traceNotices.length}`,
    );
  }
  let storedTurnId;
  if (expect.trace === 'none') {
    check(
      label,
      'no message is flagged has_trace',
      flagged.length === 0,
      `flagged ${flagged.length}`,
    );
    if (finalMsg?.turn_id) {
      const r = await traceOf(ctx.cookie, session, finalMsg.turn_id);
      check(
        label,
        'turn-traces is 404 while the process is hidden',
        r.status === 404,
        `HTTP ${r.status}`,
      );
    }
  } else {
    check(
      label,
      'the last agent message of the turn is flagged has_trace',
      flagged.length >= 1,
      `flagged ${flagged.length}`,
    );
    const turnId = (flagged[flagged.length - 1] || finalMsg)?.turn_id;
    storedTurnId = turnId;
    const r = await traceOf(ctx.cookie, session, turnId);
    check(
      label,
      'GET turn-traces answers 200',
      r.status === 200,
      `HTTP ${r.status} ${JSON.stringify(r.json)?.slice(0, 160)}`,
    );
    if (r.status === 200 && expect.trace === 'progress-only') {
      const t = r.json;
      check(
        label,
        'the stored turn holds the progress alone: no reasoning, timing or trace rows',
        t.thinking === '' &&
          t.thinking_duration_ms === null &&
          Array.isArray(t.trace) &&
          t.trace.length === 0 &&
          t.steps.length === 1 &&
          t.steps[0].kind === 'text' &&
          t.steps[0].progress === true &&
          t.steps[0].text === PROGRESS_TEXT,
        JSON.stringify(t).slice(0, 400),
      );
    } else if (r.status === 200) {
      const t = r.json;
      if (expect.trace === 'with-thinking') {
        const i1 = t.thinking.indexOf('Planning the demo');
        const i2 = t.thinking.indexOf('Wrapping up');
        check(
          label,
          'stored thinking holds both blocks in order',
          i1 >= 0 && i2 > i1,
          JSON.stringify(t.thinking.slice(0, 120)),
        );
        check(
          label,
          'the two thinking blocks are separated by a blank line',
          /command first\.\s*\n\n\*\*Wrapping up/.test(t.thinking),
          JSON.stringify(t.thinking),
        );
      } else {
        check(
          label,
          'stored thinking text is withheld at the activity level',
          t.thinking === '',
          JSON.stringify(t.thinking?.slice(0, 60)),
        );
      }
      check(
        label,
        'stored thinking duration is recorded',
        typeof t.thinking_duration_ms === 'number' &&
          t.thinking_duration_ms > 0,
        String(t.thinking_duration_ms),
      );
      check(
        label,
        'stored trace lists the Bash tool',
        Array.isArray(t.trace) &&
          t.trace.some((x) => /Bash/.test(x.title || '')),
        JSON.stringify(t.trace)?.slice(0, 200),
      );
      check(
        label,
        "a tool's progress is folded into its own row, as in the live view",
        !t.trace.some((x) => /^工具进度/.test(x.title || '')),
        JSON.stringify(t.trace.map((x) => x.title)),
      );
      const rowsJson = JSON.stringify(t.trace);
      check(
        label,
        'stored trace never holds the model answer text',
        !rowsJson.includes(ANSWER) &&
          !rowsJson.includes(SENTINEL) &&
          !rowsJson.includes(NARRATION),
        '',
      );
      if (interaction === 'proactive')
        check(
          label,
          'a send_message row does not repeat the message it sent',
          !rowsJson.includes(PROACTIVE_TEXT),
          rowsJson.slice(0, 300),
        );
      check(
        label,
        'the trace has no thinking_start/thinking_end rows',
        !t.trace.some((x) => /thinking_(start|end)/.test(JSON.stringify(x))),
        '',
      );
      checkStoredSteps(label, interaction, expect, t);
    }
  }

  for (const c of [conn, conn2, conn3]) c.ws.close();
  return { jid, session, counts, turnId: storedTurnId };
}

/** Every leaf of a value: facts must hold numbers and booleans only. */
function leaves(value) {
  if (value === null || typeof value !== 'object') return [value];
  return Object.values(value).flatMap(leaves);
}

/**
 * What the Runner reads out of the SDK's structured tool results (Glob, a Bash
 * that fails, Read), and what a Workspace lets through: an Assistant Workspace
 * shows the numbers (`toolResultFacts`, and `toolIsError`), a proactive one
 * shows only that a call failed. Either way no path, file text or command
 * output rides in the facts, live or stored.
 */
async function runFactsScenario(ctx, { label, interaction, visibility }) {
  console.log(`\n== ${label}`);
  stub.setMode(interaction);
  stub.setScript('facts');
  const created = await http_('POST', '/api/groups', {
    cookie: ctx.cookie,
    body: {
      name: `${label}-${NONCE}`,
      execution_mode: 'host',
      agent_profile_id: ctx.profileId,
      interaction_mode: interaction,
      ...(visibility ? { process_visibility: visibility } : {}),
    },
  });
  if (created.status >= 300)
    throw new Error(
      `create workspace: HTTP ${created.status} ${JSON.stringify(created.json).slice(0, 300)}`,
    );
  const session = await openSession(ctx.cookie, created.json.jid, label);
  const mine = ofSession(session);
  const conn = openWs(ctx.cookie);
  await conn.ready;
  sendTo(conn.ws, session, 'look');
  await waitUntil(
    () => conn.events.some((e) => mine(e) && e.type === 'run_finished'),
    150_000,
    'run_finished',
  );
  await sleep(1500);
  const live = conn.events.filter(mine);
  const streamEvents = live
    .filter((e) => e.type === 'stream_event')
    .map((e) => e.event);
  stub.setScript('demo');

  const nameOf = new Map(
    streamEvents
      .filter((e) => e.eventType === 'tool_use_start')
      .map((e) => [e.toolUseId, e.toolName]),
  );
  const resultOf = (tool) =>
    streamEvents.find(
      (e) => e.eventType === 'tool_result' && nameOf.get(e.toolUseId) === tool,
    );
  const glob = resultOf('Glob');
  const bash = resultOf('Bash');
  const read = resultOf('Read');
  check(
    label,
    'a tool_result reaches the Web for each of the three tools',
    !!glob && !!bash && !!read,
    JSON.stringify(streamEvents.filter((e) => e.eventType === 'tool_result')),
  );
  const rawLive = JSON.stringify(streamEvents);
  const summaryOf = (tool) =>
    streamEvents.find(
      (e) =>
        (e.eventType === 'tool_use_start' || e.eventType === 'tool_progress') &&
        nameOf.get(e.toolUseId) === tool &&
        e.toolInputSummary,
    )?.toolInputSummary;
  check(
    label,
    'each call is summarized by its file, pattern or command',
    summaryOf('Read') === `file_path: ${factsFile}` &&
      summaryOf('Glob') === 'pattern: *' &&
      /^command: echo partial-out/.test(summaryOf('Bash') || ''),
    JSON.stringify([summaryOf('Read'), summaryOf('Glob'), summaryOf('Bash')]),
  );

  const history = await historyOf(ctx.cookie, session);
  const flagged = (history.json.messages || []).filter(
    (m) => m.is_from_me && m.has_trace === true,
  );
  const turnId = flagged[flagged.length - 1]?.turn_id;
  const trace = await traceOf(ctx.cookie, session, turnId);
  check(
    label,
    'the stored turn is readable',
    trace.status === 200,
    `HTTP ${trace.status}`,
  );
  const steps = trace.json?.steps || [];
  const stepOf = (id) => steps.find((s) => s.toolUseId === id);

  if (interaction === 'assistant') {
    check(
      label,
      'Glob reports the files it found',
      glob?.toolResultFacts?.files >= 1 && glob.toolIsError === false,
      JSON.stringify(glob),
    );
    check(
      label,
      'Read reports the lines it returned',
      read?.toolResultFacts?.lines >= 3 &&
        read.toolResultFacts.totalLines >= 3 &&
        read.toolIsError === false,
      JSON.stringify(read),
    );
    check(
      label,
      'a failed Bash reports toolIsError and its exit code',
      bash?.toolIsError === true && bash.toolResultFacts?.exitCode === 3,
      JSON.stringify(bash),
    );
    check(
      label,
      'the facts hold numbers and booleans only',
      [glob, bash, read].every((e) =>
        leaves(e?.toolResultFacts ?? {}).every(
          (v) => typeof v === 'number' || typeof v === 'boolean',
        ),
      ) && Object.keys(read?.toolResultFacts ?? {}).length > 0,
      JSON.stringify([
        glob?.toolResultFacts,
        bash?.toolResultFacts,
        read?.toolResultFacts,
      ]),
    );
    check(
      label,
      'the stored steps carry the same facts, and the failed call is an error',
      JSON.stringify(stepOf(glob?.toolUseId)?.resultFacts) ===
        JSON.stringify(glob?.toolResultFacts) &&
        JSON.stringify(stepOf(read?.toolUseId)?.resultFacts) ===
          JSON.stringify(read?.toolResultFacts) &&
        stepOf(bash?.toolUseId)?.resultFacts?.exitCode === 3 &&
        stepOf(bash?.toolUseId)?.status === 'error' &&
        stepOf(read?.toolUseId)?.status === 'done',
      JSON.stringify(steps.filter((s) => s.kind === 'tool')).slice(0, 400),
    );
    check(
      label,
      'stored facts never hold the file text',
      !JSON.stringify(steps.map((s) => s.resultFacts)).includes('alpha'),
      '',
    );
  } else {
    check(
      label,
      'no tool_result carries facts or output text; the failure flag stays',
      [glob, bash, read].every(
        (e) =>
          e &&
          !('toolResultFacts' in e) &&
          e.toolResult === undefined &&
          e.detail === undefined,
      ) &&
        bash?.toolIsError === true &&
        glob.toolIsError === false &&
        read.toolIsError === false,
      JSON.stringify([glob, bash, read]),
    );
    check(
      label,
      'nothing the files held reaches the Web',
      !rawLive.includes(`alpha-${NONCE}`),
      '',
    );
    check(
      label,
      'the stored steps keep the failure but hold no facts and no output',
      stepOf(bash?.toolUseId)?.status === 'error' &&
        !JSON.stringify(steps).includes('resultFacts') &&
        !JSON.stringify(steps).includes(`alpha-${NONCE}`) &&
        steps.every((s) => s.resultPreview === undefined),
      JSON.stringify(steps.filter((s) => s.kind === 'tool')).slice(0, 400),
    );
  }
  conn.ws.close();
}

/**
 * The settled turn as an ordered timeline: reasoning -> Bash -> reasoning, with
 * the model's note before the tool in an Assistant workspace, and never the
 * answer, the speech tool or (proactive) any model text but the reasoning.
 */
function checkStoredSteps(label, interaction, expect, t) {
  const steps = Array.isArray(t.steps) ? t.steps : [];
  const describe = (s) => (s.kind === 'tool' ? `tool:${s.toolName}` : s.kind);
  const timeline = steps.filter((s) => s.kind !== 'text').map(describe);
  check(
    label,
    'stored steps run reasoning -> Bash -> reasoning, in the order they happened',
    JSON.stringify(timeline) ===
      JSON.stringify(['thinking', 'tool:Bash', 'thinking']),
    JSON.stringify(steps.map(describe)),
  );
  check(
    label,
    'no step is left running and none was dropped',
    steps.length > 0 &&
      steps.every(
        (s) => s.status === 'done' && typeof s.endedAt === 'number',
      ) &&
      t.steps_dropped === 0,
    JSON.stringify(steps.map((s) => [s.kind, s.status, s.endedAt])),
  );
  check(
    label,
    'steps are in time order and each ends no earlier than it began',
    steps.every(
      (s, i) => s.endedAt >= s.at && (i === 0 || s.at >= steps[i - 1].at),
    ),
    JSON.stringify(steps.map((s) => [s.at, s.endedAt])),
  );
  const thinking = steps.filter((s) => s.kind === 'thinking');
  check(
    label,
    'every reasoning step has a duration',
    thinking.length === 2 &&
      thinking.every(
        (s) => typeof s.durationMs === 'number' && s.durationMs > 0,
      ),
    JSON.stringify(thinking.map((s) => s.durationMs)),
  );
  if (expect.trace === 'with-thinking') {
    check(
      label,
      'reasoning steps hold their text and title',
      /Planning the demo/.test(thinking[0]?.text || '') &&
        thinking[0]?.title === 'Planning the demo' &&
        /Wrapping up/.test(thinking[1]?.text || '') &&
        thinking[1]?.title === 'Wrapping up',
      JSON.stringify(thinking.map((s) => [s.title, s.text?.slice(0, 30)])),
    );
  } else {
    check(
      label,
      'reasoning steps keep their status and times but no text or title at the activity level',
      thinking.every((s) => s.text === undefined && s.title === undefined) &&
        !JSON.stringify(steps).includes('Planning the demo') &&
        !JSON.stringify(steps).includes('Wrapping up'),
      JSON.stringify(thinking),
    );
  }
  const raw = JSON.stringify(steps);
  const bash = steps.find((s) => s.kind === 'tool');
  check(
    label,
    'the Bash step names its call',
    typeof bash?.toolUseId === 'string' && bash.toolUseId.length > 0,
    JSON.stringify(bash),
  );
  check(
    label,
    'steps never hold the answer text',
    !raw.includes(ANSWER) && !raw.includes(SENTINEL),
    raw.slice(0, 300),
  );
  if (interaction === 'assistant') {
    const texts = steps.filter((s) => s.kind === 'text');
    check(
      label,
      'the note written before the tool is a step between the reasoning and the call',
      texts.length === 1 &&
        texts[0].text === NARRATION &&
        steps.indexOf(texts[0]) ===
          steps.findIndex((s) => s.kind === 'tool') - 1,
      JSON.stringify(texts),
    );
  } else {
    const texts = steps.filter((s) => s.kind === 'text');
    check(
      label,
      'a proactive turn keeps only the progress it sent as text, its speech tool is no step and no tool output is kept',
      texts.length === 1 &&
        texts[0].progress === true &&
        texts[0].text === PROGRESS_TEXT &&
        !raw.includes(NARRATION) &&
        !raw.includes(PROACTIVE_TEXT) &&
        !raw.includes('send_message') &&
        bash?.resultPreview === undefined,
      raw.slice(0, 300),
    );
  }
}

async function main() {
  await waitForHealth();
  console.log(`server healthy on ${base} (scratch ${scratch})`);

  const setup = await http_('POST', '/api/auth/setup', {
    body: { username: 'e2e_admin', password: 'E2e-Pass-12345!' },
  });
  if (setup.status !== 201)
    throw new Error(
      `setup: HTTP ${setup.status} ${JSON.stringify(setup.json).slice(0, 200)}`,
    );
  const cookies = setup.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter((c) => !/=$/.test(c));
  const cookie = cookies.join('; ');
  check('setup', 'initial admin created with a session', cookie.length > 20);

  const provider = await http_('POST', '/api/config/claude/providers', {
    cookie,
    body: {
      name: 'stub',
      type: 'third_party',
      anthropicBaseUrl: `http://127.0.0.1:${stub.port}`,
      anthropicAuthToken: 'stub-key-not-real',
      anthropicModel: MODEL,
      enabled: true,
    },
  });
  check(
    'setup',
    'stub provider created',
    provider.status === 201,
    `HTTP ${provider.status} ${JSON.stringify(provider.json).slice(0, 200)}`,
  );

  const profile = await http_('POST', '/api/agent-profiles', {
    cookie,
    body: {
      name: `e2e-${NONCE}`,
      prompt_schema_version: 2,
      prompt_mode: 'append',
      identity_prompt: 'You are an end-to-end test agent.',
      soul_prompt: '',
      agents_prompt: '',
      tools_prompt: '',
    },
  });
  check(
    'setup',
    'agent profile created',
    profile.status < 300,
    `HTTP ${profile.status} ${JSON.stringify(profile.json).slice(0, 200)}`,
  );
  const ctx = { cookie, profileId: profile.json.profile.id };

  const scenarios = [
    {
      label: 'assistant',
      interaction: 'assistant',
      visibility: undefined,
      expect: {
        toolVisible: true,
        always: [
          'thinking_delta',
          'tool_use_start',
          'text_delta',
          'thinking_start',
          'thinking_end',
        ],
        never: ['commentary'],
        answerStreamed: true,
        thinkingText: true,
        thinkingTiming: true,
        snapshot: 'thinking',
        trace: 'with-thinking',
      },
    },
    {
      label: 'proactive-hidden',
      interaction: 'proactive',
      visibility: 'hidden',
      expect: {
        toolVisible: false,
        always: ['status', 'commentary'],
        never: [
          'text_delta',
          'thinking_delta',
          'thinking_start',
          'thinking_end',
          'tool_use_start',
          'tool_use_end',
          'tool_result',
          'tool_progress',
          'usage',
          'task_start',
        ],
        onlyLifecycleStatus: true,
        snapshot: 'progress-only',
        trace: 'progress-only',
      },
    },
    {
      label: 'proactive-activity',
      interaction: 'proactive',
      visibility: 'activity',
      expect: {
        toolVisible: true,
        always: [
          'tool_use_start',
          'thinking_start',
          'thinking_end',
          'commentary',
        ],
        never: ['text_delta', 'thinking_delta', 'usage'],
        stripped: true,
        thinkingTiming: true,
        snapshot: 'activity',
        trace: 'activity',
      },
    },
    {
      label: 'proactive-full',
      interaction: 'proactive',
      visibility: 'full',
      expect: {
        toolVisible: true,
        always: [
          'tool_use_start',
          'thinking_delta',
          'thinking_start',
          'thinking_end',
          'commentary',
        ],
        never: ['text_delta', 'usage'],
        narration: true,
        thinkingText: true,
        stripped: true,
        thinkingTiming: true,
        snapshot: 'thinking',
        trace: 'with-thinking',
      },
    },
  ];
  const outcomes = [];
  for (const s of scenarios) outcomes.push(await runScenario(ctx, s));

  // The stored steps follow the *current* level, not the one the turn ran at.
  console.log(
    '\n== steps-level (full -> activity -> hidden -> full, stored turn)',
  );
  const fullRun = outcomes[3];
  const stepsUrl = `/api/groups/${enc(fullRun.session.sessionJid)}/turn-traces/${enc(fullRun.turnId)}`;
  const setLevel = (process_visibility) =>
    http_('PATCH', `/api/groups/${enc(fullRun.jid)}`, {
      cookie,
      body: { process_visibility },
    });
  const reasoningOf = (r) =>
    (r.json?.steps || []).filter((s) => s.kind === 'thinking');
  const atFull = await http_('GET', stepsUrl, { cookie });
  check(
    'steps-level',
    'at full the reasoning steps hold their text',
    atFull.status === 200 &&
      reasoningOf(atFull).length === 2 &&
      reasoningOf(atFull).every((s) => !!s.text && !!s.title),
    `HTTP ${atFull.status} ${JSON.stringify(reasoningOf(atFull)).slice(0, 200)}`,
  );
  check(
    'steps-level',
    'lowered to activity',
    (await setLevel('activity')).status === 200,
  );
  const atActivity = await http_('GET', stepsUrl, { cookie });
  check(
    'steps-level',
    'at activity the same steps lose their text and titles but keep their times',
    atActivity.status === 200 &&
      atActivity.json.steps.length === atFull.json.steps.length &&
      reasoningOf(atActivity).every(
        (s) =>
          s.text === undefined &&
          s.title === undefined &&
          typeof s.durationMs === 'number',
      ) &&
      !JSON.stringify(atActivity.json).includes('Planning the demo') &&
      atActivity.json.thinking === '',
    JSON.stringify(atActivity.json?.steps)?.slice(0, 240),
  );
  check(
    'steps-level',
    'lowered to hidden',
    (await setLevel('hidden')).status === 200,
  );
  const atHidden = await http_('GET', stepsUrl, { cookie });
  check(
    'steps-level',
    'at hidden the turn shows the progress the Agent sent, and no other step',
    atHidden.status === 200 &&
      atHidden.json.steps.length === 1 &&
      atHidden.json.steps[0].text === PROGRESS_TEXT &&
      atHidden.json.thinking === '' &&
      atHidden.json.trace.length === 0 &&
      !JSON.stringify(atHidden.json).includes('Planning the demo'),
    `HTTP ${atHidden.status} ${JSON.stringify(atHidden.json)?.slice(0, 200)}`,
  );
  const listedAtHidden = await historyOf(cookie, fullRun.session);
  check(
    'steps-level',
    'and its reply is still listed as carrying a trace',
    (listedAtHidden.json.messages || []).some(
      (m) => m.turn_id === fullRun.turnId && m.has_trace === true,
    ),
    JSON.stringify(
      (listedAtHidden.json.messages || []).map((m) => [m.turn_id, m.has_trace]),
    ),
  );
  check(
    'steps-level',
    'raised to full again',
    (await setLevel('full')).status === 200,
  );
  const backAtFull = await http_('GET', stepsUrl, { cookie });
  check(
    'steps-level',
    'and the reasoning text is back',
    backAtFull.status === 200 &&
      reasoningOf(backAtFull).every((s) => !!s.text && !!s.title),
    `HTTP ${backAtFull.status}`,
  );

  // Live change without a restart: hidden -> full on the same workspace.
  console.log(
    '\n== proactive-switch (hidden -> full on a live workspace, no restart)',
  );
  const switched = outcomes[1];
  const patch = await http_('PATCH', `/api/groups/${enc(switched.jid)}`, {
    cookie,
    body: { process_visibility: 'full' },
  });
  check(
    'proactive-switch',
    'PATCH process_visibility answers 200',
    patch.status === 200,
    `HTTP ${patch.status} ${JSON.stringify(patch.json).slice(0, 160)}`,
  );
  const patchBad = await http_('PATCH', `/api/groups/${enc(switched.jid)}`, {
    cookie,
    body: { process_visibility: 'everything' },
  });
  check(
    'proactive-switch',
    'an unknown level is rejected',
    patchBad.status === 400,
    `HTTP ${patchBad.status}`,
  );
  const conn = openWs(cookie);
  await conn.ready;
  stub.setMode('proactive');
  const switchedOwn = ofSession(switched.session);
  sendTo(conn.ws, switched.session, 'run the demo again');
  await waitUntil(
    () => conn.events.some((e) => switchedOwn(e) && e.type === 'run_finished'),
    150_000,
    'run_finished after the switch',
  );
  const after = conn.events
    .filter((e) => switchedOwn(e) && e.type === 'stream_event')
    .map((e) => e.event);
  check(
    'proactive-switch',
    'the next turn streams reasoning at the new level',
    after.some((e) => e.eventType === 'thinking_delta'),
    JSON.stringify(typeCounts(conn.events)),
  );
  check(
    'proactive-switch',
    'and still never streams answer text',
    !after.some((e) => e.eventType === 'text_delta'),
    '',
  );
  // A second turn on a warm Runner: its frames carry the Runner's own turn
  // id, not the input's. The progress must carry the same, or the Web would
  // start a new card for it and wipe the one it belongs to.
  const switchedProgress = after.filter(
    (e) => e.eventType === 'commentary' && e.progress === true,
  );
  const switchedTurnIds = new Set(
    after.filter(isRunnerFrame).map((e) => e.turnId),
  );
  check(
    'proactive-switch',
    "the warm turn's progress lands on its own card",
    switchedProgress.length === 1 &&
      switchedTurnIds.size === 1 &&
      switchedTurnIds.has(switchedProgress[0].turnId),
    `${JSON.stringify(switchedProgress.map((e) => [e.turnId, e.inputTurnId]))} vs ${JSON.stringify([...switchedTurnIds])}`,
  );
  conn.ws.close();

  await proactiveStopKeepsProgress(ctx);
  await proactiveNoFinalKeepsProgress(ctx);

  await runFactsScenario(ctx, {
    label: 'tool-facts-assistant',
    interaction: 'assistant',
  });
  await runFactsScenario(ctx, {
    label: 'tool-facts-proactive-activity',
    interaction: 'proactive',
    visibility: 'activity',
  });

  // Access control on the new read endpoint.
  console.log('\n== access control');
  const anon = await http_(
    'GET',
    `/api/groups/${enc(switched.session.sessionJid)}/turn-traces/whatever`,
  );
  check(
    'acl',
    'turn-traces without a session is 401',
    anon.status === 401,
    `HTTP ${anon.status}`,
  );
  const bogus = await http_(
    'GET',
    `/api/groups/${enc('web:does-not-exist')}/turn-traces/x`,
    { cookie },
  );
  check(
    'acl',
    'turn-traces of an unknown workspace is 404',
    bogus.status === 404,
    `HTTP ${bogus.status}`,
  );
  const anonPatch = await http_('PATCH', `/api/groups/${enc(switched.jid)}`, {
    body: { process_visibility: 'hidden' },
  });
  check(
    'acl',
    'PATCH process_visibility without a session is 401',
    anonPatch.status === 401,
    `HTTP ${anonPatch.status}`,
  );

  await proactiveReplyInTheBrowser(ctx, 'full');
  await proactiveReplyInTheBrowser(ctx, 'hidden');
}

/**
 * A proactive Web turn stopped after it sent progress, at `hidden`: the
 * progress stays with the turn, on a closing note that carries its trace, and
 * a later read of the history still finds it.
 */
async function proactiveStopKeepsProgress(ctx) {
  const label = 'stop-keeps-progress';
  console.log(`\n== ${label}`);
  stub.setMode('proactive');
  const created = await http_('POST', '/api/groups', {
    cookie: ctx.cookie,
    body: {
      name: `${label}-${NONCE}`,
      execution_mode: 'host',
      agent_profile_id: ctx.profileId,
      interaction_mode: 'proactive',
      process_visibility: 'hidden',
    },
  });
  if (created.status >= 300)
    throw new Error(`create workspace: HTTP ${created.status}`);
  const session = await openSession(ctx.cookie, created.json.jid, label);
  const conn = openWs(ctx.cookie);
  await conn.ready;
  const mine = ofSession(session);
  sendTo(conn.ws, session, 'start');
  await waitUntil(
    () =>
      conn.events.some(
        (e) =>
          mine(e) &&
          e.event?.eventType === 'commentary' &&
          e.event?.progress === true,
      ),
    90_000,
    'the progress on the Web',
  );
  const stop = await http_(
    'POST',
    `/api/groups/${enc(session.sessionJid)}/interrupt`,
    { cookie: ctx.cookie },
  );
  check(
    label,
    'the turn is stopped',
    stop.status === 200,
    `HTTP ${stop.status}`,
  );
  await waitUntil(
    () =>
      conn.events.some(
        (e) =>
          mine(e) &&
          e.type === 'new_message' &&
          e.message?.source_kind === 'interrupt_partial',
      ),
    60_000,
    'the closing note',
  );
  const note = conn.events.find(
    (e) =>
      mine(e) &&
      e.type === 'new_message' &&
      e.message?.source_kind === 'interrupt_partial',
  ).message;
  check(
    label,
    'a closing note becomes the reply and carries the trace',
    note.content === '已停止。' && note.has_trace === true && !!note.turn_id,
    JSON.stringify(note).slice(0, 300),
  );
  const history = await historyOf(ctx.cookie, session);
  const stored = (history.json.messages || []).find((m) => m.id === note.id);
  check(
    label,
    'the history still flags it',
    stored?.has_trace === true,
    JSON.stringify(stored)?.slice(0, 200),
  );
  const trace = await traceOf(ctx.cookie, session, note.turn_id);
  check(
    label,
    'and its trace holds the progress, alone at hidden',
    trace.status === 200 &&
      trace.json.steps.length === 1 &&
      trace.json.steps[0].progress === true &&
      trace.json.steps[0].text === PROGRESS_TEXT,
    `HTTP ${trace.status} ${JSON.stringify(trace.json)?.slice(0, 200)}`,
  );
  conn.ws.close();
}

/**
 * A proactive Web turn that sent progress and then ended without its final:
 * the host refuses to settle it. The refusal will be retried, so it writes no
 * closing note: the progress waits for the attempt that ends the turn for good
 * (tests/proactive-progress-web.test.ts drives the attempts that follow).
 */
async function proactiveNoFinalKeepsProgress(ctx) {
  const label = 'no-final-progress';
  console.log(`\n== ${label}`);
  stub.setMode('proactive');
  stub.state.skipFinal = true;
  try {
    const created = await http_('POST', '/api/groups', {
      cookie: ctx.cookie,
      body: {
        name: `${label}-${NONCE}`,
        execution_mode: 'host',
        agent_profile_id: ctx.profileId,
        interaction_mode: 'proactive',
        process_visibility: 'activity',
      },
    });
    if (created.status >= 300)
      throw new Error(`create workspace: HTTP ${created.status}`);
    const session = await openSession(ctx.cookie, created.json.jid, label);
    const conn = openWs(ctx.cookie);
    await conn.ready;
    const mine = ofSession(session);
    sendTo(conn.ws, session, 'go');
    await waitUntil(
      () => conn.events.some((e) => mine(e) && e.type === 'run_finished'),
      120_000,
      'the refused turn to finish its run',
    );
    await sleep(3000);
    const notes = conn.events.filter(
      (e) =>
        mine(e) &&
        e.type === 'new_message' &&
        e.message?.source_kind === 'interrupt_partial',
    );
    check(
      label,
      'a refusal that will be retried writes no closing note',
      conn.events.some(
        (e) =>
          mine(e) &&
          e.event?.eventType === 'commentary' &&
          e.event?.progress === true,
      ) && notes.length === 0,
      JSON.stringify(notes.map((e) => e.message?.content)),
    );
    const history = await historyOf(ctx.cookie, session);
    check(
      label,
      'and the history holds none either',
      !(history.json.messages || []).some(
        (m) => m.source_kind === 'interrupt_partial',
      ),
      JSON.stringify((history.json.messages || []).map((m) => m.source_kind)),
    );
    conn.ws.close();
  } finally {
    stub.state.skipFinal = false;
  }
}

/**
 * A proactive turn's reply in the real Web: once the utterance is in the list,
 * its process panel and spinner are gone, while the run (still asking the model
 * whether it is done) can be stopped. The progress the Agent sent shows while
 * the turn works, in the panel and the status bar, folds away with the reply,
 * and is there again under it, also after a reload. Screenshots go to
 * HC_E2E_SHOTS if set.
 */
async function proactiveReplyInTheBrowser(ctx, visibility) {
  const label = `proactive-reply-browser-${visibility}`;
  console.log(`\n== ${label}`);
  stub.setMode('proactive');
  // Shorter than the wait before a quiet turn shows its spinner again (3s).
  stub.state.closingDelayMs = 1500;
  const created = await http_('POST', '/api/groups', {
    cookie: ctx.cookie,
    body: {
      name: `${label}-${NONCE}`,
      execution_mode: 'host',
      agent_profile_id: ctx.profileId,
      interaction_mode: 'proactive',
      process_visibility: visibility,
    },
  });
  if (created.status >= 300)
    throw new Error(`create workspace: HTTP ${created.status}`);
  const folder = created.json.group.folder;
  const session = await openSession(ctx.cookie, created.json.jid, label);
  const { chromium } = createRequire(path.join(REPO, 'web', 'package.json'))(
    '@playwright/test',
  );
  const browser = await chromium.launch();
  const shots = process.env.HC_E2E_SHOTS;
  try {
    const context = await browser.newContext({
      baseURL: base,
      viewport: { width: 1280, height: 860 },
    });
    await context.addCookies(
      ctx.cookie.split('; ').map((pair) => {
        const at = pair.indexOf('=');
        return {
          name: pair.slice(0, at),
          value: pair.slice(at + 1),
          url: base,
        };
      }),
    );
    const page = await context.newPage();
    // `?agent=` names the session the chat opens on.
    await page.goto(`/chat/${folder}?agent=${enc(session.sessionId)}`);
    const editor = page.locator('[data-hc-composer] [data-composer-editor]');
    await editor.waitFor({ timeout: 30_000 });
    // Every frame from here on: is the reply there, the panel, the spinner,
    // the stop button.
    await page.evaluate(
      ([reply, progress]) => {
        window.__frames = [];
        const tick = () => {
          const text = document.body.innerText;
          const panel = document.querySelector('[data-hc-process-panel]');
          window.__frames.push({
            at: performance.now(),
            reply: text.includes(reply),
            panel: !!panel,
            panelProgress: !!panel?.textContent?.includes(progress),
            barProgress:
              document.querySelector('[data-hc-run-progress]')?.textContent ===
              progress,
            progress: text.includes(progress),
            // The run status bar, wherever the composer mounts it.
            spinner: !!document.querySelector('[data-hc-run-status-bar]'),
            stop: !!document.querySelector('[aria-label="停止当前运行"]'),
          });
          if (window.__frames.length < 20_000) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      [PROACTIVE_TEXT, PROGRESS_TEXT],
    );
    await editor.click();
    await page.keyboard.type('what are you doing');
    await page.keyboard.press('Enter');
    await page.locator('[data-hc-process-panel]').waitFor({ timeout: 90_000 });
    if (shots)
      await page.screenshot({
        path: path.join(shots, `proactive-${visibility}-1-working.png`),
      });
    await page.getByText(PROACTIVE_TEXT).waitFor({ timeout: 90_000 });
    if (shots) {
      await sleep(300);
      await page.screenshot({
        path: path.join(shots, `proactive-${visibility}-2-replied.png`),
      });
    }
    await page
      .locator('[aria-label="停止当前运行"]')
      .waitFor({ state: 'detached', timeout: 60_000 });
    await sleep(500);
    if (shots)
      await page.screenshot({
        path: path.join(shots, `proactive-${visibility}-3-done.png`),
      });
    const frames = await page.evaluate(() => window.__frames);
    const first = frames.findIndex((f) => f.reply);
    const after = first >= 0 ? frames.slice(first) : [];
    check(
      label,
      'the panel was there while the turn worked',
      frames.slice(0, Math.max(first, 0)).some((f) => f.panel),
    );
    check(
      label,
      'once the reply is in, no frame shows the panel or the spinner',
      after.length > 0 && after.every((f) => !f.panel && !f.spinner),
      (() => {
        const shown = after.find((f) => f.panel || f.spinner);
        return `${JSON.stringify(shown)} ${shown?.at - after[0]?.at}ms after the reply`;
      })(),
    );
    const closing = after.filter((f) => f.stop);
    check(
      label,
      'the run could still be stopped for a while after the reply',
      closing.length > 0 && closing.at(-1).at - after[0].at > 1000,
      `${closing.length} frames, ${closing.at(-1)?.at - after[0]?.at}ms`,
    );
    const before = frames.slice(0, Math.max(first, 0));
    check(
      label,
      'while the turn worked, its progress was in the panel and the status bar',
      before.some((f) => f.panelProgress) && before.some((f) => f.barProgress),
      JSON.stringify(before.filter((f) => f.progress).slice(0, 1)),
    );
    check(
      label,
      'once the reply is in, the progress is folded away',
      after.length > 0 && after.every((f) => !f.progress),
      JSON.stringify(after.find((f) => f.progress)),
    );
    // Opened under the reply, here and after a reload: read from turn_traces.
    const openProcess = async () => {
      const row = page.getByRole('button', { name: /处理过程/ }).last();
      await row.waitFor({ timeout: 30_000 });
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('button')].some(
            (b) => /处理过程/.test(b.textContent ?? '') && !b.disabled,
          ),
        undefined,
        { timeout: 30_000 },
      );
      await row.click();
      await page.getByText(PROGRESS_TEXT).first().waitFor({ timeout: 30_000 });
    };
    let reopened = false;
    try {
      await openProcess();
      reopened = true;
    } catch {
      /* reported below */
    }
    check(
      label,
      'opening the process under the reply shows the progress',
      reopened,
    );
    if (shots)
      await page.screenshot({
        path: path.join(shots, `proactive-${visibility}-4-opened.png`),
      });
    await page.reload();
    await editor.waitFor({ timeout: 30_000 });
    let restored = false;
    try {
      await openProcess();
      restored = true;
    } catch {
      /* reported below */
    }
    check(label, 'and so it does after a reload', restored);
  } finally {
    stub.state.closingDelayMs = 0;
    await browser.close();
  }
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.error(`\nHARNESS ERROR: ${err instanceof Error ? err.stack : err}`);
  console.error(
    `--- server log tail ---\n${fs.readFileSync(serverLog, 'utf8').slice(-2500)}`,
  );
} finally {
  killTree();
  await sleep(1500);
  try {
    process.kill(-server.pid, 'SIGKILL');
  } catch {
    /* gone */
  }
  stub.server.close();
  const leftovers = spawnSync('pgrep', ['-f', scratch], {
    encoding: 'utf8',
  }).stdout.trim();
  console.log(
    `\nleftover processes referencing the scratch dir: ${leftovers ? leftovers.split('\n').length : 0}`,
  );
  fs.rmSync(scratch, { recursive: true, force: true });
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
for (const r of bad)
  console.log(`  FAILED [${r.scenario}] ${r.name}  ${r.detail}`);
process.exit(failed || bad.length ? 1 : 0);
