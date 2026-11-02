import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-outbox-scope-'));
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
const { ChannelTurnRuntime } = await import('../src/channel-turn-runtime.js');
const { ActiveChannelOutboxScopeRegistry } =
  await import('../src/channel-outbox-runtime-scope.js');

const repoRoot = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

// A legacy QQ C2C address: no account fragment, no thread, no root. This is the
// shape that first exposed the regression, because Proactive mode makes the MCP
// send the only delivery path.
const c2cJid = 'qq:c2c:openid-fixture';
const route = {
  provider: 'qq',
  accountId: 'bot-fixture',
  sourceJid: c2cJid,
  chatId: 'c2c:openid-fixture',
  rootId: null,
  threadId: null,
};

// Warm admission owns two distinct ids for one turn:
//   - the native/durable message id, which keys Turn idempotency
//   - a random IPC deliveryId, which is what the runner echoes back on output
const nativeMessageId = 'msg-warm-fixture';
const ipcDeliveryId = 'delivery-warm-fixture';

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('warm channel outbox scope correlation', () => {
  test('a warm turn runtime is still keyed by the native message id', () => {
    const runtime = ChannelTurnRuntime.start({
      ...route,
      externalMessageId: nativeMessageId,
    });
    try {
      // Guards the durable-idempotency fix: warm admission must NOT go back to
      // seeding the runtime from the random deliveryId.
      expect(runtime.inputTurnId).toBe(nativeMessageId);
      expect(runtime.inputTurnId).not.toBe(ipcDeliveryId);
    } finally {
      runtime.dispose();
    }
  });

  test('scope bound with the deliveryId resolves the runner-reported input', () => {
    const registry = new ActiveChannelOutboxScopeRegistry();
    const runtime = ChannelTurnRuntime.start({
      ...route,
      externalMessageId: `${nativeMessageId}-resolves`,
    });
    try {
      const scope = registry.bind('workspace', {
        ...route,
        turnRunId: runtime.runId,
        // What the fixed warm call sites pass explicitly.
        inputTurnId: ipcDeliveryId,
        logicalBaseChatJid: 'web:workspace-at-admission',
        owner: 'owner-warm',
      });

      expect(registry.resolveInput('workspace', ipcDeliveryId, c2cJid)).toEqual(
        scope,
      );
      expect(registry.resolveToken('workspace', scope.token, c2cJid)).toEqual(
        scope,
      );
      expect(
        registry.resolveInput('workspace', ipcDeliveryId, c2cJid)
          ?.logicalBaseChatJid,
      ).toBe('web:workspace-at-admission');
    } finally {
      runtime.dispose();
    }
  });

  test('scope bound with the native message id cannot resolve the deliveryId', () => {
    const registry = new ActiveChannelOutboxScopeRegistry();
    const runtime = ChannelTurnRuntime.start({
      ...route,
      externalMessageId: `${nativeMessageId}-regression`,
    });
    try {
      // Reproduces the regression: binding from runtime.inputTurnId on the warm
      // path leaves the registry keyed by an id the runner never reports, so
      // every MCP-sent output fails closed before reaching the connector.
      registry.bind('workspace', {
        ...route,
        turnRunId: runtime.runId,
        inputTurnId: runtime.inputTurnId,
        owner: 'owner-warm-regression',
      });

      expect(
        registry.resolveInput('workspace', ipcDeliveryId, c2cJid),
      ).toBeNull();
    } finally {
      runtime.dispose();
    }
  });

  test('resolveInput still refuses a matching id on a different route', () => {
    const registry = new ActiveChannelOutboxScopeRegistry();
    registry.bind('workspace', {
      ...route,
      turnRunId: 'turn-route-fence',
      inputTurnId: ipcDeliveryId,
      owner: 'owner-route-fence',
    });

    expect(
      registry.resolveInput('workspace', ipcDeliveryId, 'qq:c2c:other-fixture'),
    ).toBeNull();
  });
});

describe('warm channel outbox scope wiring contract', () => {
  test('bindChannelOutboxScope takes an explicit correlation id, defaulting to the runtime', () => {
    const host = read('src/index.ts');
    const signature = section(
      host,
      'function bindChannelOutboxScope(',
      'return activeChannelOutboxScopes.bind(',
    );
    expect(signature).toMatch(
      /inputTurnId:\s*string\s*\|\s*undefined\s*=\s*runtime\.inputTurnId/,
    );
    const body = section(
      host,
      'return activeChannelOutboxScopes.bind(',
      'function channelOutboxRefForInput(',
    );
    // The bound scope must carry the parameter, never re-derive it.
    expect(body).toMatch(/\n\s*inputTurnId,\n/);
    expect(body).not.toMatch(/inputTurnId:\s*runtime\.inputTurnId/);
  });

  test('a warm admission binds the scope with the IPC deliveryId', () => {
    const host = read('src/index.ts');
    const agentAdmission = section(
      host,
      'activeRouteAdmissions.set(\n    agentAdmissionKey,',
      'admittedWarmAgentInputs.set(inputTurnId, {',
    );
    expect(agentAdmission).toMatch(
      /bindChannelOutboxScope\(\s*agentAdmissionKey,[\s\S]*?\n\s*inputTurnId,\n\s*\);/,
    );
    // The runtime itself stays on the native message id (durable idempotency).
    expect(agentAdmission).toMatch(
      /externalMessageId:\s*inputCursor\?\.id \?\? inputTurnId/,
    );
  });

  test('cold turns keep relying on the runtime default', () => {
    const host = read('src/index.ts');
    // On the cold path the runtime is started from lastProcessed.id, which is
    // also the ContainerInput.turnId the runner reports, so the default is
    // already correct and must not be overridden with an unrelated id.
    expect(host).toContain(
      'agentChannelOutboxScopesByInput.set(\n        lastProcessed.id,',
    );
    expect(host).toContain('externalMessageId: lastProcessed.id,');
  });

  test('the runner correlates warm output with its IPC deliveryId', () => {
    const runner = read('container/agent-runner/src/index.ts');
    const tools = read('container/agent-runner/src/mcp-tools.ts');
    // Counterpart of the host-side fix. If this ever changes back to the plain
    // turn id, the host must be revisited in the same commit.
    expect(
      runner.match(
        /mcpToolsConfig\.currentInputTurnId =\s*\n?\s*latestIpcDeliveryId\(/g,
      )?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(tools).toMatch(/data\.inputTurnId = ctx\.currentInputTurnId;/);
  });

  test('an unresolvable scope logs the correlation id it failed to match', () => {
    const host = read('src/index.ts');
    const suppression = section(
      host,
      'async function deliverScopedChannelOutput(',
      'Suppressed channel side effect because its exact outbox scope is unavailable',
    );
    expect(suppression).toMatch(/scopeToken:\s*ref\.scopeToken,/);
    // `missing:<inputTurnId>` is the token shape that makes a correlation-key
    // mismatch distinguishable from a genuinely expired scope.
    expect(host).toMatch(/scopeToken:\s*scope\?\.token \?\? `missing:\$\{/);
  });

  test('WeChat physical chunks use separate outbox rows and the actual item id', () => {
    const host = read('src/index.ts');
    const send = section(
      host,
      'async function sendImWithRetry(',
      'async function deliverChannelManualReconciliationNotice(',
    );
    expect(send).toContain('prepareWeChatTextChunks(text)');
    expect(send).toMatch(
      /childChannelOutboxRef\(outbox!, weChat \? `text:\$\{index\}`/,
    );
    expect(send).toContain('deliveryId: item.id');
    expect(send).toContain('physicalOutput: weChat');
    expect(send).toContain('ScopedChannelPartialDeliveryError');

    const image = section(
      host,
      'async function sendTaskImageWithRetry(',
      'async function sendTaskFileWithRetry(',
    );
    expect(image).toContain('prepareWeChatTextChunks(caption)');
    expect(image).toContain(
      'childChannelOutboxRef(outbox, `caption:${index}`)',
    );
    expect(image).toContain("childChannelOutboxRef(outbox, 'image')");
    expect(image).toContain('deliveryId: item.id');
  });
});
