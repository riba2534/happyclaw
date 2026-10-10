// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const env = vi.hoisted(() => ({
  touch: false,
  phoneWidth: false,
  keyboardVisible: false,
  /** Pending image encodes, resolved by the test. */
  encodes: [] as Array<() => void>,
  deferEncode: false,
}));

vi.mock('../../stores/chat', async () => {
  const { create } = await import('zustand');
  const useChatStore = create<{
    drafts: Record<string, string>;
    saveDraft: (jid: string, text: string) => void;
    clearDraft: (jid: string) => void;
  }>((set) => ({
    drafts: {},
    saveDraft: (jid, text) =>
      set((s) => {
        const drafts = { ...s.drafts };
        if (text) drafts[jid] = text;
        else delete drafts[jid];
        return { drafts };
      }),
    clearDraft: (jid) =>
      set((s) => {
        const drafts = { ...s.drafts };
        delete drafts[jid];
        return { drafts };
      }),
  }));
  return { useChatStore };
});

vi.mock('../../hooks/useDisplayMode', () => ({
  useDisplayMode: () => ({ mode: 'default' }),
}));

vi.mock('../../hooks/useMediaQuery', () => ({
  useMediaQuery: (query: string) =>
    query.includes('pointer') ? env.touch : env.phoneWidth,
}));

vi.mock('@/hooks/useKeyboardHeight', () => ({
  useKeyboardHeight: () => ({
    keyboardHeight: env.keyboardVisible ? 300 : 0,
    isKeyboardVisible: env.keyboardVisible,
  }),
}));

vi.mock('../../hooks/useHaptic', () => ({ successTap: () => undefined }));

vi.mock('../../lib/image-upload', () => ({
  prepareImageForUpload: (file: File) =>
    new Promise((resolve) => {
      const done = () => resolve({ data: 'AAAA', mimeType: file.type });
      if (env.deferEncode) env.encodes.push(done);
      else done();
    }),
}));

vi.mock('../../lib/follow-up-preferences', () => ({
  FOLLOW_UP_MODE_KEY: 'test-follow-up-mode',
  FOLLOW_UP_MODE_CHANGED_EVENT: 'test-follow-up-mode-changed',
  getDefaultFollowUpMode: () => 'queue',
  alternateFollowUpMode: (mode: 'queue' | 'steer') =>
    mode === 'queue' ? 'steer' : 'queue',
}));

import { useChatStore, type QueuedFollowUp } from '../../stores/chat';
import { MessageInput } from './MessageInput';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let blobCount = 0;
const revoked: string[] = [];

beforeEach(() => {
  env.touch = false;
  env.phoneWidth = false;
  env.keyboardVisible = false;
  env.deferEncode = false;
  env.encodes = [];
  revoked.length = 0;
  useChatStore.setState({ drafts: {} });
  URL.createObjectURL = () => `blob:preview-${++blobCount}`;
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const textarea = () =>
  container!.querySelector('textarea[placeholder]') as HTMLTextAreaElement;
const thumbnails = () =>
  Array.from(container!.querySelectorAll('button[aria-label^="预览图片"]'));

async function render(ui: React.ReactNode) {
  await act(async () => root?.render(ui));
}

async function type(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    setter.call(textarea(), value);
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function keyDown(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (init.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: init.keyCode });
  }
  await act(async () => {
    textarea().dispatchEvent(event);
  });
  return event;
}

async function pickImage(name: string) {
  const input = container!.querySelector(
    'input[type="file"][accept="image/*"]',
  ) as HTMLInputElement;
  await act(async () => {
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['x'], name, { type: 'image/png' })],
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('conversation isolation', () => {
  test('each draft key keeps its own draft and drops staged attachments', async () => {
    const onSend = vi.fn(() => true);
    const view = (key: string) => (
      <MessageInput groupJid="web:g1" draftKey={key} onSend={onSend} />
    );

    await render(view('web:g1'));
    await type('主会话草稿');
    await pickImage('main.png');
    expect(thumbnails()).toHaveLength(1);

    await render(view('web:g1#agent:a1'));
    expect(textarea().value).toBe('');
    expect(thumbnails()).toHaveLength(0);
    expect(revoked).toContain('blob:preview-' + blobCount);
    expect(useChatStore.getState().drafts).toEqual({ 'web:g1': '主会话草稿' });

    await type('会话 A 草稿');
    await render(view('web:g1'));
    expect(textarea().value).toBe('主会话草稿');
    await render(view('web:g1#agent:a1'));
    expect(textarea().value).toBe('会话 A 草稿');
  });

  test('a remount keyed by conversation restores that conversation only', async () => {
    const view = (key: string) => (
      <MessageInput
        key={key}
        groupJid="web:g1"
        draftKey={key}
        onSend={vi.fn()}
      />
    );
    await render(view('web:g1#agent:a1'));
    await type('只属于 A');
    // Unmount flushes the debounced save.
    await render(view('web:g1#agent:a2'));
    expect(textarea().value).toBe('');
    await render(view('web:g1#agent:a1'));
    expect(textarea().value).toBe('只属于 A');
  });

  test('an image that finishes encoding after a switch is dropped', async () => {
    env.deferEncode = true;
    const view = (key: string) => (
      <MessageInput groupJid="web:g1" draftKey={key} onSend={vi.fn()} />
    );
    await render(view('web:g1'));
    await pickImage('late.png');
    await render(view('web:g1#agent:a1'));
    await act(async () => {
      env.encodes.forEach((resolve) => resolve());
    });
    expect(thumbnails()).toHaveLength(0);
    expect(revoked).toContain('blob:preview-' + blobCount);
  });
});

describe('sending', () => {
  test('text typed and images added while a send is in flight survive', async () => {
    const pending = deferred<boolean>();
    const onSend = vi.fn(() => pending.promise);
    await render(<MessageInput groupJid="web:g1" onSend={onSend} />);

    await type('first');
    await keyDown('Enter');
    expect(onSend).toHaveBeenCalledWith('first', undefined, undefined);
    await type('first second');
    await pickImage('later.png');

    await act(async () => pending.resolve(true));
    expect(textarea().value).toBe('second');
    expect(thumbnails()).toHaveLength(1);
    expect(useChatStore.getState().drafts).toEqual({ 'web:g1': 'second' });
  });

  test('only the attachments that were sent leave the tray', async () => {
    const pending = deferred<boolean>();
    const onSend = vi.fn(() => pending.promise);
    await render(<MessageInput groupJid="web:g1" onSend={onSend} />);
    await pickImage('sent.png');
    await keyDown('Enter');
    expect(onSend).toHaveBeenCalledWith(
      '',
      [{ data: 'AAAA', mimeType: 'image/png' }],
      undefined,
    );
    await pickImage('kept.png');
    await act(async () => pending.resolve(true));
    expect(thumbnails().map((node) => node.getAttribute('aria-label'))).toEqual(
      ['预览图片：kept.png'],
    );
  });

  test('Enter follows input capability, not width, and respects IME 229', async () => {
    const onSend = vi.fn(() => true);
    env.phoneWidth = true;
    await render(<MessageInput groupJid="web:g1" onSend={onSend} />);

    await type('你好');
    const ime = await keyDown('Enter', { keyCode: 229 });
    expect(ime.defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();

    await keyDown('Enter');
    expect(onSend).toHaveBeenCalledTimes(1);

    env.touch = true;
    await render(<MessageInput groupJid="web:g1" onSend={onSend} />);
    await type('换行');
    const touchEnter = await keyDown('Enter');
    expect(touchEnter.defaultPrevented).toBe(false);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  test('Esc in an empty composer stops the run', async () => {
    const onStop = vi.fn(() => true);
    await render(
      <MessageInput
        groupJid="web:g1"
        onSend={vi.fn()}
        isRunning
        onStop={onStop}
      />,
    );
    await keyDown('Escape');
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe('queue on phones', () => {
  const queue: QueuedFollowUp[] = [1, 2, 3].map((n) => ({
    id: `q${n}`,
    chat_jid: 'web:g1',
    sender: 'u',
    sender_name: 'u',
    content: `排队 ${n}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    delivery_mode: 'queue',
    delivery_status: 'queued',
    delivery_priority: n,
  }));
  const panel = () =>
    container!.querySelector('[data-testid="queued-follow-ups"]')!;

  test('collapses to a summary and folds back when the keyboard opens', async () => {
    env.touch = true;
    const view = () => (
      <MessageInput
        groupJid="web:g1"
        onSend={vi.fn()}
        isRunning
        queuedFollowUps={queue}
        onFollowUpAction={vi.fn(() => true)}
      />
    );
    await render(view());
    expect(panel().getAttribute('data-state')).toBe('closed');
    expect(panel().textContent).toContain('3 条已排队');
    expect(panel().textContent).toContain('展开');
    expect(panel().textContent).not.toContain('排队 1');

    await act(async () => {
      (panel().querySelector('button[aria-expanded]') as HTMLElement).click();
    });
    expect(panel().getAttribute('data-state')).toBe('open');
    expect(
      panel().querySelector('[data-testid="queued-follow-ups-list"]')!
        .className,
    ).toContain('max-h-[30dvh]');
    // One row per item: "立即发送" inline, the rest behind a menu.
    expect(
      panel().querySelectorAll('button[aria-label^="更多操作"]'),
    ).toHaveLength(3);
    expect(
      panel().querySelectorAll('button[aria-label^="删除排队消息"]'),
    ).toHaveLength(0);

    env.keyboardVisible = true;
    await render(view());
    expect(panel().getAttribute('data-state')).toBe('closed');
  });

  test('stays expanded on desktop', async () => {
    await render(
      <MessageInput
        groupJid="web:g1"
        onSend={vi.fn()}
        isRunning
        queuedFollowUps={queue}
        onFollowUpAction={vi.fn(() => true)}
      />,
    );
    expect(panel().getAttribute('data-state')).toBe('open');
    expect(panel().textContent).toContain('3 条消息已排队，将合并为下一轮');
    expect(
      panel().querySelectorAll('button[aria-label^="删除排队消息"]'),
    ).toHaveLength(3);
  });
});
