import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import {
  CacheHitRatePanel,
  cacheRateRows,
  type CacheRateResponse,
} from '../web/src/components/usage/CacheHitRatePanel.js';
import { formatHitRate } from '../web/src/lib/usage-metrics.js';

const row = (hitRate: number | null) => ({
  inputTokens: 10,
  cacheCreationTokens: 20,
  cacheReadTokens: 70,
  hitRate,
});

const data: CacheRateResponse = {
  summary: row(0.7),
  daily: [
    { date: '2026-10-27', ...row(0.5) },
    { date: '2026-10-28', ...row(0.9) },
  ],
  models: [{ model: 'opus', ...row(0.7) }],
  connections: [
    { connectionId: null, name: null, ...row(null) },
    { connectionId: 'conn-0123456789', name: null, ...row(0.2) },
    { connectionId: 'conn-work', name: '工作账号', ...row(0.8) },
  ],
};

describe('cache hit-rate panel', () => {
  test('labels connections, including unrecorded and deleted ones', () => {
    expect(cacheRateRows(data, 'connection').map((r) => r.label)).toEqual([
      '未记录连接',
      '已删除的连接（conn-012）',
      '工作账号',
    ]);
  });

  test('lists the newest day first and formats a missing rate as a dash', () => {
    expect(cacheRateRows(data, 'day').map((r) => r.key)).toEqual([
      '2026-10-28',
      '2026-10-27',
    ]);
    expect(formatHitRate(0.4937)).toBe('49.4%');
    expect(formatHitRate(null)).toBe('—');
  });

  test('explains the Anthropic usage semantics before data arrives', () => {
    const html = renderToStaticMarkup(
      <CacheHitRatePanel queryParams="days=7" />,
    );
    expect(html).toContain('缓存命中率');
    expect(html).toContain('按 Anthropic 用量语义计算（input 不含缓存）');
    expect(html).toContain('若网关把缓存计入 input，命中率会偏低');
  });
});
