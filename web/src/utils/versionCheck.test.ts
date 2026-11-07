// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  VERSION_CHECK_INTERVAL_MS,
  VERSION_CHECK_MIN_GAP_MS,
  createVersionChecker,
  installVersionCheck,
  BUILD_META_NAME,
  isServerNewer,
  parseBuildInfo,
  readLocalBuild,
  type BuildInfo,
} from './versionCheck';

const local: BuildInfo = { id: 'v-local', builtAt: 1_000 };
const newer: BuildInfo = { id: 'v-new', builtAt: 2_000 };
const newest: BuildInfo = { id: 'v-newest', builtAt: 3_000 };

describe('parseBuildInfo', () => {
  test('accepts a well-formed build', () => {
    expect(parseBuildInfo({ id: 'a', builtAt: 5 })).toEqual({
      id: 'a',
      builtAt: 5,
    });
  });

  test.each([
    null,
    undefined,
    'x',
    {},
    { id: null, builtAt: null }, // 后端 dist 缺失时的响应
    { id: 'a', builtAt: 0 },
    { id: 'a', builtAt: '5' },
    { id: '', builtAt: 5 },
    { id: 'x'.repeat(201), builtAt: 5 },
  ])('rejects %j', (raw) => {
    expect(parseBuildInfo(raw)).toBeNull();
  });

  test('applies the server-side id length limit', () => {
    expect(parseBuildInfo({ id: 'x'.repeat(200), builtAt: 5 })).toEqual({
      id: 'x'.repeat(200),
      builtAt: 5,
    });
  });
});

describe('readLocalBuild', () => {
  afterEach(() => {
    document.head
      .querySelectorAll(`meta[name="${BUILD_META_NAME}"]`)
      .forEach((meta) => meta.remove());
  });

  const addMeta = (content: string) => {
    const meta = document.createElement('meta');
    meta.name = BUILD_META_NAME;
    meta.content = content;
    document.head.append(meta);
  };

  test('reads the build the page was served with', () => {
    addMeta(JSON.stringify(local));
    expect(readLocalBuild(document)).toEqual(local);
  });

  test.each([
    '',
    'not json',
    JSON.stringify({ id: 'a' }),
    JSON.stringify({ id: 'x'.repeat(201), builtAt: 5 }),
  ])('malformed meta %j means no local build', (content) => {
    addMeta(content);
    expect(readLocalBuild(document)).toBeNull();
  });

  test('no meta (dev server, unbuilt page) means no local build', () => {
    expect(readLocalBuild(document)).toBeNull();
  });
});

describe('isServerNewer', () => {
  test('only a different, later server build counts', () => {
    expect(isServerNewer(newer, local)).toBe(true);
    expect(isServerNewer(local, local)).toBe(false);
    expect(isServerNewer({ id: 'x', builtAt: 1_000 }, local)).toBe(false);
  });

  test('a rebuild of the same frontend is not an update', () => {
    // Every deploy rebuilds, so a backend-only deploy serves the same id with
    // a later builtAt.
    expect(isServerNewer({ id: local.id, builtAt: 2_000 }, local)).toBe(false);
  });

  test('an older build of a different frontend is not an update', () => {
    expect(isServerNewer({ id: 'old', builtAt: 500 }, local)).toBe(false);
  });
});

describe('createVersionChecker', () => {
  let clock: number;
  const now = () => clock;
  beforeEach(() => {
    clock = 1_000_000;
  });

  function setup(
    server: () => Promise<BuildInfo | null>,
    localBuild: BuildInfo | null = local,
  ) {
    const fetchServer = vi.fn(server);
    const prompt = vi.fn<(s: BuildInfo, dismiss: () => void) => void>();
    const checker = createVersionChecker({
      local: localBuild,
      fetchServer,
      prompt,
      now,
    });
    const advance = (ms: number) => {
      clock += ms;
    };
    return { checker, fetchServer, prompt, advance };
  }

  test('same build: no prompt', async () => {
    const { checker, prompt } = setup(async () => ({ ...local }));
    await checker.check();
    expect(prompt).not.toHaveBeenCalled();
  });

  test('same frontend rebuilt later: no prompt', async () => {
    const { checker, prompt } = setup(async () => ({
      id: local.id,
      builtAt: local.builtAt + 60_000,
    }));
    await checker.check();
    expect(prompt).not.toHaveBeenCalled();
  });

  test('older server build: no prompt', async () => {
    const { checker, prompt } = setup(async () => ({
      id: 'old',
      builtAt: 10,
    }));
    await checker.check();
    expect(prompt).not.toHaveBeenCalled();
  });

  test('newer server build: prompts once per server id', async () => {
    const { checker, prompt, advance } = setup(async () => newer);
    await checker.check();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0][0]).toEqual(newer);
    advance(VERSION_CHECK_MIN_GAP_MS);
    await checker.check();
    advance(VERSION_CHECK_MIN_GAP_MS);
    await checker.check();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  test('a still-newer deploy while the notice is open prompts again', async () => {
    let server = newer;
    const { checker, prompt, advance } = setup(async () => server);
    await checker.check();
    server = newest;
    advance(VERSION_CHECK_MIN_GAP_MS);
    await checker.check();
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[1][0].id).toBe('v-newest');
  });

  test('after the user dismisses, nothing more is shown or fetched', async () => {
    let server = newer;
    const { checker, prompt, fetchServer, advance } = setup(async () => server);
    await checker.check();
    prompt.mock.calls[0][1](); // dismiss
    server = newest;
    advance(VERSION_CHECK_MIN_GAP_MS);
    await checker.check();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(fetchServer).toHaveBeenCalledTimes(1);
  });

  test('no local build id (dev): never fetches or prompts', async () => {
    const { checker, prompt, fetchServer } = setup(async () => newer, null);
    await checker.check();
    expect(fetchServer).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  test('unknown server build (dist missing, endpoint absent): no prompt', async () => {
    const { checker, prompt } = setup(async () => null);
    await checker.check();
    expect(prompt).not.toHaveBeenCalled();
  });

  test('a failed fetch is swallowed and retried on a later trigger', async () => {
    let fail = true;
    const { checker, prompt, advance } = setup(async () => {
      if (fail) throw new Error('offline');
      return newer;
    });
    await expect(checker.check()).resolves.toBeUndefined();
    expect(prompt).not.toHaveBeenCalled();
    fail = false;
    advance(VERSION_CHECK_MIN_GAP_MS);
    await checker.check();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  test('simultaneous triggers share one request', async () => {
    const { checker, fetchServer } = setup(async () => local);
    await Promise.all([checker.check(), checker.check(), checker.check()]);
    expect(fetchServer).toHaveBeenCalledTimes(1);
  });

  test('triggers inside the minimum gap are dropped, later ones go through', async () => {
    const { checker, fetchServer, advance } = setup(async () => local);
    await checker.check();
    advance(VERSION_CHECK_MIN_GAP_MS - 1);
    await checker.check();
    expect(fetchServer).toHaveBeenCalledTimes(1);
    advance(1);
    await checker.check();
    expect(fetchServer).toHaveBeenCalledTimes(2);
  });
});

describe('installVersionCheck', () => {
  let wsHandler: (() => void) | null;
  let off: () => void;
  const checker = { check: vi.fn(() => Promise.resolve()) };

  const setVisibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state,
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    checker.check.mockClear();
    wsHandler = null;
    setVisibility('visible');
    off = installVersionCheck(checker, {
      win: window,
      doc: document,
      onWsConnected: (handler) => {
        wsHandler = handler;
        return () => {
          wsHandler = null;
        };
      },
    });
  });
  afterEach(() => {
    off();
    vi.useRealTimers();
  });

  test('checks when the WebSocket connects or reconnects', () => {
    wsHandler?.();
    expect(checker.check).toHaveBeenCalledTimes(1);
  });

  test('checks when the page becomes visible, not when hidden', () => {
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(checker.check).not.toHaveBeenCalled();
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(checker.check).toHaveBeenCalledTimes(1);
  });

  test('checks on pageshow', () => {
    window.dispatchEvent(new Event('pageshow'));
    expect(checker.check).toHaveBeenCalledTimes(1);
  });

  test('checks every 30 minutes while visible, skips while hidden', () => {
    vi.advanceTimersByTime(VERSION_CHECK_INTERVAL_MS);
    expect(checker.check).toHaveBeenCalledTimes(1);
    setVisibility('hidden');
    vi.advanceTimersByTime(VERSION_CHECK_INTERVAL_MS);
    expect(checker.check).toHaveBeenCalledTimes(1);
    setVisibility('visible');
    vi.advanceTimersByTime(VERSION_CHECK_INTERVAL_MS);
    expect(checker.check).toHaveBeenCalledTimes(2);
  });

  test('uninstall detaches every trigger', () => {
    off();
    expect(wsHandler).toBeNull();
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pageshow'));
    vi.advanceTimersByTime(VERSION_CHECK_INTERVAL_MS * 2);
    expect(checker.check).not.toHaveBeenCalled();
  });
});
