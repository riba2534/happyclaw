// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { button, click, flush, type } from './test-helpers';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    put: mocks.put,
    delete: mocks.delete,
  },
}));
vi.mock('../../stores/confirm', () => ({ confirmDialog: mocks.confirm }));

const { StorageSourcesSection } = await import('./StorageSourcesSection');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = '/api/config/storage-sources';
const smb = {
  id: 'nas-smb',
  type: 'cifs',
  server: 'nas.lan',
  share: 'team',
  username: 'agent',
  smbVersion: '3.0',
  allowReadWrite: false,
  hasPassword: true,
  usedBy: 2,
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({
    sources: [smb],
    allowlistPath: 'config/mount-allowlist.json',
    nonMainReadOnly: false,
  });
  mocks.post.mockResolvedValue({ source: {} });
  mocks.put.mockResolvedValue({ source: {} });
  mocks.delete.mockResolvedValue({ success: true });
  mocks.confirm.mockResolvedValue(true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function render() {
  await act(async () => {
    root.render(<StorageSourcesSection />);
  });
  await flush();
}

/** Opens the row menu (Radix opens on pointerdown) and picks an item. */
async function menuAction(label: string) {
  const trigger = document.querySelector<HTMLElement>(
    'button[aria-label="nas-smb 的操作"]',
  );
  if (!trigger) throw new Error('menu trigger not found');
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerType: 'mouse',
        button: 0,
      }),
    );
  });
  await click(
    [...document.querySelectorAll('[role="menuitem"]')].find(
      (element) => element.textContent?.trim() === label,
    ),
  );
}

describe('StorageSourcesSection', () => {
  test('lists sources without ever showing a password', async () => {
    await render();
    expect(mocks.get).toHaveBeenCalledWith(BASE);
    const text = document.body.textContent ?? '';
    expect(text).toContain('smb://nas.lan/team');
    expect(text).toContain('2 个工作区在用');
  });

  test('creates an NFS source', async () => {
    await render();
    await click(button('添加存储源'));
    await type('#storage-source-id', 'nas-nfs');
    await type('#storage-source-server', 'nas.lan');
    await type('#storage-source-export', '/volume1/shared');
    await click(button('添加'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(`${BASE}/nas-nfs`, {
      type: 'nfs',
      server: 'nas.lan',
      exportPath: '/volume1/shared',
      nfsVersion: '3',
      allowReadWrite: false,
    });
  });

  test('rejects a bad id before sending', async () => {
    await render();
    await click(button('添加存储源'));
    await type('#storage-source-id', 'Bad Id');
    await type('#storage-source-server', 'nas.lan');
    await type('#storage-source-export', '/x');
    await click(button('添加'));
    expect(mocks.post).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('标识只能用');
  });

  test('editing an SMB source keeps the stored password unless replaced', async () => {
    await render();
    await menuAction('编辑');
    await click(button('保存'));
    await flush();
    const [, body] = mocks.put.mock.calls[0];
    expect(mocks.put.mock.calls[0][0]).toBe(`${BASE}/nas-smb`);
    expect(body).not.toHaveProperty('password');

    await menuAction('编辑');
    await click(button('更换密码'));
    await type('#storage-source-password', 'new-pw');
    await click(button('保存'));
    await flush();
    expect(mocks.put.mock.calls[1][1]).toMatchObject({ password: 'new-pw' });
  });

  test('warns before deleting a source in use', async () => {
    await render();
    await menuAction('删除');
    await flush();
    expect(mocks.confirm.mock.calls[0][0].message).toContain('2 个工作区');
    expect(mocks.delete).toHaveBeenCalledWith(`${BASE}/nas-smb`);
  });
});
