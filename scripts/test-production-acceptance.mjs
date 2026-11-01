#!/usr/bin/env node
// Run only with an explicitly supplied, short-lived owner session. This creates
// disposable workspaces through the deployed API and removes only those IDs.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const base = process.env.HAPPYCLAW_URL;
const cookieFile = process.env.HAPPYCLAW_ACCEPTANCE_COOKIE_FILE;
if (!base || !cookieFile) {
  throw new Error('Set HAPPYCLAW_URL and HAPPYCLAW_ACCEPTANCE_COOKIE_FILE');
}
const cookie = fs.readFileSync(cookieFile, 'utf8').trim();
const nonce = `ACCEPT_${Date.now().toString(36)}`;
const ownedWorkspaces = [];
const workspaceFolders = new Map();
const ownedAutomations = [];
const cases = [];
let profileId;
let ws;
let runPassed = false;
const events = [];

function request(method, route, body) {
  return fetch(`${base}${route}`, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90_000),
  });
}

async function api(method, route, body) {
  const response = await request(method, route, body);
  if (!response.ok)
    throw new Error(`${method} ${route}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function waitUntil(predicate, timeoutMs = 180_000, pollMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error('Acceptance condition timed out');
}

// Every workspace gets one session the cases address by default; a workspace
// has no conversation of its own.
const primarySessions = new Map();
const sessionOf = (jid, agentId) => agentId ?? primarySessions.get(jid);
const sessionJidOf = (jid, agentId) =>
  `${jid}#agent:${sessionOf(jid, agentId)}`;

function scopedEvents(jid, agentId, after) {
  agentId = sessionOf(jid, agentId);
  return events
    .slice(after)
    .filter(
      (event) =>
        event.chatJid === jid && (event.agentId || undefined) === agentId,
    );
}

async function turn(jid, prompt, marker, agentId) {
  agentId = sessionOf(jid, agentId);
  const after = events.length;
  const started = Date.now();
  ws.send(
    JSON.stringify({
      type: 'send_message',
      chatJid: jid,
      agentId,
      content: prompt,
    }),
  );
  let receipt;
  await waitUntil(() => {
    receipt = scopedEvents(jid, agentId, after).find(
      (event) =>
        event.type === 'new_message' &&
        !event.message?.is_from_me &&
        event.message?.content === prompt,
    )?.message;
    return !!receipt;
  }, 30_000);
  const isFinal = (message) =>
    message?.is_from_me &&
    typeof message.turn_id === 'string' &&
    message.turn_id.length > 0 &&
    message.source_kind === 'sdk_final' &&
    message.finalization_reason === 'completed' &&
    message.content?.trim() === marker;
  let final;
  await waitUntil(() => {
    final = scopedEvents(jid, agentId, after).find(
      (event) => event.type === 'new_message' && isFinal(event.message),
    )?.message;
    return !!final;
  });
  // The stream's presentation turn ID rotates independently of durable input
  // delivery IDs. Verify scoped streaming and the exact persisted final row.
  assert(
    scopedEvents(jid, agentId, after).some(
      (event) =>
        event.type === 'stream_event' &&
        typeof event.event?.turnId === 'string' &&
        !!event.event.turnId &&
        typeof event.event.queryRunId === 'string' &&
        !!event.event.queryRunId,
    ),
    'Missing scoped stream presentation and query identity',
  );
  const route = `/api/groups/${encodeURIComponent(jid)}/messages${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`;
  await waitUntil(
    async () => {
      const history = await api('GET', route);
      return history.messages.some(
        (message) =>
          message.id === final.id &&
          message.turn_id === final.turn_id &&
          isFinal(message),
      );
    },
    15_000,
    1000,
  );
  await waitUntil(
    async () => {
      const status = await api('GET', '/api/status');
      const actualJid = agentId ? `${jid}#agent:${agentId}` : jid;
      const runner = status.groups.find((group) => group.jid === actualJid);
      return !runner || (!runner.queryInFlight && !runner.pendingMessages);
    },
    60_000,
    2000,
  );
  const scoped = scopedEvents(jid, agentId, after);
  assert(
    scoped.some((event) => event.type === 'stream_event'),
    'Missing deployed streaming events',
  );
  cases.push({
    marker,
    passed: true,
    elapsedMs: Date.now() - started,
    streamEvents: scoped.filter((event) => event.type === 'stream_event')
      .length,
    toolEvents: scoped.filter(
      (event) => event.event?.eventType === 'tool_use_start',
    ).length,
  });
}

async function workspace(mode) {
  const created = await api('POST', '/api/groups', {
    name: `${nonce} ${mode}`,
    execution_mode: mode,
    agent_profile_id: profileId,
  });
  ownedWorkspaces.push(created.jid);
  workspaceFolders.set(created.jid, created.group.folder);
  assert.equal(created.group.execution_mode, mode);
  const { session } = await api(
    'POST',
    `/api/groups/${encodeURIComponent(created.jid)}/sessions`,
    { name: 'Acceptance primary' },
  );
  primarySessions.set(created.jid, session.id);
  return created.jid;
}

async function verifyFile(jid, filename, expected) {
  const encoded = Buffer.from(filename).toString('base64url');
  const response = await api(
    'GET',
    `/api/groups/${encodeURIComponent(jid)}/files/content/${encoded}`,
  );
  assert.equal(response.content.trim(), expected);
}

async function verifyUsage(jid, agentId, marker) {
  await waitUntil(
    async () => {
      const history = await api(
        'GET',
        `/api/groups/${encodeURIComponent(jid)}/messages?agentId=${encodeURIComponent(agentId)}`,
      );
      const message = history.messages.find(
        (row) =>
          row.source_kind === 'sdk_final' && row.content.trim() === marker,
      );
      if (!message?.token_usage) return false;
      const usage = JSON.parse(message.token_usage);
      return usage.inputTokens + usage.outputTokens > 0;
    },
    15_000,
    1000,
  );
}

function ledgerKey(record) {
  return JSON.stringify([record.eventId, record.model]);
}

async function ownedSessionLedger(jid) {
  const folder = workspaceFolders.get(jid);
  assert(
    ownedWorkspaces.includes(jid) && typeof folder === 'string' && folder,
    'Ledger reads must be scoped to an owned workspace',
  );
  // Records are per (eventId, model), not per SDK result or visible reply.
  // Retry a changing paginated snapshot rather than silently dropping rows.
  for (let attempt = 0; attempt < 3; attempt++) {
    const records = new Map();
    let total;
    let pageCount = 1;
    let stable = true;
    for (let page = 1; page <= pageCount; page++) {
      const query = new URLSearchParams({
        groupFolder: folder,
        agentId: sessionOf(jid),
        days: '2',
        pageSize: '500',
        page: String(page),
      });
      const snapshot = await api('GET', `/api/usage/records?${query}`);
      assert(
        Array.isArray(snapshot.records) &&
          Number.isInteger(snapshot.total) &&
          snapshot.total >= 0 &&
          Number.isInteger(snapshot.totalPages) &&
          snapshot.totalPages >= 0 &&
          snapshot.totalPages <= 20,
        'Invalid owned ledger page',
      );
      if (total === undefined) {
        total = snapshot.total;
        pageCount = snapshot.totalPages;
      } else if (
        total !== snapshot.total ||
        pageCount !== snapshot.totalPages
      ) {
        stable = false;
      }
      for (const record of snapshot.records) {
        assert(
          record.groupFolder === folder &&
            record.agentId === sessionOf(jid) &&
            typeof record.eventId === 'string' &&
            !!record.eventId &&
            typeof record.model === 'string',
          'Ledger response escaped the owned session scope',
        );
        const key = ledgerKey(record);
        if (records.has(key)) stable = false;
        records.set(key, record);
      }
    }
    if (stable && records.size === total) return records;
  }
  throw new Error('Owned ledger pagination did not stabilize');
}

async function verifyBackgroundLedger(jid, final, before) {
  const backgroundCase = cases.at(-1);
  backgroundCase.ledgerIncrementMatchesFinal = false;
  backgroundCase.ledgerModelRows = 0;
  backgroundCase.ledgerEvents = 0;
  const fields = [
    ['inputTokens', 'inputTokens'],
    ['outputTokens', 'outputTokens'],
    ['cacheReadInputTokens', 'cacheReadTokens'],
    ['cacheCreationInputTokens', 'cacheCreationTokens'],
    ['reasoningTokens', 'reasoningTokens'],
    ['costUSD', 'providerEstimatedCostUSD'],
  ];
  let delta;
  let matched = false;
  await waitUntil(
    async () => {
      const after = await ownedSessionLedger(jid);
      assert(
        [...before.keys()].every((key) => after.has(key)),
        'Owned ledger lost pre-existing records',
      );
      delta = [...after]
        .filter(([key]) => !before.has(key))
        .map(([, row]) => row);
      if (!delta.length) return false;
      const totals = Object.fromEntries(fields.map(([key]) => [key, 0]));
      for (const row of delta) {
        for (const [key, column] of fields) {
          assert(
            Number.isFinite(row[column]) && row[column] >= 0,
            'Owned ledger contains an invalid token or cost value',
          );
          totals[key] += row[column];
        }
      }
      const history = await api(
        'GET',
        `/api/groups/${encodeURIComponent(jid)}/messages?agentId=${encodeURIComponent(sessionOf(jid))}`,
      );
      const message = history.messages.find(
        (row) =>
          row.id === final.id &&
          row.turn_id === final.turn_id &&
          row.source_kind === 'sdk_final' &&
          row.finalization_reason === 'completed',
      );
      if (!message?.token_usage) return false;
      let usage;
      try {
        usage = JSON.parse(message.token_usage);
      } catch {
        throw new Error('Background final has invalid token usage JSON');
      }
      if (!usage || typeof usage !== 'object' || Array.isArray(usage))
        return false;
      matched =
        fields
          .slice(0, 5)
          .every(([key]) => (usage[key] ?? 0) === totals[key]) &&
        Number.isFinite(usage.costUSD) &&
        Math.abs(usage.costUSD - totals.costUSD) <=
          1e-9 * Math.max(1, Math.abs(totals.costUSD)) &&
        fields.slice(0, 5).some(([key]) => totals[key] > 0);
      // Initial ledger rows may have messageId=null before the canonical final
      // exists. Do not equate that with misattribution or bind them to a previous
      // reply. The immutable event/model increment is the accounting authority.
      return matched;
    },
    30_000,
    1000,
  );
  backgroundCase.ledgerIncrementMatchesFinal = matched;
  backgroundCase.ledgerModelRows = delta.length;
  backgroundCase.ledgerEvents = new Set(delta.map((row) => row.eventId)).size;
  // durationMs and numTurns repeat on each model row, so they are deliberately
  // excluded from the sum. Counts also make no claim about SDK result boundaries.
}

async function run() {
  const me = await api('GET', '/api/auth/me');
  assert.equal(me.user.role, 'admin', 'Use an authorized owner session');
  const created = await api('POST', '/api/agent-profiles', {
    name: nonce,
    prompt_schema_version: 2,
    prompt_mode: 'append',
    identity_prompt:
      'You are running an authorized HappyClaw acceptance test. Only work in the current disposable workspace. Follow exact output markers and use tools when requested.',
    soul_prompt: '',
    agents_prompt: '',
    tools_prompt: '',
  });
  profileId = created.profile.id;
  ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, {
    headers: { Cookie: cookie },
    handshakeTimeout: 30_000,
  });
  ws.on('message', (data) => {
    try {
      const event = JSON.parse(data.toString());
      if (ownedWorkspaces.includes(event.chatJid)) events.push(event);
    } catch {
      /* ignore non-JSON heartbeats */
    }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  for (const mode of ['host', 'container']) {
    const jid = await workspace(mode);
    const marker = `${nonce}_${mode.toUpperCase()}_FILE`;
    await turn(
      jid,
      `Use a tool to create acceptance.txt in your current workspace containing exactly ${marker}. Read it back with a tool, then reply exactly ${marker}. Do not use any other directories.`,
      marker,
    );
    await verifyFile(jid, 'acceptance.txt', marker);
    const warm = `${nonce}_${mode.toUpperCase()}_WARM`;
    await turn(
      jid,
      `Read acceptance.txt with a tool and confirm it contains ${marker}. Then reply exactly ${warm}.`,
      warm,
    );
    const a = (
      await api('POST', `/api/groups/${encodeURIComponent(jid)}/sessions`, {
        name: 'Acceptance A',
      })
    ).session.id;
    const b = (
      await api('POST', `/api/groups/${encodeURIComponent(jid)}/sessions`, {
        name: 'Acceptance B',
      })
    ).session.id;
    await Promise.all([
      turn(
        jid,
        `Reply exactly ${nonce}_${mode}_SESSION_A`,
        `${nonce}_${mode}_SESSION_A`,
        a,
      ),
      turn(
        jid,
        `Reply exactly ${nonce}_${mode}_SESSION_B`,
        `${nonce}_${mode}_SESSION_B`,
        b,
      ),
    ]);
    const sessionWarm = `${nonce}_${mode}_SESSION_A_WARM`;
    await turn(jid, `Reply exactly ${sessionWarm}`, sessionWarm, a);
    await verifyUsage(jid, a, sessionWarm);
    const interruptAfter = events.length;
    ws.send(
      JSON.stringify({
        type: 'send_message',
        chatJid: jid,
        agentId: sessionOf(jid),
        content:
          'Run Bash sleep 15 in the foreground. Wait until it finishes before replying.',
      }),
    );
    await waitUntil(() =>
      scopedEvents(jid, undefined, interruptAfter).some(
        (event) =>
          event.event?.eventType === 'tool_use_start' &&
          event.event.toolName === 'Bash',
      ),
    );
    const sleepRunner = (await api('GET', '/api/status')).groups.find(
      (group) => group.jid === sessionJidOf(jid),
    );
    assert(
      sleepRunner?.queryInFlight && sleepRunner.queryId,
      'Sleep query is not active',
    );
    const interruptedMarker = `${nonce}_${mode}_INTERRUPT_FOLLOWUP`;
    const followup = turn(
      jid,
      `Reply exactly ${interruptedMarker}`,
      interruptedMarker,
    ).then(
      () => ({ success: true }),
      (error) => ({ success: false, error }),
    );
    // Wait for the durable receipt before interrupting the preceding query.
    await waitUntil(() =>
      scopedEvents(jid, undefined, interruptAfter).some(
        (event) =>
          event.type === 'new_message' &&
          !event.message?.is_from_me &&
          event.message?.content?.includes(interruptedMarker) &&
          event.message.delivery_status === 'queued' &&
          event.message.delivery_run_id === sleepRunner.queryId,
      ),
    );
    const interrupted = await api(
      'POST',
      `/api/groups/${encodeURIComponent(sessionJidOf(jid))}/interrupt`,
      {},
    );
    assert.equal(interrupted.interrupted, true);
    const followupOutcome = await followup;
    if (!followupOutcome.success) throw followupOutcome.error;
    // Automation lifecycle: a manual automation bound to the primary session.
    const automationMarker = `${nonce}_${mode}_AUTOMATION`;
    const { automation } = await api('POST', '/api/automations', {
      workspaceJid: jid,
      name: `${nonce} ${mode} automation`,
      prompt: `Use a tool to write acceptance-automation.txt containing exactly ${automationMarker}, then reply exactly ${automationMarker}.`,
      schedule: { kind: 'manual' },
      sessionMode: 'bound',
      targetSessionJid: sessionJidOf(jid),
    });
    ownedAutomations.push(automation.id);
    const automationRoute = `/api/automations/${encodeURIComponent(automation.id)}`;
    const { run } = await api('POST', `${automationRoute}/run`, {});
    await waitUntil(
      async () => {
        const current = (await api('GET', automationRoute)).runs.find(
          (item) => item.id === run.id,
        );
        if (!current) return false;
        if (
          ['failed', 'skipped', 'cancelled', 'interrupted', 'missed'].includes(
            current.status,
          )
        )
          throw new Error(
            `Acceptance automation run status: ${current.status}`,
          );
        if (current.status !== 'success') return false;
        assert.equal(
          current.sessionJid,
          sessionJidOf(jid),
          'Automation run did not reach its bound session',
        );
        assert(
          current.resultText?.includes(automationMarker),
          'Automation run result is missing its marker',
        );
        return true;
      },
      180_000,
      2000,
    );
    await verifyFile(jid, 'acceptance-automation.txt', automationMarker);
    const paused = await api('POST', `${automationRoute}/pause`, {});
    assert.equal(paused.automation.status, 'paused');
    const resumed = await api('POST', `${automationRoute}/resume`, {});
    assert.equal(resumed.automation.status, 'active');
    await api('DELETE', `${automationRoute}?sessions=keep`);
    ownedAutomations.splice(ownedAutomations.indexOf(automation.id), 1);
    const deleted = await request('GET', automationRoute);
    assert.equal(deleted.status, 404, 'Deleted automation is still visible');
    cases.push({ marker: automationMarker, passed: true, automation: true });
  }
  // The retired scheduled-task API answers 410 instead of serving old clients.
  assert.equal((await request('GET', '/api/tasks')).status, 410);
  cases.push({ marker: `${nonce}_LEGACY_TASKS_GONE`, passed: true });
  const host = ownedWorkspaces[0];
  const bg = `${nonce}_BACKGROUND_DONE`;
  const backgroundLedgerBefore = await ownedSessionLedger(host);
  const backgroundAfter = events.length;
  await turn(
    host,
    `Run Bash with run_in_background=true to execute: sleep 2; printf '${bg}' > acceptance-background.txt. Wait for the actual background task completion notification, read acceptance-background.txt, and only then reply exactly ${bg}.`,
    bg,
  );
  await verifyFile(host, 'acceptance-background.txt', bg);
  const backgroundEvents = scopedEvents(host, undefined, backgroundAfter);
  const notification = backgroundEvents.findIndex(
    (event) =>
      event.event?.eventType === 'task_notification' &&
      event.event.taskStatus === 'completed' &&
      event.event.isBackground === true,
  );
  assert(notification >= 0, 'No actual background completion notification');
  assert(
    backgroundEvents
      .slice(notification + 1)
      .some(
        (event) =>
          event.type === 'new_message' &&
          event.message?.source_kind === 'sdk_final' &&
          event.message.finalization_reason === 'completed' &&
          event.message.content?.trim() === bg,
      ),
    'Background final response preceded its completion',
  );
  const backgroundFinal = backgroundEvents
    .slice(notification + 1)
    .find(
      (event) =>
        event.type === 'new_message' &&
        event.message?.source_kind === 'sdk_final' &&
        event.message.finalization_reason === 'completed' &&
        event.message.content?.trim() === bg,
    ).message;
  const backgroundQueryId = backgroundEvents[notification].event.queryRunId;
  assert(
    typeof backgroundQueryId === 'string' &&
      !!backgroundQueryId &&
      backgroundEvents.some(
        (event) =>
          event.type === 'run_started' && event.runId === backgroundQueryId,
      ),
    'Background completion notification lacks its invocation query identity',
  );
  // Ordinary stream events keep their presentation identity. Only usage
  // projections carry the immutable input owner used by canonical final rows.
  assert(
    backgroundEvents.some(
      (event) =>
        event.type === 'stream_event' &&
        event.event?.eventType === 'usage' &&
        event.event.usageProjection === 'input_total' &&
        event.event.inputTurnId === backgroundFinal.turn_id &&
        event.event.queryRunId === backgroundQueryId &&
        event.runId === backgroundQueryId,
    ),
    'Background usage projection lacks its canonical input and query owner',
  );
  await verifyBackgroundLedger(host, backgroundFinal, backgroundLedgerBefore);
  const cloned = await api('POST', '/api/groups', {
    name: `${nonce} public git clone`,
    execution_mode: 'container',
    agent_profile_id: profileId,
    init_git_url: 'https://github.com/octocat/Hello-World.git',
  });
  ownedWorkspaces.push(cloned.jid);
  const readme = await fetch(
    `${base}/api/groups/${encodeURIComponent(cloned.jid)}/files/download/${Buffer.from('README').toString('base64url')}`,
    {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(15_000),
    },
  );
  assert.equal(readme.status, 200);
  assert(
    (await readme.text()).includes('Hello World'),
    'Git clone did not preserve the public repository file',
  );
  cases.push({ marker: `${nonce}_PUBLIC_GIT_CLONE`, passed: true });
  runPassed = true;
}

try {
  await run();
} catch (error) {
  console.error(
    JSON.stringify({ passed: false, error: error.message, cases }, null, 2),
  );
  process.exitCode = 1;
} finally {
  ws?.close();
  let cleanupFailed = false;
  for (const automationId of ownedAutomations) {
    try {
      // Deleting an automation cancels its queued and running runs.
      await api(
        'DELETE',
        `/api/automations/${encodeURIComponent(automationId)}?sessions=keep`,
      );
    } catch {
      cleanupFailed = true;
      console.error('Acceptance automation cleanup failed');
    }
  }
  for (const jid of ownedWorkspaces.reverse()) {
    try {
      await api('DELETE', `/api/groups/${encodeURIComponent(jid)}`);
    } catch {
      cleanupFailed = true;
      console.error('Acceptance workspace cleanup failed');
    }
  }
  if (profileId && !cleanupFailed) {
    try {
      await api(
        'DELETE',
        `/api/agent-profiles/${encodeURIComponent(profileId)}`,
      );
    } catch {
      cleanupFailed = true;
      console.error('Acceptance profile cleanup failed');
    }
  }
  if (cleanupFailed) process.exitCode = 1;
  console.log(
    JSON.stringify(
      {
        passed: runPassed && !cleanupFailed,
        cleanupPassed: !cleanupFailed,
        cases,
      },
      null,
      2,
    ),
  );
}
