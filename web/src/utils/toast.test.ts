// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';

const toastMock = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: toastMock }));

import { notifyIfHidden, showToast } from './toast';
import { setPushSubscribed } from './webPush';

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
}

afterEach(() => {
  toastMock.mockReset();
  vi.unstubAllGlobals();
  setHidden(false);
  setPushSubscribed(false);
});

describe('showToast', () => {
  test('goes through sonner with the same call signature', () => {
    showToast('发送失败', 'x'.repeat(130), 8000, {
      text: '查看',
      url: 'https://example.com/a',
    });
    expect(toastMock).toHaveBeenCalledTimes(1);
    const [title, options] = toastMock.mock.calls[0];
    expect(title).toBe('发送失败');
    expect(options.description).toBe('x'.repeat(120) + '…');
    expect(options.duration).toBe(8000);
    expect(options.action.label).toBe('查看');

    const open = vi.fn();
    vi.stubGlobal('open', open);
    options.action.onClick();
    expect(open).toHaveBeenCalledWith(
      'https://example.com/a',
      '_blank',
      'noopener,noreferrer',
    );
  });

  test('defaults to five seconds and no action', () => {
    showToast('上传失败');
    expect(toastMock).toHaveBeenCalledWith('上传失败', {
      description: undefined,
      duration: 5000,
      action: undefined,
    });
  });
});

describe('notifyIfHidden', () => {
  test('a Notification constructor that throws never reaches the caller', () => {
    const Throwing = vi.fn(function () {
      throw new TypeError('Illegal constructor');
    });
    vi.stubGlobal(
      'Notification',
      Object.assign(Throwing, { permission: 'granted' }),
    );
    setHidden(true);

    let stateUpdated = false;
    expect(() => {
      notifyIfHidden('HappyClaw', 'done');
      stateUpdated = true;
    }).not.toThrow();
    expect(Throwing).toHaveBeenCalledTimes(1);
    expect(stateUpdated).toBe(true);
  });

  test('after a throw the permission prompt is no longer offered', async () => {
    vi.resetModules();
    const fresh = await import('./toast');
    vi.stubGlobal(
      'Notification',
      Object.assign(
        vi.fn(function () {
          throw new TypeError('Illegal constructor');
        }),
        { permission: 'granted' },
      ),
    );
    setHidden(true);
    fresh.notifyIfHidden('HappyClaw');

    (Notification as unknown as { permission: string }).permission = 'default';
    fresh.showNotificationPromptToast();
    expect(toastMock).not.toHaveBeenCalled();
  });

  test('the permission prompt is offered while permission is undecided', async () => {
    vi.resetModules();
    const fresh = await import('./toast');
    vi.stubGlobal(
      'Notification',
      Object.assign(vi.fn(), { permission: 'default' }),
    );
    fresh.showNotificationPromptToast();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][1].action.label).toBe('开启');
  });

  test('stays silent while the page is visible', () => {
    const Ctor = vi.fn();
    vi.stubGlobal(
      'Notification',
      Object.assign(Ctor, { permission: 'granted' }),
    );
    setHidden(false);
    notifyIfHidden('HappyClaw');
    expect(Ctor).not.toHaveBeenCalled();
  });

  describe('on a device subscribed to Web Push', () => {
    test('leaves to the push only what the server pushes', () => {
      const Ctor = vi.fn();
      vi.stubGlobal(
        'Notification',
        Object.assign(Ctor, { permission: 'granted' }),
      );
      setHidden(true);
      setPushSubscribed(true);

      // A Web-typed turn's reply: the server pushes it.
      notifyIfHidden('ws', 'done', { pushCovered: true });
      expect(Ctor).not.toHaveBeenCalled();

      // Automation and IM replies, background tasks: no push is sent.
      notifyIfHidden('ws', 'automation reply');
      notifyIfHidden('HappyClaw: 后台任务 已完成', 'summary', {
        pushCovered: false,
      });
      expect(Ctor).toHaveBeenCalledTimes(2);
    });

    test('a device that is not subscribed notifies for everything', () => {
      const Ctor = vi.fn();
      vi.stubGlobal(
        'Notification',
        Object.assign(Ctor, { permission: 'granted' }),
      );
      setHidden(true);
      setPushSubscribed(false);
      notifyIfHidden('ws', 'done', { pushCovered: true });
      expect(Ctor).toHaveBeenCalledTimes(1);
    });
  });
});
