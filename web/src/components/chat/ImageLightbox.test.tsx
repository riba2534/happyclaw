// @vitest-environment happy-dom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Message } from '../../stores/chat';
import { findButton } from '../settings/test-helpers';
import { emulatePointer } from '../ui/overlay-test-utils';
import {
  PNG,
  captureDownloads,
  respondWith,
  settle,
  stubShare,
  unstubShare,
} from '../../utils/download-test-utils';

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));
// What MessageBubble pulls in around the images.
vi.mock('../../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  computeUploadTimeoutMs: vi.fn(() => 8000),
}));
vi.mock('../../api/ws', () => ({
  wsManager: {
    send: vi.fn(() => true),
    on: vi.fn(() => vi.fn()),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  },
}));
vi.mock('../../utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: vi.fn(async () => undefined),
  deleteGroupMessageSnapshots: vi.fn(async () => undefined),
  loadAgentMessageSnapshot: vi.fn(async () => null),
  saveAgentMessageSnapshot: vi.fn(async () => undefined),
}));

const { ImageLightbox } = await import('./ImageLightbox');
const { MarkdownContent } = await import('./MarkdownContent');
const { MessageBubble } = await import('./MessageBubble');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Node ships its own (disabled) global localStorage that hides the DOM one.
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  },
});

const fetchMock = vi.fn<typeof fetch>();
let downloads: string[] = [];
let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(node: ReactNode) {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => root!.render(node));
}

const press = (label: string) =>
  act(async () =>
    document
      .querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
      .click(),
  );

const saveButton = () =>
  document.querySelector<HTMLButtonElement>('[aria-label="保存图片"]')!;

/** The viewer's image finishes loading. */
const loaded = () =>
  act(async () => {
    document
      .querySelector('[data-hc-zoom-content] img')!
      .dispatchEvent(new Event('load'));
  });

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  downloads = captureDownloads();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
  toastError.mockReset();
  unstubShare();
});

describe('ImageLightbox save', () => {
  test('on iOS the loaded image is fetched and the tap shares it at once', async () => {
    fetchMock.mockImplementation(respondWith(PNG));
    let inTap = false;
    const sharedInTap: boolean[] = [];
    const share = stubShare(async () => {
      sharedInTap.push(inTap);
    });
    await render(
      <ImageLightbox
        images={['/api/a/original']}
        names={['截图.png']}
        initialIndex={0}
        onClose={() => {}}
      />,
    );
    // Not before the <img> has it, so the fetch reads the cache.
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    await loaded();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The share call has to land inside the tap, before anything awaits:
    // WebKit drops the user activation the sheet needs once it does.
    inTap = true;
    saveButton().click();
    inTap = false;
    expect(sharedInTap).toEqual([true]);
    const [{ files }] = share.mock.calls[0];
    expect(files?.[0].name).toBe('截图.png');
    expect(files?.[0].type).toBe('image/png');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('switching or closing cancels the fetch for the image left', async () => {
    stubShare();
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation(
      (_, init) =>
        new Promise((_resolve, reject) => {
          signals.push(init!.signal!);
          init!.signal!.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    await render(
      <ImageLightbox
        images={['/a.png', '/b.png']}
        initialIndex={0}
        onClose={() => {}}
      />,
    );
    await loaded();
    // A tap that waits on the fetch is cancelled with it, quietly.
    saveButton().click();
    await press('下一张');
    await loaded();
    expect(signals.map((s) => s.aborted)).toEqual([true, false]);
    expect(saveButton().disabled).toBe(false);

    await act(async () => root?.unmount());
    root = null;
    expect(signals[1].aborted).toBe(true);
    await settle();
    expect(toastError).not.toHaveBeenCalled();
  });

  test('off iOS nothing is fetched until the tap, which downloads', async () => {
    fetchMock.mockImplementation(respondWith(PNG));
    const share = stubShare(undefined, { iOS: false });
    await render(
      <ImageLightbox
        images={['/a', '/b']}
        names={['first.png', undefined]}
        initialIndex={1}
        onClose={() => {}}
      />,
    );
    await loaded();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    saveButton().click();
    await settle();
    expect(share).not.toHaveBeenCalled();
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatch(/^image-\d+\.png$/);

    await press('上一张');
    saveButton().click();
    await settle();
    expect(downloads[1]).toBe('first.png');
  });

  test('an image another site will not let the page read says how to save it', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await render(
      <ImageLightbox
        images={['https://img.example.com/a.png']}
        initialIndex={0}
        onClose={() => {}}
      />,
    );
    saveButton().click();
    await settle();
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe('omit');
    expect(toastError).toHaveBeenCalledWith(
      '长按图片保存，或在新标签页打开原图',
    );
    expect(downloads).toEqual([]);
  });

  test('the system image menu is on at 1× only', async () => {
    await render(
      <ImageLightbox images={['/a.png']} initialIndex={0} onClose={() => {}} />,
    );
    const image = document.querySelector('[data-hc-zoom-content] img')!;
    expect(image.className).toContain(
      'in-data-[zoomed=false]:touch-callout-default',
    );
    expect(image.className).not.toMatch(/(^|\s)touch-callout-default/);
  });
});

describe('a message’s attached images', () => {
  const message: Message = {
    id: 'm1',
    chat_jid: 'web:w#agent:s1',
    sender: 'u1',
    sender_name: 'me',
    content: '看看这两张',
    timestamp: '2026-11-02T00:00:00.000Z',
    is_from_me: false,
    attachments: JSON.stringify([
      { type: 'image', data: 'AAAA', mimeType: 'image/png', name: '收据.png' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png', hasOriginal: true },
    ]),
  };

  test('save from the viewer under the attachment’s name', async () => {
    fetchMock.mockImplementation(respondWith(PNG, 'image/png'));
    await render(<MessageBubble message={message} showTime={false} />);
    const thumbnails = [...container!.querySelectorAll('button img')];
    expect(thumbnails).toHaveLength(2);
    // A thumbnail is a small preview: saving is the viewer's, at full size.
    for (const thumbnail of thumbnails) {
      expect(thumbnail.className).not.toContain('touch-callout-default');
    }

    await act(async () =>
      (thumbnails[0].closest('button') as HTMLButtonElement).click(),
    );
    saveButton().click();
    await settle();
    expect(downloads).toEqual(['收据.png']);

    await press('下一张');
    saveButton().click();
    await settle();
    expect(fetchMock.mock.calls[1][0]).toBe(
      'http://localhost:3000/api/groups/web%3Aw%23agent%3As1/messages/m1/attachments/1/original',
    );
    expect(downloads[1]).toMatch(/^image-\d+\.png$/);
  });
});

describe('a long press in a reply on a phone', () => {
  const reply: Message = {
    id: 'm2',
    chat_jid: 'web:w#agent:s1',
    sender: 'happyclaw-agent',
    sender_name: 'HappyClaw',
    content: '结果如下\n\n![图表](output/图表.png)',
    timestamp: '2026-11-02T00:00:00.000Z',
    is_from_me: true,
    source_kind: 'sdk_final',
  };

  /** Holds a finger on `target`; whether the native menu was blocked. */
  function hold(target: Element) {
    vi.useFakeTimers();
    act(() => {
      target.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          pointerId: 1,
          pointerType: 'touch',
          isPrimary: true,
        }),
      );
      vi.advanceTimersByTime(600);
    });
    vi.useRealTimers();
    const menu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      target.dispatchEvent(menu);
    });
    return { nativeMenuBlocked: menu.defaultPrevented };
  }

  const messageMenuOpen = () => !!findButton('复制文本');

  async function mountReply() {
    emulatePointer('phone');
    await render(<MessageBubble message={reply} showTime={false} />);
    return container!.querySelector<HTMLElement>('img[data-hc-md-image]')!;
  }

  test('on a Markdown image it is the system menu’s, on the text the message’s', async () => {
    const image = await mountReply();
    expect(hold(image)).toEqual({ nativeMenuBlocked: false });
    expect(messageMenuOpen()).toBe(false);

    const text = [...container!.querySelectorAll('p')].find(
      (p) => p.textContent === '结果如下',
    )!;
    expect(hold(text)).toEqual({ nativeMenuBlocked: true });
    expect(messageMenuOpen()).toBe(true);
  });

  test('in the viewer opened from the reply it is not the reply’s', async () => {
    const image = await mountReply();
    // The viewer is portalled out of the reply, but React passes its events
    // up to it.
    await act(async () => image.click());
    const viewerImage = document.querySelector('[data-hc-zoom-content] img')!;
    expect(hold(viewerImage)).toEqual({ nativeMenuBlocked: false });
    expect(messageMenuOpen()).toBe(false);
  });
});

describe('Markdown images', () => {
  const markdown = (content: string) =>
    render(
      <MarkdownContent
        content={content}
        groupJid="web:w"
        remarkPlugins={[]}
        rehypePlugins={[]}
        pipeline="test"
      />,
    );

  test('save under the file name their path ends in', async () => {
    fetchMock.mockImplementation(respondWith(PNG));
    await markdown(
      '![图](output/图表.png) ![远程](https://cdn.example.com/a/b.png?x=1)',
    );
    const images = [
      ...container!.querySelectorAll<HTMLImageElement>('img[data-hc-md-image]'),
    ];
    expect(images.map((img) => img.dataset.hcMdName)).toEqual([
      '图表.png',
      'b.png',
    ]);

    await act(async () => images[0].click());
    saveButton().click();
    await settle();
    expect(downloads).toEqual(['图表.png']);
  });

  test('a linked workspace image opened on a phone saves under its name', async () => {
    emulatePointer('phone');
    fetchMock.mockImplementation(respondWith(PNG));
    await markdown('[看图](output/图表.png)');
    // A real click: `captureDownloads` stands in for HTMLAnchorElement#click.
    await act(async () => {
      container!
        .querySelector('a')!
        .dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
    });
    saveButton().click();
    await settle();
    expect(downloads).toEqual(['图表.png']);
  });
});
