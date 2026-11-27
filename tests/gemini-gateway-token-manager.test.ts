import { beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  GeminiOAuthCredentials,
  GeminiOAuthRefreshErrorState,
} from '../src/gemini-gateway/types.js';

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  persist: vi.fn(),
  persistError: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('../src/runtime-config.js', () => ({
  getProviders: mocks.getProviders,
  updateProviderGeminiOAuthCredentialsIfCurrent: mocks.persist,
  setProviderGeminiOAuthRefreshErrorIfCurrent: mocks.persistError,
}));
vi.mock('../src/gemini-gateway/oauth.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  refreshGeminiToken: mocks.refresh,
}));
vi.mock('../src/logger.js', () => ({ logger: { warn: vi.fn() } }));

import { GeminiOAuthError } from '../src/gemini-gateway/oauth.js';
import {
  GeminiGatewayAuthError,
  GeminiReauthRequiredError,
  GeminiRefreshUnavailableError,
  countGeminiRefreshBackoffs,
  findGeminiProviderByGatewayIdentifier,
  resetGeminiTokenStateForTest,
  resolveGeminiAccess,
  resolveGeminiProvider,
} from '../src/gemini-gateway/token-manager.js';

function credentials(
  token = 'upstream-token',
  { expired = false, refresh = 'refresh-token' } = {},
): GeminiOAuthCredentials {
  return {
    accessToken: token,
    refreshToken: refresh,
    expiresAt: Date.now() + (expired ? -1 : 3_600_000),
    email: 'user@example.invalid',
    accountId: 'google-id',
    projectId: 'project-1',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
function tokenResponse(token: string) {
  return {
    accessToken: token,
    refreshToken: null,
    idToken: null,
    scope: null,
    expiresAt: Date.now() + 3_600_000,
  };
}
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const rejected = (code = 'invalid_grant', status = 400) =>
  new GeminiOAuthError(
    `Gemini OAuth token endpoint rejected: ${code}`,
    status,
    code,
    false,
  );
const unreachable = () =>
  new GeminiOAuthError(
    'Gemini OAuth token endpoint unreachable',
    null,
    null,
    true,
  );

let provider: {
  id: string;
  anthropicAuthToken: string;
  anthropicModel: string;
  geminiOAuthCredentials: GeminiOAuthCredentials | null;
  geminiOAuthLastRefreshError?: GeminiOAuthRefreshErrorState | null;
};
beforeEach(() => {
  vi.clearAllMocks();
  resetGeminiTokenStateForTest();
  provider = {
    id: 'provider',
    anthropicAuthToken: 'gateway-identifier',
    anthropicModel: 'gemini-4-argon-medium',
    geminiOAuthCredentials: credentials(),
    geminiOAuthLastRefreshError: null,
  };
  mocks.getProviders.mockImplementation(() => [structuredClone(provider)]);
  mocks.persist.mockImplementation((_id, expected, refreshed) => {
    if (provider.geminiOAuthCredentials?.accessToken !== expected.accessToken) {
      return false;
    }
    provider.geminiOAuthCredentials = refreshed;
    provider.geminiOAuthLastRefreshError = null;
    return true;
  });
  mocks.persistError.mockImplementation((_id, expected, state) => {
    if (provider.geminiOAuthCredentials?.accessToken !== expected.accessToken) {
      return false;
    }
    provider.geminiOAuthLastRefreshError = state;
    return true;
  });
});

describe('provider lookup', () => {
  test('maps the runner credential back to its provider', () => {
    expect(
      findGeminiProviderByGatewayIdentifier('gateway-identifier')?.id,
    ).toBe('provider');
    expect(findGeminiProviderByGatewayIdentifier('other')).toBeNull();
    expect(findGeminiProviderByGatewayIdentifier('')).toBeNull();
  });

  test('a provider without Google credentials is not a Gemini endpoint', () => {
    provider.geminiOAuthCredentials = null;
    expect(
      findGeminiProviderByGatewayIdentifier('gateway-identifier'),
    ).toBeNull();
  });

  test('the stored identifier is not a usable access path by itself', async () => {
    await expect(resolveGeminiAccess('gateway-identifier')).rejects.toThrow(
      GeminiGatewayAuthError,
    );
  });

  test('resolveGeminiProvider names the missing precondition', () => {
    expect(() => resolveGeminiProvider('missing')).toThrow('连接不存在');
    provider.geminiOAuthCredentials = null;
    expect(() => resolveGeminiProvider('provider')).toThrow('没有登录凭据');
  });
});

describe('resolveGeminiAccess', () => {
  test('returns a valid token without refreshing', async () => {
    await expect(resolveGeminiAccess('provider')).resolves.toMatchObject({
      accessToken: 'upstream-token',
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  test('refreshes a token inside the five-minute margin', async () => {
    provider.geminiOAuthCredentials = credentials('near-expiry');
    provider.geminiOAuthCredentials.expiresAt = Date.now() + 60_000;
    mocks.refresh.mockResolvedValue(tokenResponse('rotated'));
    await expect(resolveGeminiAccess('provider')).resolves.toMatchObject({
      accessToken: 'rotated',
    });
    expect(mocks.refresh).toHaveBeenCalledWith('refresh-token');
  });

  test('keeps the existing refresh token when Google does not rotate it', async () => {
    provider.geminiOAuthCredentials = credentials('old', { expired: true });
    mocks.refresh.mockResolvedValue(tokenResponse('new'));
    await resolveGeminiAccess('provider');
    expect(provider.geminiOAuthCredentials).toMatchObject({
      accessToken: 'new',
      refreshToken: 'refresh-token',
    });
  });

  test('concurrent callers share one rotating-token refresh', async () => {
    provider.geminiOAuthCredentials = credentials('old', { expired: true });
    const exchange = gate<ReturnType<typeof tokenResponse>>();
    mocks.refresh.mockReturnValue(exchange.promise);
    const requests = Array.from({ length: 8 }, () =>
      resolveGeminiAccess('provider'),
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    exchange.resolve(tokenResponse('new'));
    for (const value of await Promise.all(requests)) {
      expect(value.accessToken).toBe('new');
    }
    expect(mocks.persist).toHaveBeenCalledTimes(1);
  });

  test('a CAS loser serves the token the administrator wrote', async () => {
    provider.geminiOAuthCredentials = credentials('old', { expired: true });
    const exchange = gate<ReturnType<typeof tokenResponse>>();
    mocks.refresh.mockReturnValue(exchange.promise);
    const request = resolveGeminiAccess('provider');
    provider.geminiOAuthCredentials = credentials('admin-token');
    exchange.resolve(tokenResponse('discarded'));
    await expect(request).resolves.toMatchObject({
      accessToken: 'admin-token',
    });
  });

  test('forced refresh rotates an unexpired token after an upstream 401', async () => {
    mocks.refresh.mockResolvedValue(tokenResponse('rotated'));
    await expect(
      resolveGeminiAccess('provider', { forceRefresh: true }),
    ).resolves.toMatchObject({ accessToken: 'rotated' });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  test('a provider removed during refresh fails instead of serving a stale token', async () => {
    provider.geminiOAuthCredentials = credentials('old', { expired: true });
    const exchange = gate<ReturnType<typeof tokenResponse>>();
    mocks.refresh.mockReturnValue(exchange.promise);
    const request = resolveGeminiAccess('provider');
    mocks.getProviders.mockImplementation(() => []);
    exchange.resolve(tokenResponse('new'));
    await expect(request).rejects.toThrow(GeminiGatewayAuthError);
  });
});

describe('refresh failures', () => {
  test('a rejected grant persists reauth_required and stops refreshing', async () => {
    provider.geminiOAuthCredentials = credentials('old', { expired: true });
    mocks.refresh.mockRejectedValue(rejected());
    await expect(resolveGeminiAccess('provider')).rejects.toThrow(
      GeminiReauthRequiredError,
    );
    expect(provider.geminiOAuthLastRefreshError).toMatchObject({
      kind: 'reauth_required',
    });
    const second = resolveGeminiAccess('provider');
    await expect(second).rejects.toThrow('重新登录 Google');
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  test('a forced refresh still tries after a persisted reauth requirement', async () => {
    provider.geminiOAuthLastRefreshError = {
      kind: 'reauth_required',
      message: 'invalid_grant',
      at: '2026-01-01T00:00:00.000Z',
    };
    mocks.refresh.mockResolvedValue(tokenResponse('recovered'));
    await expect(
      resolveGeminiAccess('provider', { forceRefresh: true }),
    ).resolves.toMatchObject({ accessToken: 'recovered' });
  });

  test('missing refresh tokens require a new login only once expired', async () => {
    provider.geminiOAuthCredentials = credentials('old', {
      expired: true,
      refresh: '',
    });
    await expect(resolveGeminiAccess('provider')).rejects.toThrow(
      GeminiReauthRequiredError,
    );
    expect(mocks.refresh).not.toHaveBeenCalled();

    provider.geminiOAuthCredentials = credentials('valid', { refresh: '' });
    await expect(resolveGeminiAccess('provider')).resolves.toMatchObject({
      accessToken: 'valid',
    });
  });

  test('transient failures back off and keep an unexpired token serving', async () => {
    vi.useFakeTimers({ now: Date.now() });
    try {
      provider.geminiOAuthCredentials = credentials('near-expiry');
      provider.geminiOAuthCredentials.expiresAt = Date.now() + 60_000;
      mocks.refresh.mockRejectedValue(unreachable());
      await expect(resolveGeminiAccess('provider')).rejects.toThrow(
        GeminiRefreshUnavailableError,
      );
      expect(provider.geminiOAuthLastRefreshError).toMatchObject({
        kind: 'transient',
      });
      expect(countGeminiRefreshBackoffs()).toBe(1);
      // Inside the backoff window the still-valid token keeps serving and the
      // endpoint is not called again.
      await expect(resolveGeminiAccess('provider')).resolves.toMatchObject({
        accessToken: 'near-expiry',
      });
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('an expired token inside the backoff window fails with a retry hint', async () => {
    vi.useFakeTimers({ now: Date.now() });
    try {
      provider.geminiOAuthCredentials = credentials('old', { expired: true });
      mocks.refresh.mockRejectedValueOnce(unreachable());
      const first = resolveGeminiAccess('provider');
      await expect(first).rejects.toThrow(GeminiRefreshUnavailableError);
      await first.catch((err: GeminiRefreshUnavailableError) => {
        expect(err.retryAfterMs).toBeGreaterThan(20_000);
        expect(err.retryAfterMs).toBeLessThanOrEqual(30_000);
      });
      await expect(resolveGeminiAccess('provider')).rejects.toThrow(
        GeminiRefreshUnavailableError,
      );
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(31_000);
      mocks.refresh.mockResolvedValueOnce(tokenResponse('recovered'));
      await expect(resolveGeminiAccess('provider')).resolves.toMatchObject({
        accessToken: 'recovered',
      });
      expect(provider.geminiOAuthLastRefreshError).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('the backoff doubles per failed exchange up to five minutes', async () => {
    provider.geminiOAuthCredentials = credentials('old', { expired: true });
    const seen: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      mocks.refresh.mockRejectedValueOnce(unreachable());
      // A forced refresh skips the wait but still counts as a failed exchange.
      await resolveGeminiAccess('provider', { forceRefresh: true }).catch(
        (err: GeminiRefreshUnavailableError) => {
          seen.push(Math.ceil(err.retryAfterMs / 1000));
        },
      );
    }
    expect(seen).toEqual([30, 60, 120, 240, 300]);
  });

  test('new credentials reset the backoff', async () => {
    vi.useFakeTimers({ now: Date.now() });
    try {
      provider.geminiOAuthCredentials = credentials('old', { expired: true });
      mocks.refresh.mockRejectedValueOnce(unreachable());
      await expect(resolveGeminiAccess('provider')).rejects.toThrow(
        GeminiRefreshUnavailableError,
      );
      expect(countGeminiRefreshBackoffs()).toBe(1);
      provider.geminiOAuthCredentials = credentials('relogin');
      // New credentials are used immediately; the stale backoff never gates them.
      await expect(resolveGeminiAccess('provider')).resolves.toMatchObject({
        accessToken: 'relogin',
      });
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
