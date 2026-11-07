// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const authState = {
    login: vi.fn(),
    register: vi.fn(),
    initialized: true as boolean | null,
    checkStatus: vi.fn(),
    appearance: {
      appName: 'Team Claw',
      aiName: 'HappyClaw',
      aiAvatarEmoji: '🐱',
      aiAvatarColor: '#0d9488',
      aiAvatarUrl: null,
      aiAvatarMode: 'brand' as const,
      brandIconUrl: '/api/config/brand-assets/brand-icon-12345678.png',
      brandBannerUrl: null,
    },
    fetchAppearance: vi.fn().mockResolvedValue(undefined),
    user: null as { role: string; must_change_password: boolean } | null,
    setupStatus: null as { needsSetup: boolean } | null,
    deploymentMode: undefined as string | undefined,
  };
  return {
    authState,
    search: '',
    navigate: vi.fn(),
    getRegisterStatus: vi.fn().mockResolvedValue({
      allowRegistration: true,
      requireInviteCode: false,
    }),
  };
});

vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom',
    );
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
    useSearchParams: () => [new URLSearchParams(mocks.search), vi.fn()],
  };
});

vi.mock('../stores/auth', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof mocks.authState) => unknown) =>
      selector(mocks.authState),
    { getState: () => mocks.authState },
  ),
}));

vi.mock('../api/client', () => ({
  api: { get: mocks.getRegisterStatus },
}));

const { LoginPage } = await import('./LoginPage');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  mocks.navigate.mockClear();
  mocks.authState.login.mockReset();
  mocks.authState.user = null;
  mocks.authState.setupStatus = null;
  mocks.authState.deploymentMode = undefined;
  mocks.search = '';
  mocks.authState.fetchAppearance.mockClear();
  mocks.getRegisterStatus.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe('LoginPage public appearance', () => {
  test('hydrates public appearance and renders the configured name and icon', async () => {
    await act(async () => {
      root?.render(<LoginPage />);
    });

    expect(mocks.authState.fetchAppearance).toHaveBeenCalledTimes(1);
    expect(document.title).toBe('Team Claw');
    expect(container?.textContent).toContain('Team Claw');
    expect(container?.textContent).toContain('登录以继续使用 Team Claw');

    const brandImages = [
      ...(container?.querySelectorAll<HTMLImageElement>('img') ?? []),
    ].filter((image) => image.alt === 'Team Claw');
    expect(brandImages).toHaveLength(2);
    for (const image of brandImages) {
      expect(image.getAttribute('src')).toBe(
        '/api/config/brand-assets/brand-icon-12345678.png',
      );
    }
  });
});

describe('login before provider configuration', () => {
  test.each([false, true])(
    'honors mandatory password changes (%s) without forcing provider setup',
    async (mustChange) => {
      mocks.authState.login.mockImplementation(async () => {
        mocks.authState.user = {
          role: 'admin',
          must_change_password: mustChange,
        };
        mocks.authState.setupStatus = { needsSetup: true };
      });
      await act(async () => root?.render(<LoginPage />));
      await act(async () => {
        container
          ?.querySelector('form')
          ?.dispatchEvent(
            new Event('submit', { bubbles: true, cancelable: true }),
          );
      });
      expect(mocks.authState.login).toHaveBeenCalledTimes(1);
      expect(mocks.navigate).toHaveBeenCalledWith(
        mustChange ? '/settings' : '/chat',
      );
    },
  );
});

describe('registration and the deployment mode', () => {
  const registerLink = () =>
    [...(container?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === '去注册',
    );

  test('multi_user (or an older server) offers registration', async () => {
    await act(async () => {
      root?.render(<LoginPage />);
    });
    expect(registerLink()).toBeDefined();
  });

  test('single-user host mode hides the register link and form', async () => {
    mocks.authState.deploymentMode = 'single_user_host';
    mocks.search = 'tab=register';
    await act(async () => {
      root?.render(<LoginPage />);
    });
    expect(registerLink()).toBeUndefined();
    expect(container?.querySelector('#reg-username')).toBeNull();
    expect(container?.textContent).toContain('欢迎回来');
  });
});
