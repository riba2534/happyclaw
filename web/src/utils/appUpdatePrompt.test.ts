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
import { BUILD_META_NAME, UPDATE_TOAST_ID } from './versionCheck';

const LOCAL = { id: 'v-local', builtAt: 1_000 };

/** What the build-info plugin in web/vite.config.ts puts into index.html. */
function serveBuild(build: { id: string; builtAt: number }) {
  const meta = document.createElement('meta');
  meta.name = BUILD_META_NAME;
  meta.content = JSON.stringify(build);
  document.head.append(meta);
}

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
    document.head
      .querySelectorAll(`meta[name="${BUILD_META_NAME}"]`)
      .forEach((meta) => meta.remove());
  });

  test('is off in dev mode', () => {
    vi.stubEnv('DEV', true);
    serveBuild(LOCAL);
    expect(startAppUpdateCheck()).toBeNull();
    expect(wsHandlers.size).toBe(0);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  test('is off when the page carries no build id', () => {
    vi.stubEnv('DEV', false);
    expect(startAppUpdateCheck()).toBeNull();
  });

  test('a WebSocket (re)connect against a newer server shows the notice', async () => {
    vi.stubEnv('DEV', false);
    serveBuild(LOCAL);
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

  test('the same frontend rebuilt by a later deploy shows nothing', async () => {
    vi.stubEnv('DEV', false);
    serveBuild(LOCAL);
    apiFetchMock.mockResolvedValue({ id: LOCAL.id, builtAt: 9_000 });
    const stop = startAppUpdateCheck();
    wsHandlers.get('connected')?.();
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(toastMock).not.toHaveBeenCalled();
    stop?.();
  });

  test('an identical server build shows nothing', async () => {
    vi.stubEnv('DEV', false);
    serveBuild(LOCAL);
    apiFetchMock.mockResolvedValue({ ...LOCAL });
    const stop = startAppUpdateCheck();
    wsHandlers.get('connected')?.();
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(toastMock).not.toHaveBeenCalled();
    stop?.();
  });
});
