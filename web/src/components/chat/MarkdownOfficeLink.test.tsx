// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { toBase64Url, useFileStore } from '../../stores/files';
import { MarkdownRenderer } from './MarkdownRenderer';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
(
  window as unknown as {
    happyDOM: {
      settings: { navigation: { disableChildFrameNavigation: boolean } };
    };
  }
).happyDOM.settings.navigation.disableChildFrameNavigation = true;

const downloadFromUrlMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const isPhoneState = vi.hoisted(() => ({ value: false }));

vi.mock('../../utils/download', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    downloadFromUrl: downloadFromUrlMock,
  };
});

vi.mock('../layout/phone', () => ({
  useIsPhone: () => isPhoneState.value,
}));

const JID = 'web:test-ws#agent:session-1';
const BASE_JID = 'web:test-ws';
const FILE_PATH = 'outputs/测试表格.xlsx';
const ENCODED_PATH = toBase64Url(FILE_PATH);
const OFFICE_PREVIEW_URL = `/api/groups/${encodeURIComponent(BASE_JID)}/files/office-preview/${ENCODED_PATH}`;
const DOWNLOAD_URL = `/api/groups/${encodeURIComponent(BASE_JID)}/files/download/${ENCODED_PATH}`;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const fetchMock = vi.fn();

beforeEach(() => {
  isPhoneState.value = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useFileStore.setState({ fileScope: {} });
  fetchMock.mockReset();
  downloadFromUrlMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  document.body
    .querySelectorAll('[data-slot="dialog-overlay"], [role="dialog"]')
    .forEach((node) => node.remove());
  root = null;
  container = null;
  useFileStore.setState({ fileScope: {} });
  vi.unstubAllGlobals();
});

async function renderMarkdown(content: string): Promise<void> {
  await act(async () => {
    root!.render(<MarkdownRenderer content={content} groupJid={JID} />);
  });
}

describe('MarkdownLink Office file handling', () => {
  test('desktop click opens OfficePreview with PDF iframe and original-file download', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await renderMarkdown(`[下载表格](${FILE_PATH})`);

    const link = container!.querySelector('a')!;
    expect(link).toBeTruthy();
    // Direct href uses /download/ so right-click/middle-click downloads the original file.
    expect(link.getAttribute('href')).toBe(DOWNLOAD_URL);
    expect(link.getAttribute('target')).toBeNull();

    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(OFFICE_PREVIEW_URL);
    expect(fetchMock.mock.calls[0][1].method).toBe('HEAD');

    const iframe = document.body.querySelector('iframe');
    expect(iframe?.getAttribute('src')).toBe(OFFICE_PREVIEW_URL);

    // Download button is also available while previewing the converted PDF.
    const downloadBtn = document.body.querySelector(
      'button[aria-label="下载原文件"]',
    ) as HTMLButtonElement | null;
    expect(downloadBtn).toBeTruthy();
    await act(async () => {
      downloadBtn!.click();
    });
    expect(downloadFromUrlMock).toHaveBeenCalledWith(
      new URL(DOWNLOAD_URL, window.location.href).href,
      '测试表格.xlsx',
    );
  });

  test('shows fallback download action when office converter is not configured (501)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 501 });
    await renderMarkdown(`[需求表](${FILE_PATH})`);

    const link = container!.querySelector('a')!;
    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(document.body.querySelector('iframe')).toBeNull();
    expect(document.body.textContent).toContain('未配置 Office 预览转换器');

    const buttons = Array.from(document.body.querySelectorAll('button'));
    const fallbackDownload = buttons.find((b) =>
      b.textContent?.includes('下载原文件'),
    );
    expect(fallbackDownload).toBeTruthy();
    await act(async () => {
      fallbackDownload!.click();
    });
    expect(downloadFromUrlMock).toHaveBeenCalledWith(
      new URL(DOWNLOAD_URL, window.location.href).href,
      '测试表格.xlsx',
    );
  });

  test('phone click on Office file also uses OfficePreview instead of raw /files/preview iframe', async () => {
    isPhoneState.value = true;
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await renderMarkdown(`[手机打开](${FILE_PATH})`);

    const link = container!.querySelector('a')!;
    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    const iframe = document.body.querySelector('iframe');
    expect(iframe?.getAttribute('src')).toBe(OFFICE_PREVIEW_URL);
  });

  test('external Office URLs are left untouched with target=_blank', async () => {
    await renderMarkdown('[外部文档](https://example.com/report.xlsx)');
    const link = container!.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://example.com/report.xlsx');
    expect(link.getAttribute('target')).toBe('_blank');
  });
});
