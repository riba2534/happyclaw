// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mockDrafts: Record<string, string> = {};
const mockSaveDraft = vi.fn((key: string, text: string) => {
  if (text) {
    mockDrafts[key] = text;
  } else {
    delete mockDrafts[key];
  }
});
const mockClearDraft = vi.fn((key: string) => {
  delete mockDrafts[key];
});

vi.mock('../web/src/stores/chat', () => {
  return {
    useChatStore: Object.assign(
      (selector: (value: any) => unknown) =>
        selector({
          drafts: mockDrafts,
          saveDraft: mockSaveDraft,
          clearDraft: mockClearDraft,
        }),
      {
        getState: () => ({
          drafts: mockDrafts,
          saveDraft: mockSaveDraft,
          clearDraft: mockClearDraft,
        }),
      },
    ),
  };
});

vi.mock('../web/src/stores/files', () => ({
  useFileStore: (selector: (value: any) => unknown) =>
    selector({
      uploadFiles: vi.fn(async () => true),
      cancelUpload: vi.fn(),
      uploading: false,
      uploadProgress: null,
    }),
  formatUploadRetryStatus: () => '',
}));

vi.mock('../web/src/hooks/useDisplayMode', () => ({
  useDisplayMode: () => ({ mode: 'default' }),
}));

vi.mock('../web/src/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

vi.mock('@/hooks/useKeyboardHeight', () => ({
  useKeyboardHeight: () => 0,
}));

vi.mock('../web/src/hooks/useHaptic', () => ({
  successTap: () => {},
}));

vi.mock('../web/src/lib/follow-up-preferences', () => ({
  FOLLOW_UP_MODE_KEY: 'test-follow-up-mode',
  FOLLOW_UP_MODE_CHANGED_EVENT: 'test-follow-up-mode-changed',
  getDefaultFollowUpMode: () => 'queue',
  alternateFollowUpMode: (mode: 'queue' | 'steer') =>
    mode === 'queue' ? 'steer' : 'queue',
}));

import { MessageInput } from '../web/src/components/chat/MessageInput';
import { getDraftStorageKey } from '../web/src/lib/draft-storage';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const createdUrls: string[] = [];
const revokedUrls: string[] = [];

function typeInTextarea(textarea: HTMLTextAreaElement, text: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  valueSetter?.call(textarea, text);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  for (const key of Object.keys(mockDrafts)) {
    delete mockDrafts[key];
  }
  mockSaveDraft.mockClear();
  mockClearDraft.mockClear();
  createdUrls.length = 0;
  revokedUrls.length = 0;

  globalThis.URL.createObjectURL = vi.fn((file: any) => {
    const url = `blob:test-url-${createdUrls.length + 1}`;
    createdUrls.push(url);
    return url;
  });
  globalThis.URL.revokeObjectURL = vi.fn((url: string) => {
    revokedUrls.push(url);
  });

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

describe('R04: Session draft and attachment isolation', () => {
  test('generates explicit draft keys separating Workspace and Session', () => {
    expect(getDraftStorageKey('web:ws1', 'main')).toBe('web:ws1::main');
    expect(getDraftStorageKey('web:ws1', null)).toBe('web:ws1::main');
    expect(getDraftStorageKey('web:ws1', undefined)).toBe('web:ws1::main');
    expect(getDraftStorageKey('web:ws1', 'agent-alpha')).toBe(
      'web:ws1::agent-alpha',
    );
    expect(getDraftStorageKey('web:ws1', 'agent-beta')).toBe(
      'web:ws1::agent-beta',
    );
  });

  test('preserves and restores drafts when switching between Main, Session A, and Session B', async () => {
    const onSend = vi.fn();

    // 1. Mount with Main session
    await act(async () => {
      root?.render(
        <MessageInput groupJid="web:ws1" sessionId="main" onSend={onSend} />,
      );
    });

    const textarea = () =>
      container?.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea()).toBeTruthy();
    expect(textarea().value).toBe('');

    // User types draft in Main
    await act(async () => {
      typeInTextarea(textarea(), 'Draft for Main Session');
    });

    // 2. Switch to Session A: Main draft should be saved, Session A should be empty
    await act(async () => {
      root?.render(
        <MessageInput groupJid="web:ws1" sessionId="agent-a" onSend={onSend} />,
      );
    });

    expect(mockDrafts['web:ws1::main']).toBe('Draft for Main Session');
    expect(textarea().value).toBe('');

    // User types draft in Session A
    await act(async () => {
      typeInTextarea(textarea(), 'Draft for Session A');
    });

    // 3. Switch to Session B: Session A draft should be saved, Session B empty
    await act(async () => {
      root?.render(
        <MessageInput groupJid="web:ws1" sessionId="agent-b" onSend={onSend} />,
      );
    });

    expect(mockDrafts['web:ws1::agent-a']).toBe('Draft for Session A');
    expect(textarea().value).toBe('');

    // 4. Switch back to Main: Main draft restored!
    await act(async () => {
      root?.render(
        <MessageInput groupJid="web:ws1" sessionId="main" onSend={onSend} />,
      );
    });
    expect(textarea().value).toBe('Draft for Main Session');

    // 5. Switch back to Session A: Session A draft restored!
    await act(async () => {
      root?.render(
        <MessageInput groupJid="web:ws1" sessionId="agent-a" onSend={onSend} />,
      );
    });
    expect(textarea().value).toBe('Draft for Session A');
  });

  test('switching session drops pending attachments and revokes preview URLs', async () => {
    let resolveSend: ((ok: boolean) => void) | null = null;
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        }),
    );

    await act(async () => {
      root?.render(
        <MessageInput groupJid="web:ws1" sessionId="agent-a" onSend={onSend} />,
      );
    });

    // Simulate adding an image in Session A
    const fileInput = container?.querySelector(
      'input[type="file"][accept="image/*"]',
    ) as HTMLInputElement;
    const imageFile = new File(['dummy-bytes'], 'chart.png', {
      type: 'image/png',
    });

    await act(async () => {
      Object.defineProperty(fileInput, 'files', {
        value: [imageFile],
        configurable: true,
      });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Wait for FileReader
    await new Promise((r) => setTimeout(r, 20));

    // Preview should exist in Session A
    expect(container?.querySelector('img')).toBeTruthy();
    expect(createdUrls.length).toBeGreaterThan(0);

    // Switch to Session B: pending image must be cleared and URL revoked
    await act(async () => {
      root?.render(
        <MessageInput groupJid="web:ws1" sessionId="agent-b" onSend={onSend} />,
      );
    });

    expect(container?.querySelector('img')).toBeFalsy();
    expect(revokedUrls.length).toBeGreaterThan(0);
  });

  test('async onSend completion does not clear draft or text if user has switched to another session', async () => {
    let resolveSend: (ok: boolean) => void = () => {};
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        }),
    );

    // 1. User is in Session A, types message and clicks send
    await act(async () => {
      root?.render(
        <MessageInput groupJid="web:ws1" sessionId="agent-a" onSend={onSend} />,
      );
    });

    const textarea = () =>
      container?.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      typeInTextarea(textarea(), 'Message to send in A');
    });

    const sendBtn = () =>
      container?.querySelector('button[title="发送消息"]') as HTMLButtonElement;
    await act(async () => {
      sendBtn().click();
    });
    expect(onSend).toHaveBeenCalledTimes(1);

    // 2. While send is in-flight, user switches to Session B and types a new draft
    await act(async () => {
      root?.render(
        <MessageInput groupJid="web:ws1" sessionId="agent-b" onSend={onSend} />,
      );
    });

    await act(async () => {
      typeInTextarea(textarea(), 'Important work in Session B');
    });

    // 3. Now the send from Session A finishes successfully
    await act(async () => {
      resolveSend(true);
    });

    // Session B's content must NOT be cleared!
    expect(textarea().value).toBe('Important work in Session B');
    // Session A's draft in store should be cleared
    expect(mockDrafts['web:ws1::agent-a']).toBeUndefined();
  });

  test('clearly displays error for images exceeding 5MB and keeps valid images', async () => {
    const onSend = vi.fn();
    await act(async () => {
      root?.render(
        <MessageInput groupJid="web:ws1" sessionId="main" onSend={onSend} />,
      );
    });

    const fileInput = container?.querySelector(
      'input[type="file"][accept="image/*"]',
    ) as HTMLInputElement;

    // Create 1 oversized image (6MB) and 1 valid image (1KB)
    const bigFile = new File(['a'.repeat(100)], 'huge-photo.png', {
      type: 'image/png',
    });
    Object.defineProperty(bigFile, 'size', { value: 6 * 1024 * 1024 });

    const normalFile = new File(['b'.repeat(100)], 'normal.png', {
      type: 'image/png',
    });
    Object.defineProperty(normalFile, 'size', { value: 1024 });

    await act(async () => {
      Object.defineProperty(fileInput, 'files', {
        value: [bigFile, normalFile],
        configurable: true,
      });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Wait for FileReader
    await new Promise((r) => setTimeout(r, 30));

    // Error banner must be visible and accessible
    const errorBanner = container?.querySelector('[role="alert"]');
    expect(errorBanner).toBeTruthy();
    expect(errorBanner?.textContent).toContain('huge-photo.png');
    expect(errorBanner?.textContent).toContain('超过 5MB 限制');

    // The normal image must still be added to pending images!
    const images = container?.querySelectorAll('img');
    expect(images?.length).toBe(1);
  });

  test('accessible interaction: textarea has aria-label matching context and buttons have aria-label', async () => {
    const onSend = vi.fn();
    await act(async () => {
      root?.render(
        <MessageInput
          groupJid="web:ws1"
          sessionId="agent-custom"
          contextLabel="Agent Alpha"
          onSend={onSend}
        />,
      );
    });

    const textarea = container?.querySelector('textarea');
    expect(textarea?.getAttribute('aria-label')).toBe(
      '输入给 Agent Alpha 的消息',
    );

    const sendBtn = container?.querySelector('button[title="发送消息"]');
    expect(sendBtn?.getAttribute('aria-label')).toBe('发送消息');
  });
});
