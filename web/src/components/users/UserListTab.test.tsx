// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { UserPublic } from '../../stores/auth';

const mocks = vi.hoisted(() => ({
  store: {
    users: [] as unknown[],
    totalUsers: 0,
    page: 1,
    pageSize: 20,
    loading: false,
    permissions: [] as string[],
    templates: [] as unknown[],
    fetchPermissionMeta: vi.fn(async () => undefined),
    fetchUsers: vi.fn(async () => undefined),
    updateUser: vi.fn(),
    deleteUser: vi.fn(),
    restoreUser: vi.fn(),
    revokeUserSessions: vi.fn(),
    resetUserTwoFactor: vi.fn(),
    revokeUserPasskeys: vi.fn(async () => undefined),
  },
  confirmDialog: vi.fn(async () => true),
}));
vi.mock('../../stores/users', () => ({
  useUsersStore: () => mocks.store,
}));
vi.mock('@/stores/confirm', () => ({ confirmDialog: mocks.confirmDialog }));

const { UserListTab } = await import('./UserListTab');
const { emulatePointer } = await import('../ui/overlay-test-utils');
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const admin = {
  id: 'owner',
  username: 'owner',
  display_name: 'Owner',
  role: 'admin',
  status: 'active',
  permissions: [],
  must_change_password: false,
} as unknown as UserPublic;

const bob = {
  ...admin,
  id: 'bob',
  username: 'bob',
  display_name: 'Bob',
  role: 'member',
  two_factor_enabled: true,
  passkey_count: 2,
} as UserPublic;

let root: Root;
let container: HTMLDivElement;
const setNotice = vi.fn();
const setError = vi.fn();

beforeEach(async () => {
  emulatePointer('desktop');
  mocks.store.users = [bob];
  mocks.store.totalUsers = 1;
  mocks.store.revokeUserPasskeys.mockClear();
  mocks.confirmDialog.mockClear();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () =>
    root.render(
      <UserListTab
        currentUser={admin}
        setNotice={setNotice}
        setError={setError}
      />,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('UserListTab login factors', () => {
  test('shows two-factor and passkeys, and revokes the passkeys', async () => {
    expect(container.textContent).toContain('二次验证');
    expect(container.textContent).toContain('通行密钥 2');

    const trigger = container.querySelector<HTMLElement>(
      'button[aria-label="Bob 的操作"]',
    )!;
    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerType: 'mouse',
          button: 0,
        }),
      );
    });
    const item = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((element) => element.textContent === '撤销通行密钥')!;
    expect(item).toBeDefined();
    await act(async () => item.click());
    expect(mocks.confirmDialog).toHaveBeenCalled();
    expect(mocks.store.revokeUserPasskeys).toHaveBeenCalledWith('bob');
    expect(setNotice).toHaveBeenCalledWith('已撤销 bob 的通行密钥');
  });
});
