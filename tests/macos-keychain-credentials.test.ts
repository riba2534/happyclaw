import { describe, expect, test, vi } from 'vitest';

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock('../src/logger.js', () => ({
  logger: {
    warn: warnMock,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  claudeKeychainOwnershipServiceName,
  claudeKeychainServiceName,
  isClearedClaudeAiOauth,
  MacosKeychainCredentialError,
  MacosKeychainCredentialStore,
  mergeClaudeKeychainPayload,
  normalizeClaudeAiOauth,
  type SecurityCommandRunner,
} from '../src/macos-keychain-credentials.js';

const CONFIG_DIR = '/Users/test/data/sessions/main/.claude';
const OAUTH = {
  accessToken: 'sk-ant-oat01-old',
  refreshToken: 'sk-ant-ort01-old',
  expiresAt: 1_800_000_000_000,
  scopes: ['user:profile', 'user:inference'],
  subscriptionType: 'max',
};
const REFRESHED = {
  accessToken: 'sk-ant-oat01-refreshed',
  refreshToken: 'sk-ant-ort01-refreshed',
  expiresAt: 1_800_003_600_000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
};

// The shape Claude Code leaves behind after an OAuth account is revoked.
const CLEARED_BY_CLAUDE_CODE = {
  accessToken: '',
  refreshToken: '',
  expiresAt: 0,
  scopes: [],
};

type SecurityRequest = Parameters<SecurityCommandRunner>[0];

function decodeInteractiveToken(token: string): string {
  return token.startsWith('"') ? (JSON.parse(token) as string) : token;
}

function parseInteractiveWrite(stdin: string): {
  service: string;
  payload: string;
} {
  const tokens = stdin.trim().match(/"(?:\\.|[^"\\])*"|\S+/g) ?? [];
  const decoded = tokens.map(decodeInteractiveToken);
  return {
    service: decoded[decoded.indexOf('-s') + 1],
    payload: decoded[decoded.indexOf('-w') + 1],
  };
}

class FakeKeychain {
  readonly items = new Map<string, string>();
  readonly requests: SecurityRequest[] = [];
  failReads = false;
  failWrites = false;
  beforeRequest?: (request: SecurityRequest) => Promise<void> | void;

  readonly runner: SecurityCommandRunner = async (request) => {
    this.requests.push(request);
    await this.beforeRequest?.(request);
    if (request.args[0] === 'find-generic-password') {
      if (this.failReads) throw new Error('keychain locked');
      const service = request.args[request.args.indexOf('-s') + 1];
      const value = this.items.get(service);
      if (value === undefined) {
        const error = new Error('security exit 44') as Error & {
          stderr: string;
        };
        error.stderr =
          'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.';
        throw error;
      }
      return { stdout: value, stderr: '' };
    }
    if (this.failWrites) throw new Error('keychain locked');
    // Writes arrive either as `security -i` (command on stdin) or, when the
    // payload would overflow security's 4096-byte stdin line buffer, as a plain
    // argv invocation. Model both, and reproduce the real truncation so a
    // regression cannot pass silently.
    if (request.args[0] === '-i') {
      const line = request.stdin ?? '';
      if (Buffer.byteLength(line, 'utf8') > 4096) {
        throw new Error('security: unknown command (line truncated at 4096)');
      }
      const { service, payload } = parseInteractiveWrite(line);
      this.items.set(service, payload);
      return { stdout: '', stderr: '' };
    }
    expect(request.args[0]).toBe('add-generic-password');
    const service = request.args[request.args.indexOf('-s') + 1];
    const payload = request.args[request.args.indexOf('-w') + 1];
    this.items.set(service, payload);
    return { stdout: '', stderr: '' };
  };

  store(platform: NodeJS.Platform = 'darwin'): MacosKeychainCredentialStore {
    return new MacosKeychainCredentialStore(
      platform,
      () => 'test-user',
      this.runner,
    );
  }
}

describe('Claude Keychain naming and payload normalization', () => {
  test('matches Claude Code service derivation and isolates ownership metadata', () => {
    expect(claudeKeychainServiceName(CONFIG_DIR)).toBe(
      'Claude Code-credentials-e788ff65',
    );
    expect(claudeKeychainOwnershipServiceName(CONFIG_DIR)).toBe(
      'Claude Code-credentials-e788ff65.happyclaw-provider-owner',
    );
  });

  test('normalizes scope ordering and compares every managed OAuth field', () => {
    const existing = JSON.stringify({
      claudeAiOauth: OAUTH,
      mcpOAuth: { keep: { clientId: 'mcp-client' } },
    });
    expect(
      mergeClaudeKeychainPayload(existing, {
        ...OAUTH,
        scopes: [...OAUTH.scopes].reverse(),
      }),
    ).toBeNull();

    for (const changed of [
      { ...OAUTH, refreshToken: 'different-refresh' },
      { ...OAUTH, expiresAt: OAUTH.expiresAt + 1 },
      { ...OAUTH, scopes: ['user:inference'] },
      { ...OAUTH, subscriptionType: 'pro' },
    ]) {
      const merged = mergeClaudeKeychainPayload(existing, changed);
      const parsed = JSON.parse(merged!);
      expect(parsed.claudeAiOauth).toEqual(normalizeClaudeAiOauth(changed));
      expect(parsed.mcpOAuth.keep.clientId).toBe('mcp-client');
    }
  });

  test('fails closed for invalid credential JSON and invalid OAuth shapes', () => {
    expect(() => mergeClaudeKeychainPayload('not-json', OAUTH)).toThrow(
      MacosKeychainCredentialError,
    );
    expect(() => mergeClaudeKeychainPayload('[1,2]', OAUTH)).toThrow(
      MacosKeychainCredentialError,
    );
    expect(() =>
      mergeClaudeKeychainPayload(
        JSON.stringify({ claudeAiOauth: { accessToken: 'partial' } }),
        OAUTH,
      ),
    ).toThrow(MacosKeychainCredentialError);
  });
});

describe('MacosKeychainCredentialStore', () => {
  test.each<NodeJS.Platform>(['linux', 'win32', 'freebsd'])(
    'is a no-op on %s',
    async (platform) => {
      const fake = new FakeKeychain();
      const store = fake.store(platform);
      await expect(
        store.reconcile(CONFIG_DIR, {
          providerId: 'official-a',
          claudeAiOauth: OAUTH,
        }),
      ).resolves.toEqual(normalizeClaudeAiOauth(OAUTH));
      await expect(
        store.remove(CONFIG_DIR, 'gateway-a'),
      ).resolves.toBeUndefined();
      expect(fake.requests).toHaveLength(0);
    },
  );

  test('records ownership when the Claude item is missing and keeps secrets out of argv', async () => {
    const fake = new FakeKeychain();
    await fake.store().reconcile(CONFIG_DIR, {
      providerId: 'official-a',
      claudeAiOauth: OAUTH,
    });

    expect(fake.items.has(claudeKeychainServiceName(CONFIG_DIR))).toBe(false);
    const ownership = JSON.parse(
      fake.items.get(claudeKeychainOwnershipServiceName(CONFIG_DIR))!,
    );
    expect(ownership).toMatchObject({ version: 1, providerId: 'official-a' });
    const write = fake.requests.find((request) => request.args[0] === '-i')!;
    expect(JSON.stringify(write.args)).not.toContain(OAUTH.accessToken);
    expect(JSON.stringify(write.args)).not.toContain(OAUTH.refreshToken);
    expect(write.stdin).not.toContain(OAUTH.accessToken);
  });

  test('switches providers while preserving MCP OAuth and sends payload only over stdin', async () => {
    const fake = new FakeKeychain();
    const service = claudeKeychainServiceName(CONFIG_DIR);
    fake.items.set(
      service,
      JSON.stringify({
        claudeAiOauth: OAUTH,
        mcpOAuth: { keep: 'mcp-secret' },
      }),
    );
    await fake.store().reconcile(CONFIG_DIR, {
      providerId: 'official-a',
      claudeAiOauth: OAUTH,
    });

    const other = {
      ...OAUTH,
      accessToken: 'sk-ant-oat01-other-account',
      refreshToken: 'sk-ant-ort01-other-account',
    };
    await fake.store().reconcile(CONFIG_DIR, {
      providerId: 'official-b',
      claudeAiOauth: other,
    });

    const payload = JSON.parse(fake.items.get(service)!);
    expect(payload.claudeAiOauth).toEqual(normalizeClaudeAiOauth(other));
    expect(payload.mcpOAuth).toEqual({ keep: 'mcp-secret' });
    const mainWrite = [...fake.requests].reverse().find((request) => {
      if (!request.stdin) return false;
      return parseInteractiveWrite(request.stdin).service === service;
    })!;
    expect(JSON.stringify(mainWrite.args)).not.toContain('mcp-secret');
    expect(JSON.stringify(mainWrite.args)).not.toContain(other.accessToken);
    expect(mainWrite.stdin).toContain('mcp-secret');
  });

  test('persists an SDK refresh instead of rolling it back to stale provider credentials', async () => {
    const fake = new FakeKeychain();
    const store = fake.store();
    const service = claudeKeychainServiceName(CONFIG_DIR);
    fake.items.set(
      service,
      JSON.stringify({ claudeAiOauth: OAUTH, mcpOAuth: {} }),
    );
    await store.reconcile(CONFIG_DIR, {
      providerId: 'official-a',
      claudeAiOauth: OAUTH,
    });
    fake.items.set(
      service,
      JSON.stringify({ claudeAiOauth: REFRESHED, mcpOAuth: { keep: true } }),
    );
    const persist = vi.fn(() => true);

    const effective = await store.reconcile(CONFIG_DIR, {
      providerId: 'official-a',
      claudeAiOauth: OAUTH,
      persistRefreshedCredentials: persist,
    });

    expect(effective).toEqual(normalizeClaudeAiOauth(REFRESHED));
    expect(persist).toHaveBeenCalledWith(
      normalizeClaudeAiOauth(OAUTH),
      normalizeClaudeAiOauth(REFRESHED),
    );
    expect(JSON.parse(fake.items.get(service)!).claudeAiOauth).toEqual(
      REFRESHED,
    );
  });

  test('applies an explicit provider credential update when Keychain stayed at the baseline', async () => {
    const fake = new FakeKeychain();
    const store = fake.store();
    const service = claudeKeychainServiceName(CONFIG_DIR);
    fake.items.set(
      service,
      JSON.stringify({ claudeAiOauth: OAUTH, mcpOAuth: {} }),
    );
    await store.reconcile(CONFIG_DIR, {
      providerId: 'official-a',
      claudeAiOauth: OAUTH,
    });
    const updated = { ...OAUTH, expiresAt: OAUTH.expiresAt + 10_000 };

    await store.reconcile(CONFIG_DIR, {
      providerId: 'official-a',
      claudeAiOauth: updated,
    });
    expect(JSON.parse(fake.items.get(service)!).claudeAiOauth).toEqual(
      normalizeClaudeAiOauth(updated),
    );
  });

  // A real Keychain item carrying mcpOAuth for ~10 MCP servers is >5KB, which
  // overflows security's 4096-byte stdin line buffer. Overflow there is
  // silently destructive: security runs the truncated prefix, storing a mangled
  // item, and only then rejects the rest.
  test('writes oversized payloads through argv instead of security -i', async () => {
    const fake = new FakeKeychain();
    const service = claudeKeychainServiceName(CONFIG_DIR);
    const bulkyMcpOAuth = { blob: 'y'.repeat(6000) };
    fake.items.set(
      service,
      JSON.stringify({ claudeAiOauth: OAUTH, mcpOAuth: bulkyMcpOAuth }),
    );
    await fake.store().reconcile(CONFIG_DIR, {
      providerId: 'official-a',
      claudeAiOauth: OAUTH,
    });
    await fake.store().reconcile(CONFIG_DIR, {
      providerId: 'official-b',
      claudeAiOauth: REFRESHED,
    });

    const stored = JSON.parse(fake.items.get(service)!);
    expect(stored.claudeAiOauth).toEqual(normalizeClaudeAiOauth(REFRESHED));
    expect(stored.mcpOAuth).toEqual(bulkyMcpOAuth);
    expect(
      fake.requests.some((r) => r.args[0] === 'add-generic-password'),
    ).toBe(true);
    // the short ownership item still takes the argv-hiding interactive path
    expect(
      fake.requests.some(
        (r) => r.args[0] === '-i' && r.stdin?.includes('provider-owner'),
      ),
    ).toBe(true);
  });

  // Without an ownership item there is nothing to reconcile against, and a
  // multi-account pool can never satisfy a match check — so adopt the selected
  // provider and record ownership instead of blocking host mode permanently.
  test('adopts the selected provider when ownership is unknown', async () => {
    const fake = new FakeKeychain();
    const service = claudeKeychainServiceName(CONFIG_DIR);
    fake.items.set(
      service,
      JSON.stringify({
        claudeAiOauth: REFRESHED,
        mcpOAuth: { 'some-server': 'keep-me' },
      }),
    );

    const migrated = await fake.store().reconcile(CONFIG_DIR, {
      providerId: 'official-a',
      claudeAiOauth: OAUTH,
    });

    expect(migrated).toEqual(normalizeClaudeAiOauth(OAUTH));
    const stored = JSON.parse(fake.items.get(service)!);
    expect(stored.claudeAiOauth).toEqual(normalizeClaudeAiOauth(OAUTH));
    expect(stored.mcpOAuth).toEqual({ 'some-server': 'keep-me' });
    expect(
      JSON.parse(
        fake.items.get(claudeKeychainOwnershipServiceName(CONFIG_DIR))!,
      ).providerId,
    ).toBe('official-a');
  });

  test('fails closed on concurrent changes and failed persistence', async () => {
    const fake = new FakeKeychain();
    const service = claudeKeychainServiceName(CONFIG_DIR);
    fake.items.clear();
    fake.items.set(service, JSON.stringify({ claudeAiOauth: OAUTH }));
    const store = fake.store();
    await store.reconcile(CONFIG_DIR, {
      providerId: 'official-a',
      claudeAiOauth: OAUTH,
    });
    fake.items.set(service, JSON.stringify({ claudeAiOauth: REFRESHED }));
    const adminUpdate = { ...OAUTH, expiresAt: OAUTH.expiresAt + 1234 };
    await expect(
      store.reconcile(CONFIG_DIR, {
        providerId: 'official-a',
        claudeAiOauth: adminUpdate,
        persistRefreshedCredentials: () => true,
      }),
    ).rejects.toThrow('changed concurrently');
    await expect(
      store.reconcile(CONFIG_DIR, {
        providerId: 'official-a',
        claudeAiOauth: OAUTH,
        persistRefreshedCredentials: () => false,
      }),
    ).rejects.toThrow('changed during Keychain reconciliation');
  });

  test('third-party cleanup removes only Claude OAuth and preserves MCP OAuth', async () => {
    const fake = new FakeKeychain();
    const service = claudeKeychainServiceName(CONFIG_DIR);
    fake.items.set(
      service,
      JSON.stringify({
        claudeAiOauth: OAUTH,
        mcpOAuth: { plugin: { clientSecret: 'preserved' } },
      }),
    );

    await fake.store().remove(CONFIG_DIR, 'gateway-a');
    expect(JSON.parse(fake.items.get(service)!)).toEqual({
      mcpOAuth: { plugin: { clientSecret: 'preserved' } },
    });
    expect(
      JSON.parse(
        fake.items.get(claudeKeychainOwnershipServiceName(CONFIG_DIR))!,
      ),
    ).toMatchObject({ providerId: 'gateway-a', credentialFingerprint: null });
  });

  test.each(['read', 'parse', 'write', 'timeout'] as const)(
    'fails closed on Keychain %s errors',
    async (failure) => {
      const fake = new FakeKeychain();
      const service = claudeKeychainServiceName(CONFIG_DIR);
      if (failure === 'read') fake.failReads = true;
      else if (failure === 'parse') fake.items.set(service, 'not-json');
      else if (failure === 'write') fake.failWrites = true;
      else {
        fake.beforeRequest = () => {
          throw new Error('security command timed out');
        };
      }
      await expect(
        fake.store().reconcile(CONFIG_DIR, {
          providerId: 'official-a',
          claudeAiOauth: OAUTH,
        }),
      ).rejects.toThrow(MacosKeychainCredentialError);
    },
  );

  test('serializes concurrent read/modify/write operations for one service', async () => {
    const fake = new FakeKeychain();
    const service = claudeKeychainServiceName(CONFIG_DIR);
    fake.items.set(service, JSON.stringify({ claudeAiOauth: OAUTH }));
    let releaseFirst!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let reads = 0;
    fake.beforeRequest = async (request) => {
      if (request.args[0] !== 'find-generic-password') return;
      reads += 1;
      if (reads <= 2) await blocked;
    };
    const store = fake.store();
    const first = store.reconcile(CONFIG_DIR, {
      providerId: 'official-a',
      claudeAiOauth: OAUTH,
    });
    await vi.waitFor(() => expect(reads).toBe(2));
    const second = store.reconcile(CONFIG_DIR, {
      providerId: 'official-a',
      claudeAiOauth: OAUTH,
    });
    await Promise.resolve();
    expect(reads).toBe(2);
    releaseFirst();
    await Promise.all([first, second]);
    expect(reads).toBe(4);
  });
});

describe('Keychain claudeAiOauth cleared by Claude Code', () => {
  test('recognizes only fully blanked OAuth values as cleared', () => {
    expect(isClearedClaudeAiOauth(CLEARED_BY_CLAUDE_CODE)).toBe(true);
    expect(isClearedClaudeAiOauth({})).toBe(true);
    expect(isClearedClaudeAiOauth({ accessToken: '', refreshToken: '' })).toBe(
      true,
    );
    for (const notCleared of [
      null,
      'cleared',
      [],
      OAUTH,
      { ...CLEARED_BY_CLAUDE_CODE, accessToken: 'sk-ant-oat01-left' },
      { ...CLEARED_BY_CLAUDE_CODE, refreshToken: 'sk-ant-ort01-left' },
      { ...CLEARED_BY_CLAUDE_CODE, expiresAt: OAUTH.expiresAt },
      { ...CLEARED_BY_CLAUDE_CODE, accessToken: null },
      { ...CLEARED_BY_CLAUDE_CODE, expiresAt: '0' },
    ]) {
      expect(isClearedClaudeAiOauth(notCleared)).toBe(false);
    }
  });

  test('replaces a cleared item with the selected provider and preserves MCP OAuth', async () => {
    warnMock.mockClear();
    const fake = new FakeKeychain();
    const service = claudeKeychainServiceName(CONFIG_DIR);
    const ownershipService = claudeKeychainOwnershipServiceName(CONFIG_DIR);
    const mcpOAuth = { plugin: { clientId: 'mcp-client', token: 'mcp-token' } };
    fake.items.set(
      service,
      JSON.stringify({ claudeAiOauth: CLEARED_BY_CLAUDE_CODE, mcpOAuth }),
    );
    // Ownership still points at the revoked account, fingerprinted at the
    // credential HappyClaw last confirmed for it.
    fake.items.set(
      ownershipService,
      JSON.stringify({
        version: 1,
        providerId: 'revoked-account',
        credentialFingerprint: 'f'.repeat(64),
      }),
    );

    const effective = await fake.store().reconcile(CONFIG_DIR, {
      providerId: 'official-b',
      claudeAiOauth: REFRESHED,
      folder: 'main',
    });

    expect(effective).toEqual(normalizeClaudeAiOauth(REFRESHED));
    const stored = JSON.parse(fake.items.get(service)!);
    expect(stored.claudeAiOauth).toEqual(normalizeClaudeAiOauth(REFRESHED));
    expect(stored.mcpOAuth).toEqual(mcpOAuth);
    const ownership = JSON.parse(fake.items.get(ownershipService)!);
    expect(ownership.providerId).toBe('official-b');
    expect(ownership.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(ownership.credentialFingerprint).not.toBe('f'.repeat(64));

    expect(warnMock).toHaveBeenCalledTimes(1);
    const [context, message] = warnMock.mock.calls[0];
    expect(context).toMatchObject({
      folder: 'main',
      previousProviderId: 'revoked-account',
      providerId: 'official-b',
    });
    expect(message).toContain('cleared by Claude Code');
    const logged = JSON.stringify(warnMock.mock.calls);
    expect(logged).not.toContain(REFRESHED.accessToken);
    expect(logged).not.toContain(REFRESHED.refreshToken);
    expect(logged).not.toContain('mcp-token');

    // The next spawn sees a normal, owned credential and stays quiet.
    warnMock.mockClear();
    await expect(
      fake.store().reconcile(CONFIG_DIR, {
        providerId: 'official-b',
        claudeAiOauth: REFRESHED,
        folder: 'main',
      }),
    ).resolves.toEqual(normalizeClaudeAiOauth(REFRESHED));
    expect(warnMock).not.toHaveBeenCalled();
  });

  test('replaces a cleared item even when the same provider still owns it', async () => {
    const fake = new FakeKeychain();
    const service = claudeKeychainServiceName(CONFIG_DIR);
    fake.items.set(service, JSON.stringify({ claudeAiOauth: OAUTH }));
    const store = fake.store();
    await store.reconcile(CONFIG_DIR, {
      providerId: 'official-a',
      claudeAiOauth: OAUTH,
    });
    fake.items.set(
      service,
      JSON.stringify({ claudeAiOauth: CLEARED_BY_CLAUDE_CODE }),
    );

    await expect(
      store.reconcile(CONFIG_DIR, {
        providerId: 'official-a',
        claudeAiOauth: OAUTH,
      }),
    ).resolves.toEqual(normalizeClaudeAiOauth(OAUTH));
    expect(JSON.parse(fake.items.get(service)!).claudeAiOauth).toEqual(
      normalizeClaudeAiOauth(OAUTH),
    );
  });

  test.each([
    ['only the access token blanked', { ...OAUTH, accessToken: '' }],
    ['only the refresh token blanked', { ...OAUTH, refreshToken: '' }],
    [
      'tokens blanked but expiry kept',
      { ...CLEARED_BY_CLAUDE_CODE, expiresAt: OAUTH.expiresAt },
    ],
    [
      'a token left behind',
      { ...CLEARED_BY_CLAUDE_CODE, refreshToken: 'sk-ant-ort01-left' },
    ],
    ['null tokens', { ...CLEARED_BY_CLAUDE_CODE, accessToken: null }],
  ])('still fails closed for partially blanked OAuth: %s', async (_, oauth) => {
    const fake = new FakeKeychain();
    const service = claudeKeychainServiceName(CONFIG_DIR);
    const original = JSON.stringify({ claudeAiOauth: oauth, mcpOAuth: {} });
    fake.items.set(service, original);

    await expect(
      fake.store().reconcile(CONFIG_DIR, {
        providerId: 'official-a',
        claudeAiOauth: OAUTH,
      }),
    ).rejects.toThrow('incomplete or invalid');
    expect(fake.items.get(service)).toBe(original);
    expect(fake.items.has(claudeKeychainOwnershipServiceName(CONFIG_DIR))).toBe(
      false,
    );
  });

  test('still fails closed for corrupt payload or ownership JSON', async () => {
    const corruptPayload = new FakeKeychain();
    corruptPayload.items.set(
      claudeKeychainServiceName(CONFIG_DIR),
      '{"claudeAiOauth":',
    );
    await expect(
      corruptPayload.store().reconcile(CONFIG_DIR, {
        providerId: 'official-a',
        claudeAiOauth: OAUTH,
      }),
    ).rejects.toThrow('not valid JSON');

    const corruptOwnership = new FakeKeychain();
    const service = claudeKeychainServiceName(CONFIG_DIR);
    const original = JSON.stringify({
      claudeAiOauth: CLEARED_BY_CLAUDE_CODE,
    });
    corruptOwnership.items.set(service, original);
    corruptOwnership.items.set(
      claudeKeychainOwnershipServiceName(CONFIG_DIR),
      '{"version":1,',
    );
    await expect(
      corruptOwnership.store().reconcile(CONFIG_DIR, {
        providerId: 'official-a',
        claudeAiOauth: OAUTH,
      }),
    ).rejects.toThrow('ownership payload is not valid JSON');
    expect(corruptOwnership.items.get(service)).toBe(original);
  });

  test('valid credentials owned by another provider follow the unchanged switch path', async () => {
    warnMock.mockClear();
    const fake = new FakeKeychain();
    const service = claudeKeychainServiceName(CONFIG_DIR);
    fake.items.set(
      service,
      JSON.stringify({ claudeAiOauth: OAUTH, mcpOAuth: { keep: 1 } }),
    );
    await fake.store().reconcile(CONFIG_DIR, {
      providerId: 'official-a',
      claudeAiOauth: OAUTH,
    });
    const persist = vi.fn(() => true);

    await expect(
      fake.store().reconcile(CONFIG_DIR, {
        providerId: 'official-b',
        claudeAiOauth: REFRESHED,
        persistRefreshedCredentials: persist,
      }),
    ).resolves.toEqual(normalizeClaudeAiOauth(REFRESHED));
    expect(persist).not.toHaveBeenCalled();
    expect(JSON.parse(fake.items.get(service)!)).toEqual({
      claudeAiOauth: normalizeClaudeAiOauth(REFRESHED),
      mcpOAuth: { keep: 1 },
    });
    expect(warnMock).not.toHaveBeenCalled();
  });

  test('merge treats a cleared value as absent and keeps other fields', () => {
    const merged = mergeClaudeKeychainPayload(
      JSON.stringify({
        claudeAiOauth: CLEARED_BY_CLAUDE_CODE,
        mcpOAuth: { keep: true },
      }),
      OAUTH,
    );
    expect(JSON.parse(merged!)).toEqual({
      claudeAiOauth: normalizeClaudeAiOauth(OAUTH),
      mcpOAuth: { keep: true },
    });
  });
});
