// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  clearMessageSnapshotCache: vi.fn().mockResolvedValue(undefined),
  resetUsage: vi.fn(),
}));

vi.mock('../api/client', () => ({
  api: {
    get: mocks.apiGet,
    post: mocks.apiPost,
    put: vi.fn(),
  },
  apiFetch: vi.fn(),
}));

vi.mock('../utils/messageSnapshotCache', () => ({
  clearMessageSnapshotCache: mocks.clearMessageSnapshotCache,
}));

const { useAuthStore } = await import('./auth');
const { registerUserScopedReset } = await import('./user-scope');
registerUserScopedReset(mocks.resetUsage);

const registeredUser = {
  id: 'user-1',
  username: 'member',
  display_name: 'Member',
  role: 'member' as const,
  status: 'active' as const,
  permissions: [],
  must_change_password: false,
  disable_reason: null,
  notes: null,
  created_at: '2026-08-15T00:00:00.000Z',
  last_login_at: null,
  last_active_at: null,
  deleted_at: null,
  avatar_emoji: null,
  avatar_color: null,
  avatar_url: null,
  ai_name: null,
  ai_avatar_emoji: null,
  ai_avatar_color: null,
  ai_avatar_url: null,
  default_require_mention: false,
};

const appearance = {
  appName: 'Team Claw',
  aiName: 'HappyClaw',
  aiAvatarEmoji: '🐱',
  aiAvatarColor: '#0d9488',
  aiAvatarUrl: null,
  aiAvatarMode: 'brand' as const,
  brandIconUrl: '/api/config/brand-assets/brand-icon-12345678.png',
  brandBannerUrl: null,
};

beforeEach(() => {
  mocks.apiGet.mockReset().mockResolvedValue(appearance);
  mocks.apiPost.mockReset().mockResolvedValue({
    success: true,
    user: registeredUser,
  });
  mocks.clearMessageSnapshotCache.mockClear();
  mocks.resetUsage.mockClear();
  useAuthStore.setState({
    authenticated: false,
    user: null,
    setupStatus: null,
    appearance: null,
    initialized: true,
    checking: false,
  });
});

describe('auth store public appearance hydration', () => {
  test('hydrates appearance before registration completes', async () => {
    await useAuthStore.getState().register({
      username: 'member',
      password: 'password-123',
    });

    expect(mocks.apiPost).toHaveBeenCalledWith('/api/auth/register', {
      username: 'member',
      password: 'password-123',
    });
    expect(mocks.apiGet).toHaveBeenCalledWith('/api/config/appearance/public');
    expect(useAuthStore.getState()).toMatchObject({
      authenticated: true,
      user: registeredUser,
      appearance,
    });
  });
});

describe('auth store sign-in from a public page', () => {
  test('login leaves no pending check and drops stale page prewarms', async () => {
    // A cold load of /login: checkAuth never ran, so `checking` is still
    // the initial true, and index.html prefetched a 401 for /api/auth/me.
    useAuthStore.setState({ authenticated: false, checking: true });
    const holder = window as {
      __authPrewarm?: unknown;
      __groupsPrewarm?: unknown;
    };
    holder.__authPrewarm = Promise.resolve(new Response(null, { status: 401 }));
    holder.__groupsPrewarm = Promise.resolve(null);

    await useAuthStore.getState().login('member', 'password-123');

    expect(useAuthStore.getState()).toMatchObject({
      authenticated: true,
      checking: false,
    });
    expect(holder.__authPrewarm).toBeUndefined();
    expect(holder.__groupsPrewarm).toBeUndefined();
    // User-scoped stores that were loaded are reset synchronously; auth
    // never has to download them first.
    expect(mocks.resetUsage).toHaveBeenCalledTimes(1);
  });
});
