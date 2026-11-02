// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { toBase64Url, useFileStore, type FileEntry } from '../../stores/files';
import { OfficePreview } from './FilePanel';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
// Only the iframe's src matters here; never let it fetch the page.
(
  window as unknown as {
    happyDOM: {
      settings: { navigation: { disableChildFrameNavigation: boolean } };
    };
  }
).happyDOM.settings.navigation.disableChildFrameNavigation = true;

const JID = 'web:a';
const FILE: FileEntry = {
  name: 'plan.docx',
  path: 'docs/plan.docx',
  type: 'file',
  size: 10,
  modifiedAt: '2026-11-02T00:00:00.000Z',
  isSystem: false,
};
const PREVIEW_URL = `/api/groups/web%3Aa/files/office-preview/${toBase64Url(FILE.path)}?agentId=wt-1`;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const fetchMock = vi.fn();

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // The panel shows a worktree session's files.
  useFileStore.setState({ fileScope: { [JID]: 'wt-1' } });
  fetchMock.mockReset();
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

async function renderPreview(): Promise<void> {
  await act(async () => {
    root!.render(
      <OfficePreview
        groupJid={JID}
        file={FILE}
        onClose={() => {}}
        onDownload={() => {}}
      />,
    );
  });
}

describe('OfficePreview', () => {
  test('preflights with HEAD in the session scope, then loads the server URL itself', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await renderPreview();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(PREVIEW_URL);
    expect(init.method).toBe('HEAD');

    // Not a blob: URL, so the response's CSP sandbox still applies.
    const iframe = document.body.querySelector('iframe');
    expect(iframe?.getAttribute('src')).toBe(PREVIEW_URL);
  });

  test('a busy converter is reported without loading the viewer', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await renderPreview();

    expect(document.body.querySelector('iframe')).toBeNull();
    expect(document.body.textContent).toContain(
      '正在转换的文件较多，请稍后再试',
    );
    expect(document.body.textContent).toContain('下载原文件');
  });
});
