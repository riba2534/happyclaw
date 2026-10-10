import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { deliverFeishuScopedText } from '../src/feishu-scoped-text-delivery.js';
import { buildInteractionTextOutboxPayload } from '../src/workspace-interaction-runtime.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-scoped-pages-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });
vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const db = await import('../src/db.js');
const store = await import('../src/channel-reliability-store.js');
const delivery = await import('../src/channel-outbox-delivery.js');
const identities = await import('../src/channel-outbox-runtime-scope.js');
beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

// Execute the actual Host dispatch, caption and Outbox wiring, with SQLite
// delivery transactions and a fake provider. This does not boot index.ts.
const source = ts.createSourceFile(
  'src/index.ts',
  fs.readFileSync('src/index.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const names = new Set([
  'childChannelOutboxRef',
  'isLogicalSessionSendTarget',
  'imageAlreadyDeliveredInTurn',
  'turnInputAnchorOptions',
  'ScopedChannelDeliveryError',
  'ScopedChannelPartialDeliveryError',
  'deliverScopedChannelOutput',
  'settleFeishuCapacityReplacement',
  'sendImWithRetry',
  'sendTaskImageWithRetry',
]);
const declarations = source.statements.filter(
  (node) =>
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
    node.name &&
    names.has(node.name.text),
);
expect(declarations).toHaveLength(names.size);
const compiled = ts.transpileModule(
  declarations.map((node) => node.getText(source)).join('\n'),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  },
).outputText;

function harness(
  name: string,
  provider: (text: string, options: any) => Promise<void> = async () => {},
  correlationId?: string,
) {
  const route = {
    provider: 'feishu',
    accountId: 'bot',
    sourceJid: 'feishu:oc_test',
    chatId: 'oc_test',
    rootId: null,
    threadId: null,
  };
  const run = store.createChannelTurnRun({
    ...route,
    idempotencyKey: name,
    correlationId,
  }).run;
  const scope = { ...route, turnRunId: run.id, owner: `owner:${name}` };
  const sent: Array<{ kind: string; text?: string; options?: any }> = [];
  const imManager = {
    isChannelAvailableForJid: () => true,
    sendMessage: vi.fn(async (_jid, text, _images, options) => {
      sent.push({ kind: 'text', text, options });
      await provider(text, options);
    }),
    sendImage: vi.fn(async (_jid, _buffer, _mime, caption, _file, options) => {
      sent.push({ kind: 'image', text: caption, options });
    }),
  };
  const context = vm.createContext({
    Buffer,
    crypto,
    fs,
    path,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    imManager,
    imSendFailCounts: new Map(),
    getChannelType: () => 'feishu',
    activeChannelOutboxScopes: { resolveToken: () => scope },
    getChannelTurnRun: store.getChannelTurnRun,
    getChannelOutboxItem: store.getChannelOutboxItem,
    getUncertainChannelOutboxForTurn: store.getUncertainChannelOutboxForTurn,
    markFeishuCapacityReplacementDelivered:
      store.markFeishuCapacityReplacementDelivered,
    CHANNEL_RELIABILITY_TERMINAL_STATUSES:
      store.CHANNEL_RELIABILITY_TERMINAL_STATUSES,
    semanticChannelOutboxIdentity: identities.semanticChannelOutboxIdentity,
    stableChannelOutboxOrdinal: identities.stableChannelOutboxOrdinal,
    syntheticChannelProviderAck: identities.syntheticChannelProviderAck,
    FEISHU_UNCERTAIN_REPLAY_DELAY_MS: 0,
    FEISHU_OUTBOX_LEASE_MS: 120_000,
    deliverChannelOutboxItem: delivery.deliverChannelOutboxItem,
    hasDeliveredChannelImageWithContentHash:
      store.hasDeliveredChannelImageWithContentHash,
    rememberChannelOutboxFailure: () => ({}),
    buildInteractionTextOutboxPayload,
    deliverFeishuScopedText,
  });
  vm.runInContext(compiled, context);
  const ref = { scopeKey: 'scope', scopeToken: 'token', operationKey: 'reply' };
  return {
    run,
    sent,
    imManager,
    send: (text: string, failure: any = {}) =>
      context.sendImWithRetry(
        route.sourceJid,
        text,
        [],
        ref,
        { presentation: 'native' },
        undefined,
        failure,
      ),
    sendTo: (jid: string, text: string, failure: any = {}) =>
      context.sendImWithRetry(
        jid,
        text,
        [],
        ref,
        { presentation: 'native' },
        undefined,
        failure,
      ),
    image: (caption: string, failure: any = {}) =>
      context.sendTaskImageWithRetry(
        route.sourceJid,
        Buffer.from('image'),
        'image/png',
        caption,
        'image.png',
        ref,
        failure,
      ),
  };
}

describe('Feishu native physical pages through Host Outbox', () => {
  test('a fitting reply remains one physical native page and reuses its existing receipt', async () => {
    const h = harness('single');
    const text = 'a'.repeat(120000);
    expect(await h.send(text)).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text).toBe(text);
    expect(h.sent[0].options.physicalOutput).toBe(true);
    expect(h.sent[0].options.presentation).toBe('native');
    expect(
      store.getChannelOutboxItem(h.sent[0].options.deliveryId)?.status,
    ).toBe('delivered');
    expect(await h.send(text)).toBe(true);
    expect(h.sent).toHaveLength(1);
  });

  test('a multipart native reply uses independent durable pages and preserves every character', async () => {
    const h = harness('multipart');
    const text = '中文🙂'.repeat(35000);
    expect(await h.send(text)).toBe(true);
    expect(h.sent.length).toBeGreaterThan(1);
    expect(h.sent.map((event) => event.text).join('')).toBe(text);
    expect(new Set(h.sent.map((event) => event.options.deliveryId)).size).toBe(
      h.sent.length,
    );
    expect(h.sent.every((event) => event.options.physicalOutput)).toBe(true);
    const count = h.sent.length;
    expect(await h.send(text)).toBe(true);
    expect(h.sent).toHaveLength(count);
  });

  test('definite capacity parents retire only after all replacement children ACK, and replay sends nothing', async () => {
    const accepted: string[] = [];
    const h = harness('adaptive', async (text) => {
      if (Buffer.byteLength(text) > 65000)
        throw new delivery.DefinitiveChannelDeliveryError(
          'Feishu failed (code=230025, msg=over max size)',
        );
      accepted.push(text);
    });
    const text = 'a'.repeat(120000);
    expect(await h.send(text)).toBe(true);
    expect(accepted.join('')).toBe(text);
    expect(store.getFailedChannelOutboxForTurn(h.run.id)).toBeUndefined();
    const parent = store.getChannelOutboxItem(h.sent[0].options.deliveryId)!;
    expect(parent.status).toBe('cancelled');
    expect(JSON.parse(parent.error!)).toMatchObject({
      kind: 'feishu_capacity_replaced',
      code: 230025,
      replacementBudget: 120000,
      payloadHash: parent.payloadHash,
    });
    const sends = h.sent.length;
    expect(await h.send(text)).toBe(true);
    expect(h.sent).toHaveLength(sends);
    expect(
      store.markFeishuCapacityReplacementDelivered(
        parent.id,
        'different payload',
        120000,
      ),
    ).toBe(false);
  });

  test.each(['uncertain', 'rejected'] as const)(
    'a %s child stops the tail and cannot retire or resend its size parent',
    async (mode) => {
      let accepted = 0;
      const h = harness(`tail-${mode}`, async (text) => {
        if (text.length > 65000)
          throw new delivery.DefinitiveChannelDeliveryError(
            'code=230025 too large',
          );
        // `>= 2`: an uncertain page is replayed once with the same identity
        // (Feishu uuid); it only stays uncertain when the replay is too.
        if (++accepted >= 2) {
          if (mode === 'uncertain')
            throw new Error('ACK lost after accept (code=230025)');
          throw new delivery.DefinitiveChannelDeliveryError(
            'code=230001 invalid field',
          );
        }
      });
      const text = 'a'.repeat(120000);
      const failure: any = {};
      expect(await h.send(text, failure)).toBe(false);
      expect(failure.error.deliveredOutputs).toBe(1);
      const parent = store.getChannelOutboxItem(h.sent[0].options.deliveryId)!;
      expect(parent.status).toBe('failed');
      expect(Boolean(store.getUncertainChannelOutboxForTurn(h.run.id))).toBe(
        mode === 'uncertain',
      );
      const sends = h.sent.length;
      expect(await h.send(text)).toBe(false);
      expect(h.sent).toHaveLength(sends);
    },
  );

  test("every physical output names the turn's own input as its reply anchor", async () => {
    const h = harness('anchor', async () => {}, 'om_turn_input');
    expect(await h.send('reply text')).toBe(true);
    expect(await h.image('caption')).toBe(true);
    expect(h.sent.length).toBeGreaterThanOrEqual(3);
    for (const event of h.sent) {
      expect(event.options.inputMessageId).toBe('om_turn_input');
    }
  });

  test('an ACK-lost page is replayed once with the same delivery identity and converges', async () => {
    let calls = 0;
    const h = harness('ack-lost-replay', async () => {
      if (++calls === 1) throw new Error('socket hang up after write');
    });
    expect(await h.send('short reply')).toBe(true);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].options.deliveryId).toBe(h.sent[0].options.deliveryId);
    expect(h.sent[1].options.chunkIndex).toBe(h.sent[0].options.chunkIndex);
    expect(
      store.getChannelOutboxItem(h.sent[0].options.deliveryId)?.status,
    ).toBe('delivered');
    expect(store.getUncertainChannelOutboxForTurn(h.run.id)).toBeUndefined();
  });

  test('a provider retry-later refusal ends failed, never an orphaned retry_wait', async () => {
    const h = harness('retry-later', async () => {
      throw new delivery.DefinitiveChannelDeliveryError('rate limited', {
        retryAt: new Date(Date.now() + 60_000).toISOString(),
      });
    });
    const failure: any = {};
    expect(await h.send('short reply', failure)).toBe(false);
    const row = store.getChannelOutboxItem(h.sent[0].options.deliveryId)!;
    expect(row.status).toBe('failed');
    expect(failure.error.status).toBe('failed');
    expect(failure.error.deliveryPhase).toBe('rejected');
  });

  test('a logical #agent: session JID is never handed to the connector', async () => {
    const h = harness('logical-target');
    const failure: any = {};
    const delivered = await h.sendTo(
      'feishu:oc_test#agent:session-1',
      'hello',
      failure,
    );
    expect(delivered).toBe(false);
    expect(h.sent).toHaveLength(0);
    expect(failure.error.status).toBe('failed');
  });

  test('image is delivered before independently paginated native captions and is not replayed', async () => {
    const h = harness('caption');
    const caption = '说明'.repeat(40000);
    expect(await h.image(caption)).toBe(true);
    expect(h.sent[0].kind).toBe('image');
    expect(h.sent[0].text).toBeUndefined();
    expect(
      h.sent
        .slice(1)
        .map((event) => event.text)
        .join(''),
    ).toBe(caption);
    expect(
      h.sent
        .slice(1)
        .every(
          (event) =>
            event.options.presentation === 'native' &&
            event.options.physicalOutput,
        ),
    ).toBe(true);
    const count = h.sent.length;
    expect(await h.image(caption)).toBe(true);
    expect(h.sent).toHaveLength(count);
  });
});
