// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const toastMock = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: toastMock }));

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ apiFetch: apiFetchMock }));

const wsHandlers = vi.hoisted(() => new Map<string, () => void>());
vi.mock('../api/ws', () => ({
  wsManager: {
    on: (type: string, handler: () => void) => {
      wsHandlers.set(type, handler);
      return () => wsHandlers.delete(type);
    },
  },
}));

import { showUpdateToast, startAppUpdateCheck } from './appUpdatePrompt';
import { UPDATE_TOAST_ID } from './versionCheck';

const LOCAL = { id: 'v-local', builtAt: 1_000 };

describe('showUpdateToast', () => {
  beforeEach(() => toastMock.mockClear());

  test('shows a persistent notice with a refresh action and a close button', () => {
    const onDismiss = vi.fn();
    const reload = vi.fn();
    showUpdateToast(onDismiss, reload);
    const [title, options] = toastMock.mock.calls[0];
    expect(title).toBe('HappyClaw 已更新，点击刷新');
    expect(options).toMatchObject({
      id: UPDATE_TOAST_ID,
      duration: Infinity,
      closeButton: true,
      onDismiss,
    });
    expect(options.action.label).toBe('刷新');
    options.action.onClick();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('startAppUpdateCheck', () => {
  beforeEach(() => {
    toastMock.mockReset();
    apiFetchMock.mockReset();
    wsHandlers.clear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test('is off in dev mode', () => {
    vi.stubEnv('DEV', true);
    vi.stubGlobal('__APP_BUILD__', LOCAL);
    expect(startAppUpdateCheck()).toBeNull();
    expect(wsHandlers.size).toBe(0);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  test('is off without a compiled-in build id', () => {
    vi.stubEnv('DEV', false);
    vi.stubGlobal('__APP_BUILD__', undefined);
    expect(startAppUpdateCheck()).toBeNull();
  });

  test('a WebSocket (re)connect against a newer server shows the notice', async () => {
    vi.stubEnv('DEV', false);
    vi.stubGlobal('__APP_BUILD__', LOCAL);
    apiFetchMock.mockResolvedValue({ id: 'v-new', builtAt: 2_000 });
    const stop = startAppUpdateCheck();
    expect(stop).toBeTypeOf('function');
    wsHandlers.get('connected')?.();
    await vi.waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    expect(apiFetchMock).toHaveBeenCalledWith('/api/build', {
      cache: 'no-store',
    });
    stop?.();
  });

  test('an identical server build shows nothing', async () => {
    vi.stubEnv('DEV', false);
    vi.stubGlobal('__APP_BUILD__', LOCAL);
    apiFetchMock.mockResolvedValue({ ...LOCAL });
    const stop = startAppUpdateCheck();
    wsHandlers.get('connected')?.();
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(toastMock).not.toHaveBeenCalled();
    stop?.();
  });
});
