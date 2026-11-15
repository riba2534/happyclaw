// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { MagpieQuotasUsage } from '@/lib/model-providers';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/api/client', () => ({ api: { get: mocks.get } }));

const { UsageBars } = await import('./UsageBars');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(usage: MagpieQuotasUsage) {
  mocks.get.mockResolvedValue(usage);
  await act(async () => {
    root.render(<UsageBars providerId="mp" />);
  });
}

const inHours = (hours: number) =>
  new Date(Date.now() + hours * 3_600_000 + 60_000).toISOString();

const section = (name: string) =>
  container.querySelector(`section[aria-label="${name} 的用量"]`);

describe('magpie quotas', () => {
  test('one group per account, each window with what is left and when it renews', async () => {
    await render({
      kind: 'magpie_quotas',
      fetchedAt: Date.now(),
      error: null,
      accounts: [
        {
          provider: 'claude',
          name: 'Claude Max',
          kind: 'subscription',
          plan: 'max',
          user: 'a@example.com',
          readAt: null,
          error: null,
          windows: [
            {
              name: '5h',
              used: 37,
              remaining: 63,
              resetsAt: inHours(2),
              unlimited: false,
            },
            {
              name: '7d',
              used: null,
              remaining: null,
              resetsAt: null,
              unlimited: true,
            },
          ],
        },
        {
          provider: 'codex',
          name: 'ChatGPT Pro',
          kind: 'subscription',
          plan: null,
          user: null,
          readAt: null,
          error: 'login expired',
          windows: [],
        },
      ],
    });
    expect(mocks.get).toHaveBeenCalledWith(
      '/api/config/claude/providers/mp/usage',
    );
    const claude = section('Claude Max')?.textContent ?? '';
    expect(claude).toContain('claude');
    expect(claude).toContain('max');
    expect(claude).toContain('5h');
    expect(claude).toContain('剩余 63%');
    expect(claude).toMatch(/2h( \d+m)? 后重置/);
    expect(claude).toContain('不限量');
    // An account magpie could not read says why, in its own group.
    const codex = section('ChatGPT Pro')?.textContent ?? '';
    expect(codex).toContain('读取失败：login expired');
    expect(codex).not.toContain('剩余');
    expect(container.textContent).toContain('更新于');
  });

  test('a failed read names its reason', async () => {
    await render({
      kind: 'magpie_quotas',
      fetchedAt: Date.now(),
      error: 'connect ECONNREFUSED 127.0.0.1:3425',
      accounts: [],
    });
    expect(container.textContent).toBe(
      '无法读取 magpie 用量：connect ECONNREFUSED 127.0.0.1:3425',
    );
  });

  test('says so when magpie has no account to read', async () => {
    await render({
      kind: 'magpie_quotas',
      fetchedAt: Date.now(),
      error: null,
      accounts: [],
    });
    expect(container.textContent).toContain('magpie 还没有能查询用量的账号');
  });
});
