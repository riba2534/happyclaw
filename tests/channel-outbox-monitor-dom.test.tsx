// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const mockSummary = {
  total: 5,
  pending: 1,
  retryWait: 1,
  claimed: 0,
  uncertain: 1,
  failed: 1,
  delivered: 1,
  overdue: 2,
};

const mockItems = [
  {
    id: 'outbox-1',
    turnRunId: 'turn-run-1',
    kind: 'text' as const,
    ordinal: 0,
    revision: 3,
    status: 'uncertain',
    attempt: 2,
    error: 'Provider ACK dropped during timeout',
    createdAt: new Date(Date.now() - 150_000).toISOString(),
    updatedAt: new Date(Date.now() - 150_000).toISOString(),
    ageMs: 150000,
    ageSeconds: 150,
    ageFormatted: '2m 30s',
    isOverdue: true,
    route: {
      provider: 'feishu',
      accountId: 'acc-prod-12345678',
      botName: '主飞书运营机器人',
      sourceJid: 'feishu:acc-prod:chat-999',
      chatId: 'chat-999',
      rootId: 'root-msg-1',
      threadId: 'thread-msg-1',
      sessionId: 'session-alpha-99',
      agentId: 'agent-ops',
      groupFolder: 'ops-workspace',
      groupName: '运维值班群',
      navigationUrl: '/chat/ops-workspace?agent=agent-ops',
    },
  },
];

vi.mock('../web/src/api/client', () => ({
  api: {
    get: vi.fn(async () => ({
      summary: mockSummary,
      items: mockItems,
      total: mockItems.length,
    })),
    post: vi.fn(async () => ({
      ok: true,
      impact: {
        description: '已成功送达并释放栅栏',
      },
    })),
  },
}));

import { ChannelOutboxMonitor } from '../web/src/components/monitor/ChannelOutboxMonitor';
import { useMonitorStore } from '../web/src/stores/monitor';

describe('ChannelOutboxMonitor DOM component', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    container?.remove();
    container = null;
    root = null;
  });

  test('正确渲染 Outbox 统计卡片、超期项、路由身份及导航链接', async () => {
    // 注入 mock 数据
    useMonitorStore.setState({
      outboxSummary: mockSummary,
      outboxItems: mockItems,
      outboxLoading: false,
    });

    await act(async () => {
      root?.render(<ChannelOutboxMonitor />);
    });

    expect(container).not.toBeNull();
    const html = container?.innerHTML || '';

    // 1. 标题与统计验证
    expect(html).toContain('渠道出站队列 (Outbox) 监控');
    expect(html).toContain('超期风险 (Overdue)');
    expect(html).toContain('待确认 (Uncertain)');

    // 2. 列表项与状态徽标
    expect(html).toContain('待人工确认');
    expect(html).toContain('[超期]');
    expect(html).toContain('2m 30s 前');

    // 3. 真实来源展示
    expect(html).toContain('主飞书运营机器人');
    expect(html).toContain('运维值班群');
    expect(html).toContain('agent: agent-ops');

    // 4. 异常与隐私
    expect(html).toContain('Provider ACK dropped during timeout');

    // 5. 导航链接
    const navLink = container?.querySelector(
      'a[href="/chat/ops-workspace?agent=agent-ops"]',
    );
    expect(navLink).not.toBeNull();

    // 6. 人工裁决按钮
    const resolveButtons = Array.from(
      container?.querySelectorAll('button') || [],
    ).filter((b) => b.textContent?.includes('人工裁决'));
    expect(resolveButtons.length).toBeGreaterThanOrEqual(1);

    // 点击人工裁决按钮
    await act(async () => {
      resolveButtons[0].click();
    });

    // 验证弹窗内容：CAS 版本号与安全隐私提示
    const bodyHtml = document.body.innerHTML;
    expect(bodyHtml).toContain('人工裁决待确认投递');
    expect(bodyHtml).toContain('条目 ID:');
    expect(bodyHtml).toContain('outbox-1');
    expect(bodyHtml).toContain('当前版本 (CAS):');
    expect(bodyHtml).toContain('rev 3');
    expect(bodyHtml).toContain('消息正文严格受隐私边界保护未在此处展示');
  });
});
