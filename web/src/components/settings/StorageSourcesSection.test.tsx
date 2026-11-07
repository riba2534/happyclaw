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
  origin: 'web',
  usedBy: 2,
  readWriteUsedBy: 0,
};
const nfsRw = {
  id: 'nas-nfs',
  type: 'nfs',
  server: 'nas.lan',
  exportPath: '/volume1/shared',
  nfsVersion: '3',
  allowReadWrite: true,
  hasPassword: false,
  origin: 'web',
  usedBy: 2,
  readWriteUsedBy: 1,
};

function listing(sources: unknown[]) {
  return {
    sources,
    allowlistPath: 'config/mount-allowlist.json',
    managedPath: 'data/config/storage-sources.json',
    nonMainReadOnly: false,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(listing([smb]));
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
async function menuAction(label: string, id = 'nas-smb') {
  const trigger = document.querySelector<HTMLElement>(
    `button[aria-label="${id} 的操作"]`,
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

  test('asks before revoking read-write from workspaces that mount it read-write', async () => {
    mocks.get.mockResolvedValue(listing([nfsRw]));
    await render();
    mocks.confirm.mockResolvedValueOnce(false);
    await menuAction('编辑', 'nas-nfs');
    expect(document.body.textContent).toContain(
      '已经以读写方式挂载它的工作区将无法启动',
    );
    await click(document.querySelector('#storage-source-rw'));
    await click(button('保存'));
    await flush();
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.confirm.mock.calls[0][0].message).toContain(
      '1 个工作区以读写方式挂载了 nas-nfs',
    );
    expect(mocks.confirm.mock.calls[0][0].message).toContain('无法启动');
    expect(mocks.put).not.toHaveBeenCalled();

    await click(button('保存'));
    await flush();
    expect(mocks.put).toHaveBeenCalledWith(`${BASE}/nas-nfs`, {
      type: 'nfs',
      server: 'nas.lan',
      exportPath: '/volume1/shared',
      nfsVersion: '3',
      allowReadWrite: false,
      force: true,
    });
  });

  test('revoking read-write nobody uses needs no confirmation', async () => {
    mocks.get.mockResolvedValue(listing([{ ...nfsRw, readWriteUsedBy: 0 }]));
    await render();
    await menuAction('编辑', 'nas-nfs');
    await click(document.querySelector('#storage-source-rw'));
    await click(button('保存'));
    await flush();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.put.mock.calls[0][1]).not.toHaveProperty('force');
  });

  test('confirms and retries when the server finds read-write users the list missed', async () => {
    mocks.get.mockResolvedValue(listing([{ ...nfsRw, readWriteUsedBy: 0 }]));
    mocks.put.mockRejectedValueOnce({
      status: 409,
      message: 'in use',
      body: { code: 'STORAGE_SOURCE_READ_WRITE_IN_USE', readWriteUsedBy: 3 },
    });
    await render();
    await menuAction('编辑', 'nas-nfs');
    await click(document.querySelector('#storage-source-rw'));
    await click(button('保存'));
    await flush();
    expect(mocks.confirm.mock.calls[0][0].message).toContain('3 个工作区');
    expect(mocks.put).toHaveBeenCalledTimes(2);
    expect(mocks.put.mock.calls[1][1]).toMatchObject({ force: true });
  });

  test('clearing the username drops the password typed for it', async () => {
    await render();
    await click(button('添加存储源'));
    await click(button('SMB'));
    await type('#storage-source-id', 'guest');
    await type('#storage-source-server', 'nas.lan');
    await type('#storage-source-share', 'public');
    await type('#storage-source-username', 'agent');
    await type('#storage-source-password', 'pw');
    await type('#storage-source-username', '');
    expect(document.querySelector('#storage-source-password')).toBeNull();
    await click(button('添加'));
    await flush();
    expect(document.body.textContent).not.toContain('设置密码时必须填写用户名');
    expect(mocks.post).toHaveBeenCalledWith(`${BASE}/guest`, {
      type: 'cifs',
      server: 'nas.lan',
      share: 'public',
      smbVersion: '3.0',
      allowReadWrite: false,
    });
  });

  test('sources from the allowlist file are read-only', async () => {
    mocks.get.mockResolvedValue(listing([{ ...smb, origin: 'allowlist' }]));
    await render();
    expect(document.body.textContent).toContain('配置文件');
    expect(
      document.querySelector('button[aria-label="nas-smb 的操作"]'),
    ).toBeNull();
  });
});
