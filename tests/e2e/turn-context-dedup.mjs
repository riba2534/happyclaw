#!/usr/bin/env node
// E2E: per-turn context notes reach a Claude session once, over the whole stack.
//
// A real HappyClaw server (scratch cwd, data directory and HOME), the real host
// Runner and Claude CLI, against a scripted Anthropic upstream that records
// every request. No real model, no credentials, nothing outside the scratch
// directory; every real provider variable is removed from the environment.
//
// Each scenario sends five Web turns to one Session and reads the conversation
// the CLI sends upstream on the last turn, which is what the transcript holds:
//
// - custom: a custom Agent on a third-party endpoint (so the Agent contract
//   anchor applies) with three Workspace memories, one of which is edited
//   before turn 4. Each memory revision, the memory index, the anchor and the
//   channel context appear once; turn 4 carries only the edited memory (and
//   its index line), and turn 5 withdraws another one forgotten before it.
//   Turns 3 and 5 wait for the Runner to close the CLI, so what was sent
//   carries across queries as well as within one.
// - compaction: the stub reports a nearly full window on turn 3, so the CLI
//   compacts on turn 4; the notes come back once right after the summary.
// - home: the admin's Home Workspace with the built-in Agent, which adds the
//   Owner Profile block. It appears only when it changes (first wake, then
//   settled), never once per turn.
//
// It prints, per turn, the size of the user message the Runner sent and an
// estimate of the request's input tokens (the stub reports that estimate as
// the turn's usage, so the CLI's numbers follow it).
//
// Usage:
//   npm run build:all
//   node tests/e2e/turn-context-dedup.mjs
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
const MODEL = 'stub-model';
const TURNS = 5;
/** Longer than the Runner's POST_RESULT_TIMEOUT_MS, after which a query ends. */
const QUERY_CLOSE_WAIT_MS = 7_000;

const results = [];
function check(scenario, name, ok, detail = '') {
  results.push({ scenario, name, ok: !!ok, detail });
  console.log(
    `${ok ? '  PASS' : '  FAIL'}  ${name}${ok || !detail ? '' : `  -> ${detail}`}`,
  );
}

// ── stub upstream ─────────────────────────────────────────────────────────
const estimateTokens = (value) =>
  Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 4);

function messageEvents(text, n, inputTokens) {
  return [
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
        usage: { input_tokens: inputTokens, output_tokens: 1 },
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
      usage: { output_tokens: 4 },
    },
    { type: 'message_stop' },
  ];
}

/** Every agent request (one with tools) is recorded under the current turn. */
function startStub() {
  // extraTokens inflates the reported usage, so the CLI compacts next turn.
  const state = { turn: 0, requests: [], calls: 0, extraTokens: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
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
      const inputTokens = estimateTokens({
        system: body.system,
        messages: body.messages,
      });
      let text = 'ok';
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        state.requests.push({
          turn: state.turn,
          messages: body.messages ?? [],
          inputTokens,
        });
        text = `reply ${state.turn}`;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const e of messageEvents(text, n, inputTokens + state.extraTokens)) {
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      }
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: server.address().port, state }),
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-e2e-notes-'));
const home = path.join(scratch, 'home');
fs.mkdirSync(path.join(scratch, 'data'), { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.symlinkSync(path.join(REPO, 'container'), path.join(scratch, 'container'));
fs.symlinkSync(path.join(REPO, 'web'), path.join(scratch, 'web'));

const stub = await startStub();
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

async function http_(method, route, { cookie, body } = {}) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
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
  return { jid, sessionId: r.json.session.id };
}

/** A session's events: run lifecycle under its JID, stream events by agentId. */
const ofSession =
  ({ jid, sessionId }) =>
  (e) =>
    e.chatJid === `${jid}#agent:${sessionId}` ||
    (e.chatJid === jid && e.agentId === sessionId);

/** Send one Web message and wait for its run to finish. */
async function sendTurn(cookie, session, turn, content) {
  const { jid, sessionId } = session;
  const mine = ofSession(session);
  stub.state.turn = turn;
  const events = [];
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, {
    headers: { Cookie: cookie, Origin: base },
    handshakeTimeout: 30_000,
  });
  ws.on('message', (data) => {
    try {
      events.push(JSON.parse(data.toString()));
    } catch {
      /* ignore non-JSON frames */
    }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(
    JSON.stringify({
      type: 'send_message',
      chatJid: jid,
      agentId: sessionId,
      content,
    }),
  );
  await waitUntil(
    () => events.some((e) => mine(e) && e.type === 'run_finished'),
    120_000,
    `run_finished for turn ${turn}`,
  );
  ws.close();
  return events.filter(mine);
}

// ── reading what the session carries ──────────────────────────────────────
/** A memory's tag as the snapshot block's JSON string carries it. */
const memoryTag = (id) => JSON.stringify(`memory id="${id}"`).slice(1, -1);

/** Text the model reads besides its own: user turns and the CLI's attachments. */
function userTexts(messages) {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'system')
    .flatMap((m) =>
      typeof m.content === 'string'
        ? [m.content]
        : (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text),
    );
}

function count(texts, needle) {
  return texts.reduce((n, text) => n + text.split(needle).length - 1, 0);
}

/** The user message each turn added, and the turn's last request size. */
function perTurn(turnRequests) {
  return turnRequests.map((requests, index) => {
    const last = requests.at(-1);
    const users = userTexts(last?.messages ?? []);
    const mine = users.filter((t) => t.includes(`turn ${index + 1} `)).at(-1);
    return {
      turn: index + 1,
      userMessageChars: mine?.length ?? 0,
      requestInputTokens: last?.inputTokens ?? 0,
    };
  });
}

async function runTurns(label, cookie, session, beforeTurn) {
  const turnRequests = [];
  const turnEvents = [];
  for (let turn = 1; turn <= TURNS; turn++) {
    if (beforeTurn) await beforeTurn(turn);
    const start = stub.state.requests.length;
    const events = await sendTurn(
      cookie,
      session,
      turn,
      `turn ${turn} of ${label}: what do we know about the release?`,
    );
    turnRequests.push(stub.state.requests.slice(start));
    turnEvents.push(
      events.filter((e) => e.type === 'stream_event').map((e) => e.event),
    );
  }
  const recalls = turnEvents.map((events) =>
    events.find((e) => e?.eventType === 'memory_recall'),
  );
  const finalTexts = userTexts(turnRequests.at(-1).at(-1)?.messages ?? []);
  const rows = perTurn(turnRequests);
  console.log(`   per turn: ${JSON.stringify(rows)}`);
  return { finalTexts, rows, recalls, turnEvents };
}

async function main() {
  await waitForHealth();
  console.log(`server healthy on ${base} (scratch ${scratch})`);

  const setup = await http_('POST', '/api/auth/setup', {
    body: { username: 'e2e_admin', password: 'E2e-Pass-12345!' },
  });
  if (setup.status !== 201)
    throw new Error(
      `setup: HTTP ${setup.status} ${JSON.stringify(setup.json)}`,
    );
  const cookie = setup.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter((c) => !/=$/.test(c))
    .join('; ');

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
  check('setup', 'stub provider created', provider.status === 201);

  // ── custom Agent: memories, anchor, channel context ──
  console.log('\n== custom');
  const contract = [
    'You are the release-notes agent.',
    ...Array.from(
      { length: 30 },
      (_, i) => `Rule ${i + 1}: keep release notes exact and short.`,
    ),
  ].join('\n');
  const profile = await http_('POST', '/api/agent-profiles', {
    cookie,
    body: {
      name: 'e2e-notes',
      prompt_schema_version: 2,
      prompt_mode: 'append',
      identity_prompt: contract,
      soul_prompt: '',
      agents_prompt: '',
      tools_prompt: '',
    },
  });
  const created = await http_('POST', '/api/groups', {
    cookie,
    body: {
      name: 'notes-custom',
      execution_mode: 'host',
      agent_profile_id: profile.json.profile.id,
    },
  });
  if (created.status >= 300)
    throw new Error(`workspace: HTTP ${created.status}`);
  const jid = created.json.jid;
  const memories = [];
  for (const [i, content] of [
    'The release ships on Friday.',
    'Release notes go to the #release channel.',
    'The release manager is Lin.',
  ].entries()) {
    const r = await http_('POST', `/api/memory/workspaces/${enc(jid)}/items`, {
      cookie,
      body: { kind: 'fact', content, importance: 0.9 - i * 0.1 },
    });
    if (r.status !== 201)
      throw new Error(`memory: HTTP ${r.status} ${JSON.stringify(r.json)}`);
    memories.push(r.json.item ?? r.json);
  }
  const edited = memories[0];
  const forgotten = memories[2];
  const customSession = await openSession(cookie, jid, 'notes');
  const custom = await runTurns(
    'custom',
    cookie,
    customSession,
    async (turn) => {
      // The Runner closes the CLI 5 s after a result. Turns 3 and 5 start a
      // new query that resumes the session; turns 2 and 4 join the open one.
      if (turn === 3 || turn === 5) await sleep(QUERY_CLOSE_WAIT_MS);
      if (turn === 5) {
        // Forgotten while the session holds it: turn 5 withdraws it.
        const r = await http_(
          'DELETE',
          `/api/memory/workspaces/${enc(jid)}/items/${enc(forgotten.id)}`,
          { cookie, body: { expectedRevision: forgotten.revision } },
        );
        if (r.status >= 300)
          throw new Error(
            `memory forget: HTTP ${r.status} ${JSON.stringify(r.json)}`,
          );
        return;
      }
      if (turn !== 4) return;
      const r = await http_(
        'PATCH',
        `/api/memory/workspaces/${enc(jid)}/items/${enc(edited.id)}`,
        {
          cookie,
          body: {
            expectedRevision: edited.revision,
            content: 'The release moved to Monday.',
          },
        },
      );
      if (r.status >= 300)
        throw new Error(
          `memory edit: HTTP ${r.status} ${JSON.stringify(r.json)}`,
        );
    },
  );
  for (const memory of memories.slice(1)) {
    const n = count(custom.finalTexts, memoryTag(memory.id));
    check('custom', `memory ${memory.id} is in the context once`, n === 1, n);
  }
  const editedCount = count(custom.finalTexts, memoryTag(edited.id));
  check(
    'custom',
    'the edited memory is in the context once per revision',
    editedCount === 2,
    editedCount,
  );
  const turn4 = custom.finalTexts.find((t) => t.includes('turn 4 '));
  check(
    'custom',
    'turn 4 carries only the edited memory',
    !!turn4 &&
      turn4.includes('The release moved to Monday.') &&
      !memories.slice(1).some((m) => turn4.includes(m.id)),
    turn4?.slice(0, 400),
  );
  const anchors = count(custom.finalTexts, '<active-agent-turn-contract');
  check(
    'custom',
    'the Agent contract anchor is sent once',
    anchors === 1,
    anchors,
  );
  const channels = count(custom.finalTexts, '<channel_context');
  check('custom', 'the channel context is sent once', channels === 1, channels);
  const turn5 = custom.finalTexts.find((t) => t.includes('turn 5 '));
  check(
    'custom',
    'turn 5 withdraws the memory forgotten before it',
    !!turn5 &&
      turn5.includes(
        `"withdrawn":[{"id":"${forgotten.id}","status":"deleted"}]`,
      ) &&
      /1 withdrawn/.test(custom.recalls[4]?.summary ?? ''),
    `${turn5?.slice(0, 600)} ${JSON.stringify(custom.recalls[4])}`,
  );
  const fullIndexes = count(
    custom.finalTexts,
    '<workspace_memory_index trust="historical_data" instruction_priority="none">\n',
  );
  check(
    'custom',
    'the memory index is sent whole once',
    fullIndexes === 1,
    fullIndexes,
  );
  check(
    'custom',
    'turn 4 lists only the edited memory again in the index',
    !!turn4 &&
      turn4.includes(`+ ${edited.id} · fact · The release moved to Monday.`),
    turn4?.slice(0, 600),
  );
  check(
    'custom',
    'turn 5 takes the forgotten memory out of the index',
    !!turn5 && turn5.includes(`- ${forgotten.id}\n`),
    turn5?.slice(0, 600),
  );
  const recall4 = custom.recalls[3];
  check(
    'custom',
    'the memory trace tells retrieved from sent',
    !!recall4 &&
      /3 retrieved, 1 sent/.test(recall4.summary ?? '') &&
      (recall4.detail ?? '').includes(`sent: ${edited.id}@`),
    JSON.stringify(recall4),
  );

  // ── compaction: the next turn carries everything again ──
  console.log('\n== compaction');
  const compactProfile = await http_('POST', '/api/agent-profiles', {
    cookie,
    body: {
      name: 'e2e-notes-compact',
      prompt_schema_version: 2,
      prompt_mode: 'append',
      identity_prompt: contract,
      soul_prompt: '',
      agents_prompt: '',
      tools_prompt: '',
      runtime_policy: { context: { auto_compact_window: 100000 } },
    },
  });
  if (compactProfile.status >= 300)
    throw new Error(
      `profile: HTTP ${compactProfile.status} ${JSON.stringify(compactProfile.json)}`,
    );
  const compactWs = await http_('POST', '/api/groups', {
    cookie,
    body: {
      name: 'notes-compact',
      execution_mode: 'host',
      agent_profile_id: compactProfile.json.profile.id,
    },
  });
  const compactJid = compactWs.json.jid;
  const compactMemory = await http_(
    'POST',
    `/api/memory/workspaces/${enc(compactJid)}/items`,
    { cookie, body: { kind: 'fact', content: 'Compaction keeps memories.' } },
  );
  const compacted = await runTurns(
    'compaction',
    cookie,
    await openSession(cookie, compactJid, 'notes'),
    async (turn) => {
      // Turn 3 reports a nearly full window; turn 4 starts with a compaction.
      stub.state.extraTokens = turn === 3 ? 95_000 : 0;
    },
  );
  const compactedAt = compacted.turnEvents.findIndex((events) =>
    events.some((e) => e?.eventType === 'compact_boundary'),
  );
  check(
    'compaction',
    'the CLI compacted the conversation',
    compactedAt >= 0,
    JSON.stringify(compacted.turnEvents.map((e) => e.map((x) => x?.eventType))),
  );
  // The final request holds only what followed the compaction: the summary,
  // the interrupted turn with the notes the SessionStart hook restored, and
  // the turn after it.
  const texts = compacted.finalTexts;
  const restored = {
    anchors: count(texts, '<active-agent-turn-contract'),
    memories: count(texts, memoryTag(compactMemory.json.item.id)),
    indexes: count(texts, '<workspace_memory_index'),
    channels: count(texts, '<channel_context'),
  };
  check(
    'compaction',
    'the anchor, memory, index and channel are restored once after the compaction',
    restored.anchors === 1 &&
      restored.memories === 1 &&
      restored.indexes === 1 &&
      restored.channels === 1,
    JSON.stringify(restored),
  );
  const next = texts.find((t) => t.includes(`turn ${compactedAt + 2} `));
  check(
    'compaction',
    'the turn after the compaction sends only what changed',
    !!next &&
      !next.includes('<active-agent-turn-contract') &&
      !next.includes('<channel_context'),
    next?.slice(0, 300),
  );

  // ── Home Workspace: the Owner Profile block ──
  console.log('\n== home');
  const groups = await http_('GET', '/api/groups', { cookie });
  const homeJid = Object.entries(groups.json.groups ?? {}).find(
    ([, g]) => g.is_home,
  )?.[0];
  if (!homeJid) throw new Error('no Home Workspace');
  const homeRun = await runTurns(
    'home',
    cookie,
    await openSession(cookie, homeJid, 'home'),
  );
  const owner = count(homeRun.finalTexts, '<workspace_owner_profile');
  check(
    'home',
    'the Owner Profile block is sent only when it changes',
    owner >= 1 && owner <= 2,
    owner,
  );
  const homeChannels = count(homeRun.finalTexts, '<channel_context');
  check(
    'home',
    'the channel context is sent once',
    homeChannels === 1,
    homeChannels,
  );

  console.log(
    `\nSUMMARY ${JSON.stringify({
      custom: {
        memoryIdOccurrences: memories.map((m) =>
          count(custom.finalTexts, memoryTag(m.id)),
        ),
        anchors,
        channelContexts: channels,
        perTurn: custom.rows,
      },
      home: {
        ownerProfileBlocks: owner,
        channelContexts: homeChannels,
        perTurn: homeRun.rows,
      },
    })}`,
  );
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
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
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
  if (!process.env.KEEP_SCRATCH) {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
for (const r of bad)
  console.log(`  FAILED [${r.scenario}] ${r.name}  ${r.detail}`);
process.exit(failed || bad.length ? 1 : 0);
