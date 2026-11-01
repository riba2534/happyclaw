// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AvailableImGroup } from '../../types';

const mocks = vi.hoisted(() => ({
  loadAvailableImGroups: vi.fn(),
  syncAvailableImGroups: vi.fn(),
  loadGroups: vi.fn(),
  loadAgents: vi.fn(),
  unbindImGroup: vi.fn(),
  unbindWorkspaceImGroup: vi.fn(),
  put: vi.fn(),
}));

vi.mock('../../stores/chat', () => ({
  useChatStore: (selector: (state: typeof mocks) => unknown) => selector(mocks),
}));
vi.mock('../../api/client', () => ({ api: { put: mocks.put } }));
vi.mock('../../utils/toast', () => ({ showToast: vi.fn() }));

const { ImBindingDialog } = await import('./ImBindingDialog');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function group(
  kind: AvailableImGroup['conversation_kind'],
  overrides: Partial<AvailableImGroup> = {},
): AvailableImGroup {
  return {
    jid: `feishu:${kind}#account:bot-a`,
    name: `${kind} chat`,
    added_at: '2026-09-06T00:00:00.000Z',
    channel_type: 'feishu',
    conversation_kind: kind,
    chat_mode: kind === 'direct' ? 'p2p' : kind,
    bound_agent_id: null,
    bound_main_jid: null,
    bound_target_name: null,
    bound_workspace_name: null,
    activation_mode: 'when_mentioned',
    audience_mode: 'owner_only',
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.put.mockResolvedValue({ success: true });
  mocks.loadGroups.mockResolvedValue(undefined);
  mocks.loadAgents.mockResolvedValue(undefined);
  mocks.syncAvailableImGroups.mockResolvedValue({
    success: true,
    feishuAccounts: 1,
  });
  mocks.unbindImGroup.mockResolvedValue(true);
  mocks.unbindWorkspaceImGroup.mockResolvedValue(true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** The dialog of a session, or (null) of the workspace's topic groups. */
async function render(
  groups: AvailableImGroup[],
  agentId: string | null = 'session-a',
) {
  mocks.loadAvailableImGroups.mockResolvedValue(groups);
  await act(async () =>
    root.render(
      <ImBindingDialog
        open
        groupJid="web:main"
        agentId={agentId}
        onClose={() => {}}
      />,
    ),
  );
}

function article(name: string) {
  const result = [...document.querySelectorAll('article')].find((item) =>
    item.textContent?.includes(name),
  );
  expect(result).toBeDefined();
  return result!;
}

async function clickButton(element: Element, label: string) {
  const button = [...element.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

describe('IM binding dialog destinations', () => {
  test('ordinary mention groups and private chats appear under session binding, topics do not', async () => {
    await render([
      group('direct'),
      group('group', { is_thread_capable: true }),
      group('topic'),
    ]);
    expect(document.querySelectorAll('article')).toHaveLength(2);
    expect(document.body.textContent).not.toContain('topic chat');
    await clickButton(article('group chat'), '绑定');
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Amain/sessions/session-a/im-binding',
      expect.objectContaining({
        im_jid: 'feishu:group#account:bot-a',
        reply_policy: 'source_only',
        activation_mode: 'when_mentioned',
        audience_mode: 'owner_only',
      }),
    );
    expect(mocks.loadAgents).toHaveBeenCalledWith('web:main', { force: true });
    expect(mocks.loadGroups).toHaveBeenCalled();
  });

  test('another session of the workspace binds to its own endpoint', async () => {
    await render([group('group')], 'session-b');
    await clickButton(article('group chat'), '绑定');
    expect(mocks.put.mock.calls[0][0]).toBe(
      '/api/groups/web%3Amain/sessions/session-b/im-binding',
    );
  });

  test('workspace binding offers only native topic groups', async () => {
    await render([group('direct'), group('group'), group('topic')], null);
    expect(document.querySelectorAll('article')).toHaveLength(1);
    await clickButton(article('topic chat'), '绑定');
    expect(mocks.put.mock.calls[0][0]).toBe(
      '/api/groups/web%3Amain/im-binding',
    );
  });

  test('changing mention activation updates policy without reassigning an ordinary group to a workspace', async () => {
    await render([
      group('group', {
        bound_agent_id: 'session-a',
        bound_workspace_jid: 'web:main',
      }),
    ]);
    const select = article('group chat').querySelector<HTMLSelectElement>(
      'select[aria-label$="的消息触发策略"]',
    );
    expect(select).not.toBeNull();
    await act(async () => {
      select!.value = 'always';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/config/user-im/bindings/feishu%3Agroup%23account%3Abot-a',
      { activation_mode: 'always' },
    );
    expect(mocks.put).toHaveBeenCalledTimes(1);
  });

  test('unbinding a chat of the session uses the session endpoint and explains that unbound channels do not respond', async () => {
    await render([
      group('group', {
        bound_agent_id: 'session-a',
        bound_session_id: 'session-a',
      }),
    ]);
    expect(document.body.textContent).toContain('未绑定时不响应');
    expect(document.body.textContent).not.toContain('恢复默认');
    await clickButton(article('group chat'), '解除绑定');
    expect(mocks.unbindImGroup).toHaveBeenCalledWith(
      'web:main',
      'session-a',
      'feishu:group#account:bot-a',
    );
    expect(mocks.unbindWorkspaceImGroup).not.toHaveBeenCalled();
  });

  test('a Feishu ordinary group bound to the session offers team mode', async () => {
    await render([
      group('group', {
        bound_agent_id: 'session-a',
        bound_session_id: 'session-a',
      }),
      group('direct', {
        bound_agent_id: 'session-a',
        bound_session_id: 'session-a',
      }),
    ]);
    const teamButton = (name: string) =>
      [...article(name).querySelectorAll('button')].find(
        (item) => item.textContent?.trim() === '团队模式',
      );
    expect(teamButton('group chat')).toBeDefined();
    expect(teamButton('direct chat')).toBeUndefined();
  });
});
