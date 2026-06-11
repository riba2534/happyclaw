import { describe, test, expect } from 'vitest';

import { resolveSystemMessage } from '../web/src/lib/system-message-registry';

describe('resolveSystemMessage', () => {
  test('精确 context_reset 返回固定中文 divider', () => {
    expect(resolveSystemMessage('context_reset')).toEqual({
      style: 'divider',
      text: '上下文已清除',
    });
  });

  test('context_reset: 前缀返回带详情的 divider（修复 P1 静默丢弃 bug）', () => {
    expect(resolveSystemMessage('context_reset:会话已自动重置：OOM')).toEqual({
      style: 'divider',
      text: '会话已自动重置：OOM',
    });
  });

  test('query_interrupted 返回固定中文 divider', () => {
    expect(resolveSystemMessage('query_interrupted')).toEqual({
      style: 'divider',
      text: '已中断',
    });
  });

  test('agent_error: 前缀返回 error', () => {
    expect(resolveSystemMessage('agent_error:Claude API 超时')).toEqual({
      style: 'error',
      text: 'Claude API 超时',
    });
  });

  test('agent_max_retries: 前缀返回 error', () => {
    expect(resolveSystemMessage('agent_max_retries:已达最大重试次数')).toEqual({
      style: 'error',
      text: '已达最大重试次数',
    });
  });

  test('system_error: 前缀返回 error', () => {
    expect(resolveSystemMessage('system_error:清除上下文失败')).toEqual({
      style: 'error',
      text: '清除上下文失败',
    });
  });

  test('system_info: 前缀返回 divider', () => {
    expect(resolveSystemMessage('system_info:任务已创建')).toEqual({
      style: 'divider',
      text: '任务已创建',
    });
  });

  test('未知前缀走 fallback divider（保留原始内容，不静默丢弃）', () => {
    expect(resolveSystemMessage('unknown_type:some detail')).toEqual({
      style: 'divider',
      text: 'unknown_type:some detail',
    });
  });

  test('空内容也走 fallback', () => {
    expect(resolveSystemMessage('')).toEqual({
      style: 'divider',
      text: '',
    });
  });

  test('规则按顺序匹配：context_reset 精确优先于 context_reset: 前缀', () => {
    expect(resolveSystemMessage('context_reset')).toEqual({
      style: 'divider',
      text: '上下文已清除',
    });
  });
});
