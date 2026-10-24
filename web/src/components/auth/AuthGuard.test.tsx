// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: {
    authenticated: true,
    checking: false,
    initialized: true,
    checkAuth: vi.fn(),
    hasPermission: vi.fn(() => true),
    setupStatus: { needsSetup: true },
    user: { role: 'admin', must_change_password: false },
  },
  post: vi.fn(),
}));
vi.mock('../../stores/auth', () => ({
  useAuthStore: Object.assign(
    (selector?: (state: typeof mocks.state) => unknown) =>
      selector ? selector(mocks.state) : mocks.state,
    { getState: () => mocks.state },
  ),
}));
vi.mock('../../api/client', () => ({ api: { post: mocks.post } }));

const { AuthGuard } = await import('./AuthGuard');
const { SetupProvidersPage } = await import('../../pages/SetupProvidersPage');
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.state, {
    authenticated: true,
    checking: false,
    initialized: true,
  });
  mocks.state.user = { role: 'admin', must_change_password: false };
  mocks.state.hasPermission.mockReturnValue(true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderAt(route: string) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/chat" element={<AuthGuard>chat page</AuthGuard>} />
          <Route
            path="/settings"
            element={<AuthGuard>settings page</AuthGuard>}
          />
          <Route
            path="/setup/providers"
            element={
              <AuthGuard>
                <SetupProvidersPage />
              </AuthGuard>
            }
          />
          <Route path="/setup" element={<div>initial setup page</div>} />
          <Route path="/login" element={<div>login page</div>} />
          <Route
            path="/private"
            element={
              <AuthGuard requiredPermission="manage_users">
                private page
              </AuthGuard>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  });
}

describe('optional provider onboarding', () => {
  test.each(['/chat', '/settings'])(
    'allows an authenticated admin to open %s before configuring a model',
    async (route) => {
      await renderAt(route);
      expect(container.textContent).toBe(
        route === '/chat' ? 'chat page' : 'settings page',
      );
      expect(mocks.state.checkAuth).not.toHaveBeenCalled();
    },
  );

  test('skips provider setup without saving empty credentials or returning to onboarding', async () => {
    await renderAt('/setup/providers');
    const skip = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '暂不配置，进入后台',
    );
    expect(skip).toBeDefined();
    await act(async () => skip?.click());
    expect(container.textContent).toBe('chat page');
    expect(mocks.post).not.toHaveBeenCalled();
  });

  test('still requires authentication', async () => {
    mocks.state.authenticated = false;
    await renderAt('/chat');
    expect(container.textContent).toBe('login page');
  });

  test('still requires initial administrator setup', async () => {
    mocks.state.initialized = false;
    await renderAt('/chat');
    expect(container.textContent).toBe('initial setup page');
  });

  test('still enforces a mandatory password change without a setup redirect loop', async () => {
    mocks.state.user.must_change_password = true;
    await renderAt('/chat');
    expect(container.textContent).toBe('settings page');
  });

  test('still restricts provider setup to administrators', async () => {
    mocks.state.user.role = 'member';
    await renderAt('/setup/providers');
    expect(container.textContent).toBe('chat page');
  });

  test('keeps read-only guests out of onboarding', async () => {
    mocks.state.user.role = 'guest';
    await renderAt('/setup/providers');
    expect(container.textContent).toBe('chat page');
  });

  test('lets read-only guests open their own settings', async () => {
    mocks.state.user.role = 'guest';
    await renderAt('/settings');
    expect(container.textContent).toBe('settings page');
  });

  test('still checks permissions', async () => {
    mocks.state.hasPermission.mockReturnValue(false);
    await renderAt('/private');
    expect(container.textContent).toBe('chat page');
  });
});
