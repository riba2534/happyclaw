// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const env = vi.hoisted(() => ({
  touch: false,
  phoneWidth: false,
  /** `(max-width: 479px)`: reset and terminal fold into the + menu. */
  narrow: false,
  /** useIsPhone: touch and narrower than 1024px. */
  phone: false,
  /** `(min-width: 1024px)`: tablets in landscape, desktops. */
  wide: false,
  keyboardHeight: 0,
  /** Pending image encodes, resolved by the test. */
  encodes: [] as Array<() => void>,
  deferEncode: false,
  /** Responses of the mocked API client, by path. */
  api: {} as Record<string, unknown>,
  /** The transcript's display mode; compact rows fill the whole width. */
  displayMode: 'chat' as 'chat' | 'compact',
}));

vi.mock('../../stores/chat', async () => {
  const { create } = await import('zustand');
  const useChatStore = create<{
    groups: Record<string, { agent_profile_id?: string }>;
    messages: Record<string, unknown[]>;
    agentMessages: Record<string, unknown[]>;
    drafts: Record<string, string>;
    saveDraft: (jid: string, text: string) => void;
    clearDraft: (jid: string) => void;
  }>((set) => ({
    groups: {},
    messages: {},
    agentMessages: {},
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

vi.mock('../../api/client', () => {
  const respond = async (path: string) => {
    const key = Object.keys(env.api).find((prefix) => path.startsWith(prefix));
    if (!key) throw { status: 404, message: `unexpected ${path}` };
    return env.api[key];
  };
  return {
    api: {
      get: (path: string) => respond(path),
      post: (path: string) => respond(path),
    },
    apiFetch: (path: string) => respond(path),
    computeUploadTimeoutMs: () => 1000,
  };
});

vi.mock('../../hooks/useDisplayMode', () => ({
  useDisplayMode: () => ({ mode: env.displayMode }),
}));

vi.mock('../layout/phone', () => ({
  useIsPhone: () => env.phone,
}));

vi.mock('../../hooks/useMediaQuery', () => ({
  useMediaQuery: (query: string) =>
    query.includes('pointer')
      ? env.touch
      : query.includes('479px')
        ? env.narrow
        : query.includes('min-width: 1024px')
          ? env.wide
          : env.phoneWidth,
}));

vi.mock('@/hooks/useKeyboardHeight', () => ({
  useKeyboardHeight: () => ({
    keyboardHeight: env.keyboardHeight,
    isKeyboardVisible: env.keyboardHeight > 0,
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

import { useAuthStore } from '../../stores/auth';
import { useChatStore, type QueuedFollowUp } from '../../stores/chat';
import { useFileStore } from '../../stores/files';
import { useShellStore } from '../../stores/shell';
import { serializeEditorContent } from './composer/cindy/composerContentSerialization';
import { plainTextToComposerDocument } from './composer/cindy/composerListDocument';
import { useComposerDock, useDockOverlay } from './composer/composerDock';
import { clearPaletteSourceCache } from './composer/paletteSources';
import { MessageInput } from './MessageInput';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Node's own (file-less) localStorage shadows the DOM one in this environment.
const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  get length() {
    return storage.size;
  },
  key: (index: number) => [...storage.keys()][index] ?? null,
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
} satisfies Storage);

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let blobCount = 0;
const revoked: string[] = [];
const uploadFiles = vi.fn(async () => true);

beforeEach(() => {
  env.touch = false;
  env.phoneWidth = false;
  env.narrow = false;
  env.phone = false;
  env.wide = false;
  env.keyboardHeight = 0;
  env.deferEncode = false;
  env.encodes = [];
  env.api = {};
  env.displayMode = 'chat';
  revoked.length = 0;
  storage.clear();
  clearPaletteSourceCache();
  useChatStore.setState({
    groups: {},
    messages: {},
    agentMessages: {},
    drafts: {},
  });
  useAuthStore.setState({ user: null });
  uploadFiles.mockClear();
  useFileStore.setState({ currentPath: {}, uploadFiles });
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

// --- Driver: the composer is a Tiptap editor (contenteditable). ---

const editorEl = () =>
  container!.querySelector('[data-composer-editor]') as HTMLElement;
const editor = () => (editorEl() as unknown as { editor: Editor }).editor;
/** The composer content as it would be sent. */
const text = () => serializeEditorContent(editor()).text;
const thumbnails = () =>
  Array.from(container!.querySelectorAll('button[aria-label^="预览图片"]'));
const paletteRows = () =>
  Array.from(container!.querySelectorAll('[role="option"]')).map(
    (row) => row.textContent ?? '',
  );

async function render(ui: React.ReactNode) {
  await act(async () => root?.render(ui));
}

/** Replace the composer content, as typing it would. */
async function type(value: string) {
  await act(async () => {
    editor().commands.setContent(plainTextToComposerDocument(value));
  });
}

/** Insert text at the caret (keeps what is already there). */
async function typeAtCaret(value: string) {
  await act(async () => {
    editor().commands.insertContent(value);
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
    editorEl().dispatchEvent(event);
  });
  return event;
}

/** Paste through ProseMirror's clipboard path. */
async function paste(data: { text?: string; html?: string; files?: File[] }) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) =>
        type === 'text/plain'
          ? (data.text ?? '')
          : type === 'text/html'
            ? (data.html ?? '')
            : '',
      items: (data.files ?? []).map((file) => ({
        kind: 'file',
        type: file.type,
        getAsFile: () => file,
      })),
      files: data.files ?? [],
      types: ['text/plain'],
    },
  });
  await act(async () => {
    editorEl().dispatchEvent(event);
  });
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

async function pickFiles(files: File[]) {
  const input = container!.querySelector(
    'input[type="file"]:not([accept]):not([webkitdirectory])',
  ) as HTMLInputElement;
  await act(async () => {
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: files,
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const wait = (ms: number) =>
  act(() => new Promise((resolve) => setTimeout(resolve, ms)));

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
    expect(text()).toBe('');
    expect(thumbnails()).toHaveLength(0);
    expect(revoked).toContain('blob:preview-' + blobCount);
    expect(useChatStore.getState().drafts).toEqual({ 'web:g1': '主会话草稿' });

    await type('会话 A 草稿');
    await render(view('web:g1'));
    expect(text()).toBe('主会话草稿');
    await render(view('web:g1#agent:a1'));
    expect(text()).toBe('会话 A 草稿');
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
    expect(text()).toBe('');
    await render(view('web:g1#agent:a1'));
    expect(text()).toBe('只属于 A');
  });

  test('a send in flight is not offered again by a composer remounted for it', async () => {
    const pending = deferred<boolean>();
    const onSend = vi.fn(() => pending.promise);
    const view = (key: string) => (
      <MessageInput
        key={key}
        groupJid="web:g1"
        draftKey={key}
        onSend={onSend}
      />
    );
    await render(view('web:g1'));
    await type('hello main');
    await wait(350);
    expect(useChatStore.getState().drafts).toEqual({ 'web:g1': 'hello main' });

    await keyDown('Enter');
    await render(view('web:g1#agent:a1'));
    await render(view('web:g1'));
    expect(text()).toBe('');

    await act(async () => pending.resolve(true));
    expect(text()).toBe('');
    expect(useChatStore.getState().drafts).toEqual({});
    await keyDown('Enter');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  test('what was typed after a send in flight follows a remount', async () => {
    const pending = deferred<boolean>();
    const view = (key: string) => (
      <MessageInput
        key={key}
        groupJid="web:g1"
        draftKey={key}
        onSend={() => pending.promise}
      />
    );
    await render(view('web:g1'));
    await type('hello');
    await keyDown('Enter');
    await type('hello more');
    // Unmount flushes the pending draft save, minus the in-flight text.
    await render(view('web:g1#agent:a1'));
    await render(view('web:g1'));
    expect(text()).toBe('more');
    await act(async () => pending.resolve(true));
    expect(text()).toBe('more');
  });

  test('a send that fails after a remount puts its text back', async () => {
    const pending = deferred<boolean>();
    const view = (key: string) => (
      <MessageInput
        key={key}
        groupJid="web:g1"
        draftKey={key}
        onSend={() => pending.promise}
      />
    );
    await render(view('web:g1'));
    await type('will fail');
    await keyDown('Enter');
    await render(view('web:g1#agent:a1'));
    await render(view('web:g1'));
    expect(text()).toBe('');
    await act(async () => pending.resolve(false));
    expect(text()).toBe('will fail');
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

describe('status bar', () => {
  const bar = () => container!.querySelector('[data-composer-status-bar]');
  const view = (props: {
    isRunning: boolean;
    layout?: 'docked' | 'centered';
  }) => (
    <MessageInput
      groupJid="web:g1"
      onSend={vi.fn()}
      onStop={vi.fn()}
      statusBar={<span data-testid="status" />}
      {...props}
    />
  );

  test('a docked composer keeps its row right above the card, run or not', async () => {
    for (const isRunning of [false, true, false]) {
      await render(view({ isRunning }));
      // Reserved at a fixed height whatever the run does.
      expect(bar()!.querySelector('[data-testid="status"]')).not.toBeNull();
      expect(bar()!.classList).toContain('h-8');
      // Directly above the card's anchor.
      expect(
        bar()!.nextElementSibling!.contains(
          container!.querySelector('[data-composer-card]'),
        ),
      ).toBe(true);
    }
  });

  test('the empty conversation hero has none', async () => {
    await render(view({ isRunning: true, layout: 'centered' }));
    expect(bar()).toBeNull();
  });
});

describe('phone dock', () => {
  test('follows the shared phone hook (touch and narrower than 1024px)', async () => {
    // Touch alone is a tablet; the dock waits for useIsPhone.
    env.touch = true;
    await render(<MessageInput groupJid="web:g1" onSend={vi.fn()} />);
    const root = () => container!.querySelector('[data-hc-composer]')!;
    expect(root().hasAttribute('data-composer-dock')).toBe(false);
    env.phone = true;
    await render(<MessageInput groupJid="web:g1" onSend={vi.fn()} />);
    expect(root().getAttribute('data-composer-dock')).toBe('pill');
  });

  test('rests as a pill and opens into the card with focus or content', async () => {
    env.phone = true;
    await render(
      <MessageInput
        groupJid="web:g1"
        onSend={vi.fn()}
        modelSelector={<span data-testid="model" />}
      />,
    );
    const dock = () =>
      container!
        .querySelector('[data-hc-composer]')!
        .getAttribute('data-composer-dock');
    expect(dock()).toBe('pill');
    // The model waits in the card, mounted.
    expect(container!.querySelector('[data-testid="model"]')).not.toBeNull();

    await act(async () => {
      editor().commands.focus();
    });
    expect(dock()).toBe('card');
    await act(async () => {
      editor().commands.blur();
    });
    expect(dock()).toBe('pill');

    // Something in it keeps the card open without focus.
    await typeAtCaret('草稿');
    await act(async () => {
      editor().commands.blur();
    });
    expect(dock()).toBe('card');
  });

  /** A dock control that reports its sheet, and shows the compact flag. */
  let reportSheet: (open: boolean) => void = () => {};
  function SheetControl({ name }: { name?: string }) {
    const report = useDockOverlay()[1];
    if (name) reports[name] = report;
    else reportSheet = report;
    const compact = useComposerDock()?.compact;
    return <button type="button" data-compact={String(compact)} />;
  }
  const reports: Record<string, (open: boolean) => void> = {};

  test('a sheet a dock control opened keeps the card open; leaving for the page folds it', async () => {
    env.phone = true;
    await render(
      <MessageInput
        groupJid="web:g1"
        onSend={vi.fn()}
        modelSelector={<SheetControl />}
      />,
    );
    const dock = () =>
      container!
        .querySelector('[data-hc-composer]')!
        .getAttribute('data-composer-dock');
    const compact = () =>
      container!.querySelector('[data-compact]')!.getAttribute('data-compact');
    const outside = document.body.appendChild(document.createElement('input'));
    expect(compact()).toBe('true');

    // Opened from the resting pill: the card opens for it, focus or not.
    await act(async () => reportSheet(true));
    expect(dock()).toBe('card');
    expect(compact()).toBe('false');
    await act(async () => reportSheet(false));
    expect(dock()).toBe('pill');

    // Opened from the card: focus leaving for the sheet does not fold it,
    // and closing it with focus still outside does.
    await act(async () => {
      editor().commands.focus();
    });
    await act(async () => reportSheet(true));
    await act(async () => outside.focus());
    expect(dock()).toBe('card');
    await act(async () => reportSheet(false));
    expect(dock()).toBe('pill');

    // Focus back in the dock when it closes keeps the card.
    await act(async () => {
      editor().commands.focus();
    });
    await act(async () => reportSheet(true));
    await act(async () => {
      editor().commands.focus();
    });
    await act(async () => reportSheet(false));
    expect(dock()).toBe('card');
    await act(async () => outside.focus());
    expect(dock()).toBe('pill');
    outside.remove();
  });

  test("two controls report apart: one leaving keeps the other's sheet counted", async () => {
    env.phone = true;
    const view = (both: boolean) => (
      <MessageInput
        groupJid="web:g1"
        onSend={vi.fn()}
        modelSelector={
          <>
            <SheetControl name="a" />
            {both && <SheetControl name="b" />}
          </>
        }
      />
    );
    await render(view(true));
    await act(async () => reports.a(true));
    await act(async () => reports.b(true));
    await render(view(false));
    expect(
      container!
        .querySelector('[data-hc-composer]')!
        .getAttribute('data-composer-dock'),
    ).toBe('card');
    await act(async () => reports.a(false));
    expect(
      container!
        .querySelector('[data-hc-composer]')!
        .getAttribute('data-composer-dock'),
    ).toBe('pill');
  });

  test('a control unmounted with its sheet open no longer holds the card', async () => {
    env.phone = true;
    const view = (control: boolean) => (
      <MessageInput
        groupJid="web:g1"
        onSend={vi.fn()}
        modelSelector={control ? <SheetControl /> : <span />}
      />
    );
    await render(view(true));
    await act(async () => reportSheet(true));
    await render(view(false));
    expect(
      container!
        .querySelector('[data-hc-composer]')!
        .getAttribute('data-composer-dock'),
    ).toBe('pill');
  });

  test('publishes its height for the list it floats over', async () => {
    env.phone = true;
    container!.setAttribute('data-composer-dock-host', '');
    await render(<MessageInput groupJid="web:g1" onSend={vi.fn()} />);
    // The card and its 24px feathered edge; the keyboard lift separately.
    expect(container!.style.getPropertyValue('--composer-dock-height')).toBe(
      '24px',
    );
    expect(container!.style.getPropertyValue('--composer-dock-lift')).toContain(
      'var(--keyboard-height',
    );
    env.phone = false;
    await render(<MessageInput groupJid="web:g1" onSend={vi.fn()} />);
    expect(container!.style.getPropertyValue('--composer-dock-height')).toBe(
      '',
    );
    container!.removeAttribute('data-composer-dock-host');
    expect(
      container!
        .querySelector('[data-hc-composer]')!
        .hasAttribute('data-composer-dock'),
    ).toBe(false);
  });
});

describe('layout', () => {
  const view = (layout: 'docked' | 'centered', placeholder = 'a') => (
    <MessageInput
      groupJid="web:g1"
      onSend={vi.fn()}
      layout={layout}
      placeholder={placeholder}
    />
  );

  /**
   * Renders centred at 300, then docks to 700: the card sits where its
   * committed layout puts it. `moved` shifts it while centred without a
   * commit, as a growing editor or a scrolled page does.
   */
  async function dock(moved = 0) {
    await render(view('centered'));
    const root = container!.querySelector('[data-hc-composer]') as HTMLElement;
    const card = container!.querySelector(
      '[data-composer-card]',
    ) as HTMLElement;
    const animate = vi.fn();
    let centredTop = 300;
    card.getBoundingClientRect = () =>
      ({
        top: root.dataset.composerLayout === 'docked' ? 700 : centredTop,
      }) as DOMRect;
    card.animate = animate;
    await render(view('centered', 'b'));
    centredTop += moved;
    await render(view('docked', 'b'));
    return { card, animate };
  }

  test('a centred card is taller; docking slides it down to its place', async () => {
    await render(view('centered'));
    const root = container!.querySelector('[data-hc-composer]')!;
    expect(root.getAttribute('data-composer-layout')).toBe('centered');
    expect(root.querySelector('.min-h-\\[120px\\]')).not.toBeNull();

    const { card, animate } = await dock();
    expect(animate).toHaveBeenCalledWith(
      [{ transform: 'translateY(-400px)' }, { transform: 'none' }],
      expect.any(Object),
    );
    // About 120px at rest in a conversation; a phone keeps it lower.
    expect(card.querySelector('.sm\\:min-h-\\[118px\\]')).not.toBeNull();
    expect(card.querySelector('.min-h-\\[96px\\]')).not.toBeNull();
    // Later commits leave the docked card alone.
    await render(view('docked', 'c'));
    expect(animate).toHaveBeenCalledTimes(1);
  });

  test('a compact transcript still centres the hero at the starter width', async () => {
    env.displayMode = 'compact';
    const column = () =>
      container!.querySelector('[data-composer-card]')!.parentElement!
        .parentElement!;

    await render(view('centered'));
    expect(column().className).toContain('max-w-3xl');

    // Docked, compact mode keeps the full width to line up with the
    // compact message rows.
    await render(view('docked'));
    expect(column().className).not.toContain('max-w-3xl');
  });

  test('the context ring sits in the toolbar after the tools, off phones', async () => {
    const ring = <span data-testid="ring" />;
    const view = (layout: 'docked' | 'centered') => (
      <MessageInput
        groupJid="web:g1"
        onSend={vi.fn()}
        onResetSession={vi.fn()}
        onToggleTerminal={vi.fn()}
        layout={layout}
        contextUsage={ring}
      />
    );
    await render(view('docked'));
    const tools = container!.querySelector(
      '[data-composer-toolbar] [data-composer-tools]',
    )!;
    const slot = tools.querySelector('[data-composer-context]')!;
    expect(slot.querySelector('[data-testid="ring"]')).not.toBeNull();
    // After the tool buttons, at a width kept whatever the ring renders.
    expect(slot.previousElementSibling?.getAttribute('aria-label')).toBe(
      '终端',
    );
    expect(slot.classList).toContain('w-[3.25rem]');
    expect(slot.classList).toContain('shrink-0');
    // Nothing is left under the card (or the palette anchor around it).
    const card = container!.querySelector('[data-composer-card]')!;
    expect(card.nextElementSibling).toBeNull();
    expect(card.parentElement!.nextElementSibling).toBeNull();

    await render(view('centered'));
    expect(container!.querySelector('[data-testid="ring"]')).toBeNull();

    // Not mounted on a phone, so it does not load either.
    env.phoneWidth = true;
    await render(view('docked'));
    expect(container!.querySelector('[data-testid="ring"]')).toBeNull();
  });

  test('a narrow row keeps only + and folds reset and terminal into its menu', async () => {
    const toolbar = () => container!.querySelector('[data-composer-toolbar]')!;
    const labels = () =>
      [...toolbar().querySelectorAll('[data-composer-tools] button')].map(
        (button) => button.getAttribute('aria-label'),
      );
    const props = {
      groupJid: 'web:g1',
      onSend: vi.fn(),
      onResetSession: vi.fn(),
      onToggleTerminal: vi.fn(),
    };
    await render(<MessageInput {...props} />);
    expect(labels()).toEqual(['添加文件', '清除当前会话上下文', '终端']);
    env.narrow = true;
    await render(<MessageInput {...props} placeholder="b" />);
    expect(labels()).toEqual(['更多操作']);
  });

  test('clearing the context shows a brush', async () => {
    await render(
      <MessageInput
        groupJid="web:g1"
        onSend={vi.fn()}
        onResetSession={vi.fn()}
      />,
    );
    const button = container!.querySelector(
      'button[aria-label="清除当前会话上下文"]',
    )!;
    expect(button.querySelector('svg.lucide-paintbrush')).not.toBeNull();
  });

  test('the slide starts where the card is when it docks', async () => {
    const { animate } = await dock(-40);
    expect(animate).toHaveBeenCalledWith(
      [{ transform: 'translateY(-440px)' }, { transform: 'none' }],
      expect.any(Object),
    );
  });

  test('with less motion the card docks without sliding', async () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('reduce'),
    })) as unknown as typeof window.matchMedia;
    try {
      const { animate } = await dock();
      expect(animate).not.toHaveBeenCalled();
    } finally {
      window.matchMedia = matchMedia;
    }
  });
});

describe('drafts across reloads', () => {
  const persisted = () =>
    [...storage.keys()].filter((key) =>
      key.startsWith('happyclaw:composer-draft:'),
    );

  test('a draft survives a reload and leaves storage once sent', async () => {
    useAuthStore.setState({ user: { id: 'u1' } as never });
    const onSend = vi.fn(() => true);
    const view = (key: string) => (
      <MessageInput
        key={key}
        groupJid="web:g1"
        draftKey={key}
        onSend={onSend}
      />
    );
    await render(view('web:g1'));
    await type('刷新后还在');
    await wait(350);
    expect(persisted()).toHaveLength(1);

    // A reload: the in-memory store starts empty.
    await render(view('web:g1#agent:a1'));
    useChatStore.setState({ drafts: {} });
    await render(view('web:g1'));
    expect(text()).toBe('刷新后还在');

    await keyDown('Enter');
    expect(onSend).toHaveBeenCalledWith('刷新后还在', undefined, undefined);
    expect(persisted()).toHaveLength(0);
  });

  test('drafts of another user are not restored', async () => {
    useAuthStore.setState({ user: { id: 'u1' } as never });
    await render(<MessageInput key="a" groupJid="web:g1" onSend={vi.fn()} />);
    await type('u1 的草稿');
    await wait(350);
    await render(<MessageInput key="b" groupJid="web:g2" onSend={vi.fn()} />);
    useChatStore.setState({ drafts: {} });
    useAuthStore.setState({ user: { id: 'u2' } as never });
    await render(<MessageInput key="c" groupJid="web:g1" onSend={vi.fn()} />);
    expect(text()).toBe('');
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
    expect(text()).toBe('second');
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

  test('a narrow desktop window sends on Enter and ignores IME 229', async () => {
    const onSend = vi.fn(() => true);
    env.phoneWidth = true;
    await render(<MessageInput groupJid="web:g1" onSend={onSend} />);

    await type('你好');
    // The committing Enter of an IME neither sends nor breaks the line.
    await keyDown('Enter', { keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    expect(text()).toBe('你好');

    await keyDown('Enter');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  test('an Enter right after an IME commit (Safari) does not send', async () => {
    const onSend = vi.fn(() => true);
    await render(<MessageInput groupJid="web:g1" onSend={onSend} />);
    await type('日本語');
    await act(async () => {
      editorEl().dispatchEvent(new Event('compositionend', { bubbles: true }));
    });
    await keyDown('Enter');
    expect(onSend).not.toHaveBeenCalled();
    expect(text()).toBe('日本語');
    await wait(120);
    await keyDown('Enter');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  test('a phone types a newline on Enter; mod+Enter still sends', async () => {
    const onSend = vi.fn(() => true);
    env.touch = true;
    env.phoneWidth = true;
    await render(<MessageInput groupJid="web:g1" onSend={onSend} isRunning />);
    await type('换行');
    await keyDown('Enter');
    expect(onSend).not.toHaveBeenCalled();
    expect(
      editorEl().querySelectorAll('br:not(.ProseMirror-trailingBreak)'),
    ).toHaveLength(1);

    await keyDown('Enter', { ctrlKey: true });
    expect(onSend).toHaveBeenLastCalledWith('换行', undefined, 'queue');
    await type('引导');
    await keyDown('Enter', { metaKey: true, shiftKey: true });
    expect(onSend).toHaveBeenLastCalledWith('引导', undefined, 'steer');
  });

  test('a tablet on a hardware keyboard sends on Enter, not with the software keyboard up', async () => {
    const onSend = vi.fn(() => true);
    env.touch = true;
    env.wide = true;
    const view = () => <MessageInput groupJid="web:g1" onSend={onSend} />;
    await render(view());
    await type('硬件键盘');
    expect((await keyDown('Enter')).defaultPrevented).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(1);

    env.keyboardHeight = 360;
    await render(view());
    await type('软键盘');
    await keyDown('Enter');
    expect(onSend).toHaveBeenCalledTimes(1);
    await keyDown('Enter', { metaKey: true });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenLastCalledWith('软键盘', undefined, undefined);
  });

  test('Shift+Enter continues a list and Enter sends it as Markdown', async () => {
    const onSend = vi.fn(() => true);
    await render(<MessageInput groupJid="web:g1" onSend={onSend} />);
    await type('- 第一项');
    await act(async () => {
      editor().commands.focus('end');
    });
    await keyDown('Enter', { shiftKey: true });
    await typeAtCaret('第二项');
    await keyDown('Enter');
    expect(onSend).toHaveBeenCalledWith(
      '- 第一项\n- 第二项',
      undefined,
      undefined,
    );
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

  test('a paste over the server limit is refused before it lands', async () => {
    const onSend = vi.fn(() => true);
    await render(<MessageInput groupJid="web:g1" onSend={onSend} />);
    await paste({ text: 'x'.repeat(64 * 1024 + 1) });
    expect(text()).toBe('');
    expect(editorEl().querySelector('[data-pasted-text-chip]')).toBeNull();
    expect(container!.textContent).toContain('粘贴的内容超过 64K 字符上限');
  });

  test('a message that grows over the server limit is not sent', async () => {
    const onSend = vi.fn(() => true);
    await render(<MessageInput groupJid="web:g1" onSend={onSend} />);
    await paste({ text: 'x'.repeat(40 * 1024) });
    await paste({ text: 'y'.repeat(30 * 1024) });
    await keyDown('Enter');
    expect(onSend).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('消息超过 64K 字符上限');
  });
});

describe('long pastes', () => {
  test('a long paste folds into a chip and is sent as the original text', async () => {
    const onSend = vi.fn(() => true);
    await render(<MessageInput groupJid="web:g1" onSend={onSend} />);
    const log = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join(
      '\n',
    );
    await typeAtCaret('看看这段日志：');
    await paste({ text: log });
    const chip = editorEl().querySelector('[data-pasted-text-chip]');
    expect(chip?.textContent).toBe('粘贴文本 · 30 行');
    expect(editorEl().textContent).not.toContain('line 2');

    await keyDown('Enter');
    expect(onSend).toHaveBeenCalledWith(
      `看看这段日志：${log}`,
      undefined,
      undefined,
    );
  });

  test('a short multi-line paste stays text with its line breaks', async () => {
    const onSend = vi.fn(() => true);
    await render(<MessageInput groupJid="web:g1" onSend={onSend} />);
    await paste({ text: 'a\nb', html: '<b>a</b><br>b' });
    expect(editorEl().querySelector('[data-pasted-text-chip]')).toBeNull();
    expect(text()).toBe('a\nb');
  });

  test('a pasted image becomes an attachment and its text is inserted once', async () => {
    await render(<MessageInput groupJid="web:g1" onSend={vi.fn()} />);
    await paste({
      text: '截图说明',
      files: [new File(['x'], 'shot.png', { type: 'image/png' })],
    });
    expect(text()).toBe('截图说明');
    expect(thumbnails()).toHaveLength(1);
  });
});

describe('expanding a long paste', () => {
  const log = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');

  test('clicking the chip turns it back into editable text in place', async () => {
    await render(<MessageInput groupJid="web:g1" onSend={vi.fn()} />);
    await typeAtCaret('前文 ');
    await paste({ text: log });
    await typeAtCaret(' 后文');
    // ProseMirror resolves a real click from its coordinates (covered by the
    // e2e); here the click handler gets the node directly.
    await act(async () => {
      const { view } = editor();
      let chipPos = -1;
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'pastedTextChip') chipPos = pos;
      });
      view.someProp('handleClickOn', (handle) =>
        handle(
          view,
          chipPos,
          view.state.doc.nodeAt(chipPos)!,
          chipPos,
          new MouseEvent('click'),
          true,
        ),
      );
    });
    expect(editorEl().querySelector('[data-pasted-text-chip]')).toBeNull();
    expect(text()).toBe(`前文 ${log} 后文`);
  });

  test("on a touch screen only the chip's expand control unfolds it", async () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(pointer: coarse)',
    })) as unknown as typeof window.matchMedia;
    try {
      await render(<MessageInput groupJid="web:g1" onSend={vi.fn()} />);
      await paste({ text: log });
      const chip = () =>
        editorEl().querySelector<HTMLElement>('[data-pasted-text-chip]');
      const clickOn = (target: Element) =>
        act(async () => {
          const { view } = editor();
          const event = new MouseEvent('click');
          Object.defineProperty(event, 'target', { value: target });
          view.someProp('handleClickOn', (handle) =>
            handle(view, 1, view.state.doc.nodeAt(1)!, 1, event, true),
          );
        });
      await clickOn(chip()!);
      expect(chip()).not.toBeNull();
      await clickOn(chip()!.querySelector('[data-pasted-text-expand]')!);
      expect(chip()).toBeNull();
      expect(text()).toBe(log);
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  test('Enter on a selected chip expands it instead of sending', async () => {
    const onSend = vi.fn(() => true);
    await render(<MessageInput groupJid="web:g1" onSend={onSend} />);
    await paste({ text: log });
    await act(async () => {
      editor().commands.setNodeSelection(1);
    });
    await keyDown('Enter');
    expect(onSend).not.toHaveBeenCalled();
    expect(editorEl().querySelector('[data-pasted-text-chip]')).toBeNull();
    expect(text()).toBe(log);
  });
});

describe('answering AskUserQuestion', () => {
  test('each picked option lands on its own line', async () => {
    await render(<MessageInput groupJid="web:g1" onSend={vi.fn()} />);
    await act(async () =>
      useShellStore.getState().requestComposerDraft('选项 A'),
    );
    await act(async () =>
      useShellStore.getState().requestComposerDraft('选项 B'),
    );
    expect(text()).toBe('选项 A\n选项 B');
  });

  // A card fills under its toolUseId; filling again replaces its last text.
  beforeEach(() => useShellStore.setState({ composerFills: {} }));
  const fill = (value: string) =>
    act(async () =>
      useShellStore.getState().requestComposerDraft(value, 'toolu_1'),
    );
  const fills = () => useShellStore.getState().composerFills;

  test("a card's new answer takes the place of its last one", async () => {
    await render(<MessageInput groupJid="web:g1" onSend={vi.fn()} />);
    await type('先说一句');
    await fill('周末去哪？\n答：看展\n带什么？\n答：水');
    await fill('周末去哪？\n答：爬山\n带什么？\n答：水');
    expect(text()).toBe('先说一句\n周末去哪？\n答：爬山\n带什么？\n答：水');
    await fill('甲');
    await fill('乙');
    expect(text()).toBe('先说一句\n乙');
    // Another card's answer is its own.
    await act(async () =>
      useShellStore.getState().requestComposerDraft('丙', 'toolu_2'),
    );
    expect(text()).toBe('先说一句\n乙\n丙');
  });

  test('an answer the user edited stays, and the next one is appended', async () => {
    await render(<MessageInput groupJid="web:g1" onSend={vi.fn()} />);
    await fill('甲');
    await typeAtCaret('，但要快');
    expect(fills()).toEqual({});
    await fill('乙');
    expect(text()).toBe('甲，但要快\n乙');
  });

  test('clearing or sending the answer lets the card fill it again', async () => {
    const onSend = vi.fn(() => true);
    await render(<MessageInput groupJid="web:g1" onSend={onSend} />);
    await fill('甲');
    expect(fills()).toEqual({ toolu_1: '甲' });
    await type('');
    expect(fills()).toEqual({});
    await fill('甲');
    expect(text()).toBe('甲');
    await keyDown('Enter');
    expect(onSend).toHaveBeenCalledWith('甲', undefined, undefined);
    expect(text()).toBe('');
    expect(fills()).toEqual({});
  });
});

describe('uploaded files', () => {
  test('the agent is told the workspace path the upload landed at', async () => {
    const onSend = vi.fn(() => true);
    useFileStore.setState({ currentPath: { 'web:g1': 'docs/specs' } });
    await render(<MessageInput groupJid="web:g1" onSend={onSend} />);
    await pickFiles([new File(['%PDF'], 'report.pdf')]);
    expect(uploadFiles).toHaveBeenCalledWith(
      'web:g1',
      [expect.objectContaining({ name: 'report.pdf' })],
      'docs/specs',
    );
    await type('请总结');
    await keyDown('Enter');
    expect(onSend).toHaveBeenCalledWith(
      '[我上传了以下文件到工作区，请查看并使用]\n- docs/specs/report.pdf\n\n请总结',
      undefined,
      undefined,
    );
  });
});

describe('recalling sent messages', () => {
  const sent = (content: string, sender = 'u1') => ({
    id: content,
    chat_jid: 'web:g1',
    sender,
    sender_name: 'U',
    content,
    timestamp: '2026-01-01T00:00:00.000Z',
    is_from_me: false,
  });

  beforeEach(() => {
    useAuthStore.setState({ user: { id: 'u1' } as never });
    useChatStore.setState({
      messages: {
        'web:g1': [
          sent('第一条'),
          sent('别人发的', 'someone-else'),
          { ...sent('助手回复'), is_from_me: true },
          sent('第二条'),
        ],
      },
    });
  });

  test('↑ in an empty composer walks back through what this user sent', async () => {
    await render(<MessageInput groupJid="web:g1" onSend={vi.fn()} />);
    await keyDown('ArrowUp');
    expect(text()).toBe('第二条');
    await keyDown('ArrowUp');
    expect(text()).toBe('第一条');
    // The oldest entry stays put.
    await keyDown('ArrowUp');
    expect(text()).toBe('第一条');
    await keyDown('ArrowDown');
    expect(text()).toBe('第二条');
    await keyDown('ArrowDown');
    expect(text()).toBe('');
  });

  test('↑ leaves a draft alone, and editing a recalled message keeps it', async () => {
    await render(<MessageInput groupJid="web:g1" onSend={vi.fn()} />);
    await type('草稿');
    await keyDown('ArrowUp');
    expect(text()).toBe('草稿');

    await type('');
    await keyDown('ArrowUp');
    await act(async () => {
      editor().commands.focus('end');
    });
    await typeAtCaret('，改一下');
    await keyDown('ArrowDown');
    expect(text()).toBe('第二条，改一下');
  });

  test('the arrows move the caret inside a recalled message, stepping only from its edge lines', async () => {
    useChatStore.setState({
      messages: { 'web:g1': [sent('第一条'), sent('上一行\n下一行')] },
    });
    await render(<MessageInput groupJid="web:g1" onSend={vi.fn()} />);
    await keyDown('ArrowUp');
    expect(text()).toBe('上一行\n下一行');
    // The caret is on the last line: ↑ moves it, it does not step.
    await keyDown('ArrowUp');
    expect(text()).toBe('上一行\n下一行');
    await act(async () => {
      editor().commands.setTextSelection(1);
    });
    await keyDown('ArrowUp');
    expect(text()).toBe('第一条');
  });

  test('a recalled message is not saved as a draft until it is edited', async () => {
    await render(<MessageInput key="a" groupJid="web:g1" onSend={vi.fn()} />);
    await keyDown('ArrowUp');
    expect(text()).toBe('第二条');
    await wait(350);
    expect(useChatStore.getState().drafts).toEqual({});
    expect([...storage.keys()]).toEqual([]);

    // Leaving and coming back offers recall again, not a stale draft.
    await render(<MessageInput key="b" groupJid="web:g1" onSend={vi.fn()} />);
    expect(text()).toBe('');

    await keyDown('ArrowUp');
    await act(async () => {
      editor().commands.focus('end');
    });
    await typeAtCaret('，改了');
    await wait(350);
    expect(useChatStore.getState().drafts).toEqual({
      'web:g1': '第二条，改了',
    });
  });

  test('a save still waiting when a recall starts does not store the recalled message', async () => {
    await render(<MessageInput groupJid="web:g1" onSend={vi.fn()} />);
    await typeAtCaret('草稿');
    await wait(350);
    expect(useChatStore.getState().drafts).toEqual({ 'web:g1': '草稿' });
    // Clearing schedules a save; ↑ recalls before it runs.
    await act(async () => {
      editor().commands.clearContent(true);
    });
    await keyDown('ArrowUp');
    expect(text()).toBe('第二条');
    await wait(350);
    expect(useChatStore.getState().drafts).toEqual({});
  });

  test('a session recalls only its own messages', async () => {
    useChatStore.setState({
      agentMessages: { a1: [sent('会话里发的')] },
    });
    await render(
      <MessageInput
        groupJid="web:g1"
        draftKey="web:g1#agent:a1"
        onSend={vi.fn()}
      />,
    );
    await keyDown('ArrowUp');
    expect(text()).toBe('会话里发的');
    await keyDown('ArrowUp');
    expect(text()).toBe('会话里发的');
  });
});

describe('palettes', () => {
  beforeEach(() => {
    useChatStore.setState({
      groups: { 'web:g1': { agent_profile_id: 'p1' } as never },
    });
    env.api = {
      '/api/skills': {
        skills: [
          {
            id: 'review',
            name: 'review',
            description: '审查代码改动',
            effective: true,
            enabled: true,
            userInvocable: true,
          },
          {
            id: 'internal',
            name: 'internal',
            description: '只给模型用',
            effective: true,
            enabled: true,
            userInvocable: false,
          },
        ],
      },
      '/api/agent-profiles/p1/effective-capabilities': {
        preview: {
          skills: {
            entries: [
              { id: 'review', available: true },
              { id: 'internal', available: true },
              { id: 'builtin-pdf', available: true },
            ],
          },
        },
      },
      '/api/groups/web%3Ag1/files?path=docs': {
        files: [{ name: 'guide.md', path: 'docs/guide.md', type: 'file' }],
      },
      '/api/groups/web%3Ag1/files': {
        files: [
          { name: '.git', path: '.git', type: 'directory' },
          { name: '.github', path: '.github', type: 'directory' },
          { name: '.env.example', path: '.env.example', type: 'file' },
          { name: 'notes.txt', path: 'notes.txt', type: 'file' },
          { name: 'docs', path: 'docs', type: 'directory' },
          {
            name: 'CLAUDE.md',
            path: 'CLAUDE.md',
            type: 'file',
            isSystem: true,
          },
        ],
      },
    };
  });

  test('/ lists commands and invocable skills and inserts the name', async () => {
    const onSend = vi.fn(() => true);
    await render(
      <MessageInput
        groupJid="web:g1"
        onSend={onSend}
        onResetSession={vi.fn()}
      />,
    );
    await typeAtCaret('/');
    await wait(0);
    expect(paletteRows()).toEqual([
      expect.stringContaining('/clear'),
      expect.stringContaining('/fresh'),
      expect.stringContaining('/builtin-pdf'),
      expect.stringContaining('/review审查代码改动'),
    ]);
    // The editor points at the list and its highlighted row.
    const listbox = container!.querySelector('[role="listbox"]')!;
    expect(editorEl().getAttribute('aria-controls')).toBe(listbox.id);
    expect(editorEl().getAttribute('aria-activedescendant')).toBe(
      listbox.querySelector('[aria-selected="true"]')!.id,
    );

    // Prefix matches rank before names that only contain the query.
    await typeAtCaret('re');
    expect(paletteRows()).toEqual([
      expect.stringContaining('/review'),
      expect.stringContaining('/fresh'),
    ]);
    await keyDown('Enter');
    expect(paletteRows()).toEqual([]);
    expect(text()).toBe('/review');
    expect(onSend).not.toHaveBeenCalled();
    expect(editorEl().querySelector('.slash-cmd-pill')?.textContent).toBe(
      '/review',
    );
  });

  test('/ hides the reset commands where the conversation cannot be reset', async () => {
    await render(<MessageInput groupJid="web:g1" onSend={vi.fn()} />);
    await typeAtCaret('/');
    await wait(0);
    expect(paletteRows().join()).not.toContain('/clear');
  });

  test('Esc closes the palette without stopping the run', async () => {
    const onStop = vi.fn(() => true);
    await render(
      <MessageInput
        groupJid="web:g1"
        onSend={vi.fn()}
        isRunning
        onStop={onStop}
      />,
    );
    await typeAtCaret('/');
    await wait(0);
    expect(paletteRows().length).toBeGreaterThan(0);
    await keyDown('Escape');
    expect(paletteRows()).toEqual([]);
    expect(onStop).not.toHaveBeenCalled();
  });

  test('@ browses the workspace and sends the chip as a quoted path', async () => {
    const onSend = vi.fn(() => true);
    await render(<MessageInput groupJid="web:g1" onSend={onSend} />);
    await typeAtCaret('看 @');
    await wait(0);
    // .git is never offered; hidden entries follow the visible ones.
    expect(paletteRows()).toEqual([
      'docs/',
      '.github/',
      'notes.txt',
      '.env.example',
    ]);

    // Tab enters a directory.
    await keyDown('Tab');
    await wait(0);
    expect(text()).toBe('看 @docs/');
    expect(paletteRows()).toEqual(['guide.mddocs/guide.md']);
    await keyDown('Enter');
    expect(editorEl().querySelector('[data-mention-chip]')?.textContent).toBe(
      'guide.md',
    );
    await typeAtCaret('总结');
    await keyDown('Enter');
    expect(onSend).toHaveBeenCalledWith(
      '看 @"docs/guide.md" 总结',
      undefined,
      undefined,
    );
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

    env.keyboardHeight = 300;
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

  test('an edit of an item the dispatcher claimed moves into the composer', async () => {
    const view = (items: QueuedFollowUp[], key = 'a') => (
      <MessageInput
        key={key}
        groupJid="web:g1"
        onSend={vi.fn()}
        isRunning
        queuedFollowUps={items}
        onFollowUpAction={vi.fn(() => true)}
      />
    );
    await render(view(queue));
    await type('我的草稿');
    await act(async () => {
      (
        panel().querySelector(
          'button[aria-label="编辑：排队 2"]',
        ) as HTMLElement
      ).click();
    });
    const field = panel().querySelector(
      'textarea[aria-label="编辑排队消息"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!.call(field, '排队 2（改过）');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await render(view(queue.filter((item) => item.id !== 'q2')));
    expect(text()).toBe('我的草稿\n\n排队 2（改过）');
    expect(container!.textContent).toContain(
      '这条消息已开始处理，未保存的修改已移到输入框',
    );

    // It is the conversation's draft now: it survives a remount.
    await wait(350);
    expect(useChatStore.getState().drafts).toEqual({
      'web:g1': '我的草稿\n\n排队 2（改过）',
    });
    await render(view([], 'b'));
    expect(text()).toBe('我的草稿\n\n排队 2（改过）');
  });

  test('the queue sits inside the composer card, above the editor', async () => {
    await render(
      <MessageInput
        groupJid="web:g1"
        onSend={vi.fn()}
        isRunning
        queuedFollowUps={queue}
        onFollowUpAction={vi.fn(() => true)}
      />,
    );
    const card = container!.querySelector('[data-composer-card]')!;
    expect(card.contains(panel())).toBe(true);
    expect(
      panel().compareDocumentPosition(editorEl()) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
