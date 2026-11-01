// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Automation } from '../web/src/lib/automation';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    delete: vi.fn(),
  },
  apiFetch: vi.fn(),
}));

vi.mock('../web/src/hooks/useMediaQuery', () => ({
  useMediaQuery: (query: string) => query.includes('min-width: 1024px'),
}));

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

const { AutomationFormDialog } =
  await import('../web/src/components/automations/AutomationFormDialog');
const { TooltipProvider } = await import('../web/src/components/ui/tooltip');
const { useAutomationsStore } = await import('../web/src/stores/automations');
const { useChatStore } = await import('../web/src/stores/chat');
const { useAuthStore } = await import('../web/src/stores/auth');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    workspaceJid: 'web:home',
    workspaceFolder: 'home',
    createdBy: 'u1',
    name: '日报',
    prompt: '写日报',
    stopWhen: null,
    schedule: { kind: 'cron', cronExpr: '0 9 * * *', timezone: 'UTC' },
    endAt: null,
    sessionMode: 'fresh',
    targetSessionJid: null,
    deliveryRouteJid: null,
    silentWhenIdle: true,
    preRunCheck: null,
    execution: 'agent',
    scriptCommand: null,
    status: 'active',
    statusReason: null,
    nextFireAt: null,
    lastFiredAt: null,
    lastFinishedAt: null,
    revision: 3,
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement;
const onClose = vi.fn();

async function render(props: {
  automation?: Automation;
  prefill?: { workspaceJid?: string; targetSessionJid?: string | null };
}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <MemoryRouter>
        <TooltipProvider>
          <AutomationFormDialog open onClose={onClose} {...props} />
        </TooltipProvider>
      </MemoryRouter>,
    ),
  );
}

const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;
const text = () => dialog().textContent ?? '';
const byLabel = <T extends HTMLElement>(label: string) => {
  const direct = dialog().querySelector<T>(`[aria-label="${label}"]`);
  if (direct) return direct;
  const labelEl = [...dialog().querySelectorAll('label')].find(
    (item) => item.textContent?.trim() === label,
  );
  return labelEl?.htmlFor
    ? (document.getElementById(labelEl.htmlFor) as T)
    : (null as unknown as T);
};
const button = (name: string) =>
  [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === name,
  )!;
const segment = (group: string, name: string) =>
  [
    ...dialog().querySelectorAll<HTMLButtonElement>(
      `[role="group"][aria-label="${group}"] button`,
    ),
  ].find((item) => item.textContent?.trim() === name)!;

async function type(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? 'change' : 'input', {
        bubbles: true,
      }),
    );
  });
}

async function submit() {
  await act(async () => button(button('创建') ? '创建' : '保存').click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function fillBasics() {
  await type(byLabel<HTMLInputElement>('标题'), '周报');
  await type(byLabel<HTMLTextAreaElement>('提示词'), '总结本周进展');
}

beforeEach(() => {
  for (const fn of [mocks.get, mocks.post, mocks.patch]) fn.mockReset();
  onClose.mockReset();
  mocks.post.mockImplementation(async (_path: string, body: object) => ({
    automation: automation({ id: 'new', ...(body as Partial<Automation>) }),
  }));
  useAutomationsStore.setState({
    automations: [],
    runs: {},
    formRequest: null,
  });
  useChatStore.setState({
    groups: {
      'web:home': {
        name: '主工作区',
        folder: 'home',
        added_at: '2026-01-01T00:00:00Z',
        interaction_mode: 'assistant',
        is_my_home: true,
        can_modify: true,
        execution_mode: 'container',
      },
      'web:ops': {
        name: '运维',
        folder: 'ops',
        added_at: '2026-01-01T00:00:00Z',
        interaction_mode: 'assistant',
        can_modify: true,
        execution_mode: 'host',
      },
    },
    agents: {
      'web:home': [
        {
          id: 's0',
          name: '日常对话',
          prompt: '',
          status: 'idle',
          kind: 'conversation',
          created_at: '2026-09-01T00:00:00Z',
        },
        {
          id: 's1',
          name: '周报会话',
          prompt: '',
          status: 'idle',
          kind: 'conversation',
          created_at: '2026-10-01T00:00:00Z',
        },
        {
          id: 's2',
          name: '置顶会话',
          prompt: '',
          status: 'idle',
          kind: 'conversation',
          created_at: '2026-08-01T00:00:00Z',
          pinned_at: '2026-10-02T00:00:00Z',
        },
      ],
    },
    loadAgents: vi.fn(async () => undefined),
  } as never);
  useAuthStore.setState({
    user: { id: 'u1', username: 'owner', role: 'member' },
  } as never);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = '';
});

const posted = () => mocks.post.mock.calls[0]?.[1] as Record<string, unknown>;

describe('automation form', () => {
  test('shows validation errors inline and does not submit', async () => {
    await render({});
    expect(text()).not.toContain('请填写名称');
    await submit();
    expect(text()).toContain('请填写名称');
    expect(text()).toContain('请填写提示词');
    expect(mocks.post).not.toHaveBeenCalled();
    // Each message sits under its own field.
    const titleField = byLabel('标题').closest('div')!;
    expect(titleField.textContent).toContain('请填写名称');

    await fillBasics();
    expect(text()).not.toContain('请填写名称');
    await submit();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(posted()).toMatchObject({
      name: '周报',
      prompt: '总结本周进展',
      workspaceJid: 'web:home',
      sessionMode: 'fresh',
      targetSessionJid: null,
      silentWhenIdle: true,
      execution: 'agent',
      schedule: { kind: 'cron', cronExpr: '0 9 * * *' },
    });
    expect(onClose).toHaveBeenCalled();
  });

  test('weekly preset generates its cron with the browser zone', async () => {
    await render({});
    await fillBasics();
    await type(byLabel<HTMLSelectElement>('频率'), 'weekly');
    await type(byLabel<HTMLSelectElement>('星期'), '3');
    await type(byLabel<HTMLInputElement>('时间'), '08:15');
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(
      dialog().querySelector('[data-testid="automation-schedule-preview"]')
        ?.textContent,
    ).toBe(`每周三 08:15 · Cron 15 8 * * 3 · 时区 ${zone}`);
    await submit();
    expect(posted().schedule).toEqual({
      kind: 'cron',
      cronExpr: '15 8 * * 3',
      timezone: zone,
    });
  });

  test('完成后计时 and 手动 change the schedule kind', async () => {
    await render({});
    await fillBasics();
    await type(byLabel<HTMLSelectElement>('频率'), 'minutes');
    await act(async () => segment('计时方式', '完成后计时').click());
    await type(byLabel<HTMLSelectElement>('间隔分钟'), '20');
    expect(text()).toContain('完成后每 20 分钟');
    await act(async () => segment('计划', '手动').click());
    await submit();
    expect(posted().schedule).toEqual({ kind: 'manual' });
  });

  test('a past one-off time is rejected on creation', async () => {
    await render({});
    await fillBasics();
    await type(byLabel<HTMLSelectElement>('频率'), 'once');
    await type(byLabel<HTMLInputElement>('运行时间'), '2001-01-01T09:00');
    await submit();
    expect(text()).toContain('运行时间已经过去');
    expect(mocks.post).not.toHaveBeenCalled();
  });

  test('switching to a bound session asks which one', async () => {
    await render({});
    await fillBasics();
    expect(byLabel('目标会话')).toBeNull();
    await act(async () => segment('运行会话', '绑定已有会话').click());
    await submit();
    expect(text()).toContain('请选择要绑定的会话');
    expect(mocks.post).not.toHaveBeenCalled();

    const select = byLabel<HTMLSelectElement>('目标会话');
    // The session lists' order: pinned first, then by recent activity.
    expect([...select.options].map((option) => option.textContent)).toEqual([
      '选择一个会话',
      '置顶会话',
      '周报会话',
      '日常对话',
    ]);
    await type(select, 'web:home#agent:s1');
    await submit();
    expect(posted()).toMatchObject({
      sessionMode: 'bound',
      targetSessionJid: 'web:home#agent:s1',
    });

    // Persistent: the server picks the session.
    mocks.post.mockClear();
    await act(async () => segment('运行会话', '持续会话').click());
    await submit();
    expect(posted()).toMatchObject({
      sessionMode: 'persistent',
      targetSessionJid: null,
    });
  });

  test('from a session: prefilled and bound to it', async () => {
    await render({
      prefill: {
        workspaceJid: 'web:home',
        targetSessionJid: 'web:home#agent:s1',
      },
    });
    expect(
      segment('运行会话', '绑定已有会话').getAttribute('aria-pressed'),
    ).toBe('true');
    expect(byLabel<HTMLSelectElement>('目标会话').value).toBe(
      'web:home#agent:s1',
    );
  });

  test('scripts and pre-run checks need an admin host workspace', async () => {
    await render({ prefill: { workspaceJid: 'web:ops' } });
    expect(text()).toContain('只在管理员的宿主机工作区可用');
    await act(async () => segment('执行方式', '仅运行脚本').click());
    expect(byLabel('脚本命令')).toBeNull();
    act(() => root?.unmount());
    document.body.innerHTML = '';

    useAuthStore.setState({
      user: { id: 'u1', username: 'admin', role: 'admin' },
    } as never);
    await render({ prefill: { workspaceJid: 'web:ops' } });
    await act(async () => segment('执行方式', '仅运行脚本').click());
    expect(byLabel('脚本命令')).not.toBeNull();
    expect(byLabel('提示词')).toBeNull();
    // A script writes into one fixed session.
    expect(segment('运行会话', '持续会话').getAttribute('aria-pressed')).toBe(
      'true',
    );
    await type(byLabel<HTMLInputElement>('标题'), '备份');
    await type(byLabel<HTMLInputElement>('脚本命令'), './backup.sh');
    await submit();
    expect(posted()).toMatchObject({
      execution: 'script',
      scriptCommand: './backup.sh',
      prompt: '',
      sessionMode: 'persistent',
      workspaceJid: 'web:ops',
    });
  });

  test('editing sends the revision; a stale one asks to refresh', async () => {
    const saved = automation();
    useAutomationsStore.setState({ automations: [saved] });
    mocks.patch.mockRejectedValueOnce({ status: 409, message: 'stale' });
    mocks.get.mockResolvedValue({
      automation: automation({ name: '日报（新）', revision: 4 }),
      runs: [],
    });
    await render({ automation: saved });
    expect(byLabel<HTMLInputElement>('标题').value).toBe('日报');
    // Fixed after creation.
    expect(byLabel<HTMLSelectElement>('工作区').disabled).toBe(true);

    await type(byLabel<HTMLInputElement>('标题'), '日报 2');
    await submit();
    expect(mocks.patch).toHaveBeenCalledWith(
      '/api/automations/a1',
      expect.objectContaining({ expectedRevision: 3, name: '日报 2' }),
    );
    const [, body] = mocks.patch.mock.calls[0];
    expect(body).not.toHaveProperty('execution');
    expect(text()).toContain('这个自动化已在别处修改');
    expect(button('保存').disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => button('刷新').click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(byLabel<HTMLInputElement>('标题').value).toBe('日报（新）');
    expect(text()).not.toContain('这个自动化已在别处修改');

    mocks.patch.mockResolvedValueOnce({
      automation: automation({ name: '日报（新）', revision: 5 }),
    });
    await submit();
    expect(mocks.patch).toHaveBeenLastCalledWith(
      '/api/automations/a1',
      expect.objectContaining({ expectedRevision: 4 }),
    );
    expect(onClose).toHaveBeenCalled();
  });
});
