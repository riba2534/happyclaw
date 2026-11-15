// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { click, flush, makeProvider, text } from './test-helpers';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  confirm: vi.fn(),
  setNotice: vi.fn(),
  setError: vi.fn(),
  detail: vi.fn(),
  usage: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    put: mocks.put,
    delete: mocks.del,
  },
}));
vi.mock('../../stores/confirm', () => ({ confirmDialog: mocks.confirm }));
// The wizard and the detail have their own tests.
vi.mock('./AddModelWizard', () => ({ AddModelWizardDialog: () => null }));
vi.mock('./ConnectionDetailDialog', () => ({
  ConnectionDetailDialog: (props: { provider: { id: string } | null }) => {
    mocks.detail(props.provider?.id ?? null);
    return null;
  },
}));
// Subscription usage reads its own endpoint.
vi.mock('./UsageBars', () => ({
  UsageBars: (props: { providerId: string }) => {
    mocks.usage(props.providerId);
    return null;
  },
}));

const { ClaudeProviderSection } = await import('./ClaudeProviderSection');

const PROVIDERS = '/api/config/claude/providers';

let root: Root;
let container: HTMLDivElement;
let profiles: Array<Record<string, unknown>> = [];

const relay = makeProvider({
  id: 'relay',
  name: '中转站',
  anthropicBaseUrl: 'https://relay.example.test',
  models: [{ id: 'relay-a' }, { id: 'relay-b' }, { id: 'relay-c' }],
  anthropicModel: 'relay-a',
});

beforeEach(() => {
  vi.clearAllMocks();
  profiles = [];
  mocks.get.mockImplementation(async (path: string) => {
    if (path === PROVIDERS) return { providers: [relay] };
    if (path === '/api/agent-profiles') return { profiles, model_configs: [] };
    throw new Error(`unexpected GET ${path}`);
  });
  mocks.confirm.mockResolvedValue(true);
  mocks.del.mockResolvedValue({ success: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function render() {
  await act(async () => {
    root.render(
      <ClaudeProviderSection
        setNotice={mocks.setNotice}
        setError={mocks.setError}
      />,
    );
  });
  await flush();
}

async function openMenu() {
  const trigger = document.querySelector('button[aria-label="更多操作"]');
  if (!trigger) throw new Error('menu trigger not found');
  await act(async () => {
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  });
}

function menuItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

describe('模型连接 list', () => {
  test('a row is name, address, model count and 编辑; nothing manages a pool', async () => {
    await render();
    expect(text()).toContain('中转站');
    expect(text()).toContain('https://relay.example.test');
    expect(text()).toContain('3 个模型');
    expect(document.querySelector('[role="switch"]')).toBeNull();
    expect(text()).not.toContain('默认');
    expect(text()).not.toContain('负载均衡');
    expect(text()).not.toContain('健康');
    // Only the list is read: no health polling, no balancing.
    expect(mocks.get.mock.calls.map(([path]) => path)).toEqual([PROVIDERS]);

    const edit = [...document.querySelectorAll('button')].find(
      (node) => node.textContent?.trim() === '编辑',
    );
    await click(edit);
    expect(mocks.detail).toHaveBeenLastCalledWith('relay');
  });

  test('the row menu offers 测试连接 and 删除 only', async () => {
    await render();
    await openMenu();
    expect(menuItems().map((item) => item.textContent?.trim())).toEqual([
      '测试连接',
      '删除',
    ]);
  });

  test('删除 asks with confirmDialog, then deletes', async () => {
    await render();
    await openMenu();
    await click(menuItems().find((item) => item.textContent?.includes('删除')));
    await flush();
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'danger', title: '删除模型连接' }),
    );
    expect(mocks.del).toHaveBeenCalledWith(`${PROVIDERS}/relay`);
    expect(mocks.setNotice).toHaveBeenCalledWith('已删除模型连接「中转站」');
  });

  test('a connection Agents are bound to names them instead of deleting', async () => {
    profiles = [
      {
        id: 'a',
        name: '写作助手',
        is_default: false,
        model_config_id: 'relay',
      },
      {
        id: 'b',
        name: 'Default Agent',
        is_default: true,
        model_config_id: 'relay',
      },
      { id: 'c', name: '别的', is_default: false, model_config_id: 'other' },
    ];
    await render();
    await openMenu();
    await click(menuItems().find((item) => item.textContent?.includes('删除')));
    await flush();
    expect(mocks.setError).toHaveBeenCalledWith(
      expect.stringContaining(
        '智能体「写作助手」「HappyClaw」绑定了「中转站」',
      ),
    );
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
  });

  test('a magpie connection shows its accounts’ usage; another relay does not', async () => {
    const magpie = makeProvider({
      id: 'mp',
      name: 'Magpie',
      presetId: 'magpie',
      anthropicBaseUrl: 'http://127.0.0.1:3425',
      gateway: 'magpie',
    });
    mocks.get.mockImplementation(async (path: string) => {
      if (path === PROVIDERS) return { providers: [relay, magpie] };
      throw new Error(`unexpected GET ${path}`);
    });
    await render();
    expect(mocks.usage).toHaveBeenCalledWith('mp');
    expect(mocks.usage).not.toHaveBeenCalledWith('relay');
  });

  test('declining the confirmation deletes nothing', async () => {
    mocks.confirm.mockResolvedValue(false);
    await render();
    await openMenu();
    await click(menuItems().find((item) => item.textContent?.includes('删除')));
    await flush();
    expect(mocks.del).not.toHaveBeenCalled();
  });
});
