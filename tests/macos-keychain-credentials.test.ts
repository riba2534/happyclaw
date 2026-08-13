import { describe, expect, test, vi } from 'vitest';

import {
  claudeKeychainOwnershipServiceName,
  claudeKeychainServiceName,
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
