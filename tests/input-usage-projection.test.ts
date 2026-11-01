import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { InputUsageProjection } from '../src/input-usage-projection.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'input-usage-'));
vi.mock('../src/config.js', () => ({
  STORE_DIR: scratch,
  GROUPS_DIR: scratch,
}));
vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));
const db = await import('../src/db.js');
db.initDatabase();
const probe = new Database(path.join(scratch, 'messages.db'), {
  readonly: true,
});
afterAll(() => {
  probe.close();
  db.closeDatabase();
  fs.rmSync(scratch, { recursive: true, force: true });
});
const usage = (eventId: string, inputTokens = 10) => ({
  eventId,
  inputTokens,
  outputTokens: 5,
  cacheReadInputTokens: 7,
  cacheCreationInputTokens: 3,
  reasoningTokens: 2,
  costUSD: 999,
  durationMs: 20,
  numTurns: 1,
});
let serial = 0;
function record(options: any) {
  const u = options.usage;
  const receipt = db.recordUsageEventBatch({
    eventId: u.eventId,
    userId: 'projection-owner',
    groupFolder: options.groupFolder,
    agentId: options.agentId,
    messageId: options.messageId,
    ...u,
    providerEstimatedCostUSD: 0.01,
    billedCostUSD: 0,
    models: [],
    source: 'projection-test',
    trackBillingUsage: false,
    chargeBalance: false,
  });
  return { eventId: u.eventId, ...receipt, providerEstimatedCostUSD: 0.01 };
}
const source = fs.readFileSync(
  new URL('../src/index.ts', import.meta.url),
  'utf8',
);
const ast = ts.createSourceFile(
  'host.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
);
function compile(text: string): string {
  return ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
function findRawUsageBlock(name: string): string {
  let block: ts.IfStatement | undefined;
  const walk = (node: ts.Node) => {
    if (
      ts.isIfStatement(node) &&
      node.expression
        .getText(ast)
        .includes(`${name}.streamEvent.eventType === 'usage'`) &&
      node.thenStatement
        .getText(ast)
        .includes('const accounting = writeUsageRecords')
    )
      block = node;
    ts.forEachChild(node, walk);
  };
  walk(ast);
  if (!block) throw new Error(`Production ${name} usage block missing`);
  return compile(block.getText(ast));
}
function hostRecord(
  scope: 'main' | 'agent',
  projection: InputUsageProjection,
  inputTurnId: string,
  raw: ReturnType<typeof usage>,
) {
  const args = {
    result: { inputTurnId, streamEvent: { eventType: 'usage', usage: raw } },
    output: { inputTurnId, streamEvent: { eventType: 'usage', usage: raw } },
    inputUsageProjection: projection,
    agentInputUsageProjection: projection,
    effectiveGroup: {
      folder: 'projection-test',
      created_by: 'projection-owner',
    },
    registeredGroups: {},
    chatJid: 'web:projection',
    agentId: 'projection-agent',
    writeUsageRecords: record,
    logger: { warn: vi.fn() },
  };
  return new Function(
    ...Object.keys(args),
    `let usageProjectionEvent; ${findRawUsageBlock(scope === 'main' ? 'result' : 'output')}; return usageProjectionEvent;`,
  )(...Object.values(args));
}

describe('input cumulative display projection', () => {
  for (const scope of ['agent'] as const) {
    test(`${scope}: actual host handles multiple SDK results, batches and replay without charging/displaying twice`, () => {
      const prefix = `${scope}-${serial++}`;
      const p = new InputUsageProjection('input-a');
      const first = hostRecord(scope, p, 'input-a', {
        ...usage(`${prefix}-1`),
        batchIndex: 0,
        batchCount: 2,
      });
      expect(first).toBeUndefined();
      const second = hostRecord(scope, p, 'input-a', {
        ...usage(`${prefix}-2`, 20),
        batchIndex: 1,
        batchCount: 2,
      });
      expect(second).toMatchObject({
        inputTurnId: 'input-a',
        usageProjection: 'input_total',
        usage: { inputTokens: 30, costUSD: 0.02 },
      });
      expect(second.usage.eventId).toBeUndefined();
      const last = hostRecord(scope, p, 'input-a', usage(`${prefix}-3`, 40));
      expect(last.usage.inputTokens).toBe(70);
      expect(last.usage.cacheReadInputTokens).toBe(21);
      expect(
        hostRecord(scope, p, 'input-a', usage(`${prefix}-3`, 40)).usage,
      ).toEqual(last.usage);
      const ledger = probe
        .prepare(
          'SELECT COUNT(*) AS n, SUM(input_tokens) AS tokens FROM usage_events WHERE event_id LIKE ?',
        )
        .get(`${prefix}-%`) as any;
      expect(ledger).toEqual({ n: 3, tokens: 70 });
    });
    test(`${scope}: warm B raw events cannot attach to or change prior A row`, () => {
      const prefix = `${scope}-${serial++}`;
      const p = new InputUsageProjection('input-a');
      const before = hostRecord(
        scope,
        p,
        'input-a',
        usage(`${prefix}-a`),
      ).usage;
      db.ensureChatExists('web:projection');
      db.storeMessageDirect(
        `${prefix}-reply-a`,
        'web:projection',
        'assistant',
        'A',
        'done',
        new Date().toISOString(),
        true,
        {
          tokenUsage: JSON.stringify(before),
          meta: { turnId: `${prefix}-input-a`, sourceKind: 'sdk_final' },
        },
      );
      p.bindMessage('input-a', `${prefix}-reply-a`);
      p.complete('input-a');
      p.admit('input-b');
      const b = hostRecord(scope, p, 'input-b', usage(`${prefix}-b`, 50));
      expect(b.usage.inputTokens).toBe(50);
      expect(p.messageId('input-b')).toBeUndefined();
      const attribution = probe
        .prepare('SELECT message_id FROM usage_events WHERE event_id = ?')
        .get(`${prefix}-b`) as any;
      expect(attribution.message_id).toBeNull();
      const row = probe
        .prepare('SELECT token_usage FROM messages WHERE id = ?')
        .get(`${prefix}-reply-a`) as any;
      expect(JSON.parse(row.token_usage)).toEqual(before);
      expect(p.snapshot('input-a')).toEqual(before);
    });
  }
  test('hard bound never evicts live inputs or recreates a retired input from late usage', () => {
    const p = new InputUsageProjection('a', 2);
    expect(p.admit('b')).toBe(true);
    expect(p.admit('c')).toBe(false);
    p.complete('a');
    expect(p.admit('c')).toBe(true);
    expect(
      p.record('a', usage('late'), {
        eventId: 'late',
        inserted: true,
        providerEstimatedCostUSD: 1,
      }),
    ).toBeUndefined();
    expect(
      p.record('unknown', usage('bad'), {
        eventId: 'bad',
        inserted: true,
        providerEstimatedCostUSD: 1,
      }),
    ).toBeUndefined();
    p.rollback('c');
    expect(p.admit('d')).toBe(true);
  });
  for (const scope of ['agent'] as const) {
    test(`${scope}: late usage persists only its exact A row after B is active`, () => {
      const prefix = `late-${scope}-${serial++}`;
      const p = new InputUsageProjection('a');
      p.admit('b');
      const chatJid = 'web:projection';
      const virtualChatJid = `${chatJid}#agent:projection-agent`;
      const jid = scope === 'main' ? chatJid : virtualChatJid;
      db.ensureChatExists(jid);
      for (const input of ['a', 'b']) {
        hostRecord(scope, p, input, usage(`${prefix}-${input}`));
        db.storeMessageDirect(
          `${prefix}-row-${input}`,
          jid,
          'assistant',
          'A',
          input,
          new Date().toISOString(),
          true,
          {
            tokenUsage: JSON.stringify(p.snapshot(input)),
            meta: { turnId: `${prefix}-${input}`, sourceKind: 'sdk_final' },
          },
        );
        p.bindMessage(input, `${prefix}-row-${input}`);
      }
      const beforeB = probe
        .prepare('SELECT token_usage FROM messages WHERE id = ?')
        .get(`${prefix}-row-b`) as any;
      hostRecord(scope, p, 'a', usage(`${prefix}-late-a`, 30));
      let statement: ts.IfStatement | undefined;
      const owner =
        scope === 'main'
          ? 'inputUsageProjection.snapshot(result.inputTurnId)'
          : 'agentInputUsageProjection.snapshot(output.inputTurnId)';
      const walk = (node: ts.Node) => {
        if (
          ts.isIfStatement(node) &&
          node.expression.getText(ast).includes("'usage'") &&
          node.thenStatement.getText(ast).includes(owner) &&
          node.thenStatement
            .getText(ast)
            .includes('updateLatestMessageTokenUsage')
        )
          statement = node;
        ts.forEachChild(node, walk);
      };
      walk(ast);
      expect(statement).toBeDefined();
      const args = {
        result: { inputTurnId: 'a' },
        output: {
          inputTurnId: 'a',
          streamEvent: { eventType: 'usage', usage: usage('stream') },
        },
        se: { eventType: 'usage', usage: usage('stream') },
        inputUsageProjection: p,
        agentInputUsageProjection: p,
        chatJid,
        virtualChatJid,
        effectiveGroup: { folder: 'projection-test' },
        registeredGroups: {},
        agentId: 'projection-agent',
        updateLatestMessageTokenUsage: db.updateLatestMessageTokenUsage,
        broadcastOwnerBillingUsage: vi.fn(),
        logger: { debug: vi.fn(), warn: vi.fn() },
        getUserById: vi.fn(),
      };
      new Function(...Object.keys(args), compile(statement!.getText(ast)))(
        ...Object.values(args),
      );
      const afterA = probe
        .prepare('SELECT token_usage FROM messages WHERE id = ?')
        .get(`${prefix}-row-a`) as any;
      const afterB = probe
        .prepare('SELECT token_usage FROM messages WHERE id = ?')
        .get(`${prefix}-row-b`) as any;
      expect(JSON.parse(afterA.token_usage).inputTokens).toBe(40);
      expect(afterB.token_usage).toBe(beforeB.token_usage);
    });
  }
  test('production Agent final writes and broadcasts the full input total', () => {
    const p = new InputUsageProjection('agent-input');
    const prefix = `agent-final-${serial++}`;
    hostRecord('agent', p, 'agent-input', usage(`${prefix}-1`));
    hostRecord('agent', p, 'agent-input', usage(`${prefix}-2`, 40));
    const start = source.indexOf(
      '        const tokenUsage = agentInputUsageProjection.snapshot(\n          outputAgentScope.inputId,',
    );
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('        // Persistence/Web projection', start);
    const projected: any[] = [];
    const args = {
      agentInputUsageProjection: p,
      outputAgentScope: { inputId: 'agent-input' },
      msgId: `${prefix}-row`,
      virtualChatJid: 'web:agent-final#agent:projection-agent',
      ASSISTANT_NAME: 'HappyClaw',
      dbText: 'done',
      timestamp: new Date().toISOString(),
      dbTurnId: 'agent-input',
      output: {},
      currentAgentSessionId: undefined,
      holdReason: null,
      activeAgentWorkflowRuns: [],
      completedAgentWorkflowRuns: [],
      heldAgentDbMsgId: null,
      heldAgentDbTurnId: null,
      storeMessageDirect: db.storeMessageDirect,
      updateLatestMessageTokenUsage: db.updateLatestMessageTokenUsage,
      broadcastNewMessage: (_jid: string, row: any) => projected.push(row),
      // Turn traces are covered by turn-trace.test.ts; the final's usage is
      // what matters here.
      turnTraces: { persist: () => false },
      agentId: 'projection-agent',
    };
    db.ensureChatExists(args.virtualChatJid);
    new Function(...Object.keys(args), compile(source.slice(start, end)))(
      ...Object.values(args),
    );
    const row = probe
      .prepare('SELECT token_usage FROM messages WHERE id = ?')
      .get(`${prefix}-row`) as any;
    expect(JSON.parse(row.token_usage).inputTokens).toBe(50);
    expect(projected[0].token_usage).toBe(row.token_usage);
    expect(p.messageId('agent-input')).toBe(`${prefix}-row`);
  });
  test('workspace/main/agent collectors and returned snapshots remain isolated', () => {
    const a = new InputUsageProjection('same');
    const b = new InputUsageProjection('same');
    a.record('same', usage('a'), {
      eventId: 'a',
      inserted: true,
      providerEstimatedCostUSD: 0.01,
    });
    const value = a.snapshot('same')!;
    value.inputTokens = 999;
    expect(a.snapshot('same')!.inputTokens).toBe(10);
    expect(b.snapshot('same')).toBeUndefined();
    expect(
      a.record('same', usage('other'), {
        eventId: 'wrong',
        inserted: true,
        providerEstimatedCostUSD: 1,
      }),
    ).toBeUndefined();
  });
  test('production main final persistence and WebSocket carry the same total as REST', async () => {
    const declaration = ast.statements.find(
      (n) =>
        ts.isFunctionDeclaration(n) &&
        n.name?.text === 'sendMessageWithOutcome',
    )!;
    const projected: any[] = [];
    const args = {
      getChannelType: () => null,
      crypto,
      ASSISTANT_NAME: 'HappyClaw',
      ensureChatExists: db.ensureChatExists,
      storeMessageDirect: db.storeMessageDirect,
      updateLatestMessageTokenUsage: db.updateLatestMessageTokenUsage,
      broadcastNewMessage: (_jid: string, row: any) => projected.push(row),
      broadcastToWebClients: vi.fn(),
      logger: { info: vi.fn(), error: vi.fn() },
    };
    const persist = new Function(
      ...Object.keys(args),
      `${compile(declaration.getText(ast))}; return sendMessageWithOutcome;`,
    )(...Object.values(args));
    const total = { ...usage('not-a-billing-event', 70), costUSD: 0.03 };
    const result = await persist('web:final-projection', 'done', {
      tokenUsage: total,
      messageMeta: { turnId: 'canonical-final', sourceKind: 'sdk_final' },
    });
    expect(result.webProjected).toBe(true);
    const row = probe
      .prepare('SELECT token_usage FROM messages WHERE id = ?')
      .get(result.messageId) as any;
    expect(JSON.parse(row.token_usage)).toEqual(total);
    expect(projected[0].token_usage).toBe(row.token_usage);
  });
  for (const scope of ['agent'] as const) {
    test(`${scope}: held truncation finalizer retains the full input total`, async () => {
      const prefix = `held-${scope}-${serial++}`;
      const p = new InputUsageProjection(prefix);
      hostRecord(scope, p, prefix, usage(`${prefix}-first`));
      hostRecord(scope, p, prefix, usage(`${prefix}-last`, 20));
      let declaration: ts.VariableDeclaration | undefined;
      const name =
        scope === 'main'
          ? 'finalizeHeldDbMessage'
          : 'finalizeHeldAgentDbMessage';
      const walk = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name)
          declaration = node;
        ts.forEachChild(node, walk);
      };
      walk(ast);
      expect(declaration).toBeDefined();
      const jid = `web:${prefix}`;
      db.ensureChatExists(jid);
      const rowId = `${prefix}-row`;
      db.storeMessageDirect(
        rowId,
        jid,
        'assistant',
        'A',
        'progress',
        new Date().toISOString(),
        true,
        { meta: { turnId: prefix, sourceKind: 'sdk_final' } },
      );
      const projected: any[] = [];
      const args = {
        inputUsageProjection: p,
        agentInputUsageProjection: p,
        heldDbTurnId: prefix,
        heldAgentDbTurnId: prefix,
        heldAgentDbMsgId: rowId,
        heldCardParts: ['progress'],
        heldAgentParts: ['progress'],
        HELD_TURN_DIVIDER: '\n\n',
        chatJid: jid,
        virtualChatJid: jid,
        ASSISTANT_NAME: 'HappyClaw',
        agentId: 'agent',
        activeSessionId: 'session',
        currentAgentSessionId: 'session',
        storeMessageDirect: db.storeMessageDirect,
        updateLatestMessageTokenUsage: db.updateLatestMessageTokenUsage,
        logger: { warn: vi.fn() },
        turnTraces: { persist: () => false },
        broadcastNewMessage: (_jid: string, row: any) => projected.push(row),
        sendMessage: async (_jid: string, content: string, opts: any) => {
          db.storeMessageDirect(
            rowId,
            jid,
            'assistant',
            'A',
            content,
            new Date().toISOString(),
            true,
            {
              tokenUsage: JSON.stringify(opts.tokenUsage),
              meta: opts.messageMeta,
            },
          );
          projected.push({ token_usage: JSON.stringify(opts.tokenUsage) });
          return rowId;
        },
      };
      const fn = new Function(
        ...Object.keys(args),
        `${compile(`const finalize = ${declaration!.initializer!.getText(ast)};`)}; return finalize;`,
      )(...Object.values(args));
      await fn('stream truncated', 'truncated');
      const row = probe
        .prepare('SELECT token_usage FROM messages WHERE id = ?')
        .get(rowId) as any;
      expect(JSON.parse(row.token_usage).inputTokens).toBe(30);
      expect(projected[0].token_usage).toBe(row.token_usage);
    });
  }
});
