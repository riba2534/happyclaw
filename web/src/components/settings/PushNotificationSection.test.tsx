// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchVapidPublicKey: vi.fn(),
  ensurePushRegistration: vi.fn(),
}));

vi.mock('../../utils/webPush', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/webPush')>()),
  getPushSupport: () => 'supported',
  fetchVapidPublicKey: mocks.fetchVapidPublicKey,
  ensurePushRegistration: mocks.ensurePushRegistration,
}));

import { PushNotificationSection } from './PushNotificationSection';
import { useAuthStore, type UserPublic } from '../../stores/auth';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function signIn(role: UserPublic['role']) {
  useAuthStore.setState({
    authenticated: true,
    user: { id: `${role}-1`, role, permissions: [] } as unknown as UserPublic,
  });
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<PushNotificationSection />);
  });
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  mocks.fetchVapidPublicKey.mockReset().mockResolvedValue(null);
  mocks.ensurePushRegistration.mockReset();
  vi.stubGlobal('Notification', { permission: 'default' });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe('PushNotificationSection', () => {
  test('a guest sees no push settings and nothing is requested', async () => {
    signIn('guest');
    await mount();
    expect(container!.textContent).toBe('');
    expect(mocks.fetchVapidPublicKey).not.toHaveBeenCalled();
  });

  test('a member gets the push settings of this device', async () => {
    signIn('member');
    await mount();
    expect(container!.textContent).toContain('推送通知');
    expect(mocks.fetchVapidPublicKey).toHaveBeenCalledTimes(1);
  });
});
