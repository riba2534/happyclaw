import { beforeEach, describe, expect, test, vi } from 'vitest';

const { getProviders } = vi.hoisted(() => ({ getProviders: vi.fn() }));
vi.mock('../src/runtime-config.js', () => ({ getProviders }));

import {
  CodexGatewayAuthError,
  resolveCodexAccess,
} from '../src/codex-gateway/token-manager.js';

const credentials = {
  accessToken: 'upstream-token',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 3_600_000,
  accountId: 'account-id',
};

beforeEach(() => {
  getProviders.mockReset();
});

describe('resolveCodexAccess', () => {
  test('rejects a disabled provider even when its gateway token and OAuth credentials match', async () => {
    getProviders.mockReturnValue([
      {
        id: 'disabled-provider',
        enabled: false,
        anthropicAuthToken: 'gateway-token',
        codexOAuthCredentials: credentials,
      },
    ]);

    await expect(resolveCodexAccess('gateway-token')).rejects.toThrow(
      CodexGatewayAuthError,
    );
    await expect(resolveCodexAccess('gateway-token')).rejects.toThrow(
      'Unknown or disabled Codex gateway token',
    );
  });

  test('resolves an enabled provider with valid credentials', async () => {
    getProviders.mockReturnValue([
      {
        id: 'enabled-provider',
        enabled: true,
        anthropicAuthToken: 'gateway-token',
        codexOAuthCredentials: credentials,
      },
    ]);

    await expect(resolveCodexAccess('gateway-token')).resolves.toEqual({
      providerId: 'enabled-provider',
      accessToken: 'upstream-token',
      accountId: 'account-id',
    });
  });
});
