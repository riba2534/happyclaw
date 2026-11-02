import { describe, expect, test, vi } from 'vitest';

import {
  parseContainerMemoryLimit,
  resolveOomLoopAction,
} from '../src/container-memory-limit.js';

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

describe('parseContainerMemoryLimit', () => {
  test.each([
    ['512m', 512 * MiB, '512 MiB'],
    ['512M', 512 * MiB, '512 MiB'],
    ['1.5g', 1.5 * GiB, '1.5 GiB'],
    ['3GiB', 3 * GiB, '3 GiB'],
    ['2gb', 2 * GiB, '2 GiB'],
    ['2 g', 2 * GiB, '2 GiB'],
    ['  4g  ', 4 * GiB, '4 GiB'],
    ['.5g', 0.5 * GiB, '512 MiB'],
    ['1t', 1024 * GiB, '1 TiB'],
    ['6144k', 6 * MiB, '6 MiB'],
    ['7340032b', 7 * MiB, '7 MiB'],
    // docker truncates fractional bytes like go-units' int64 conversion.
    ['0.1g', Math.floor(0.1 * GiB), '102.4 MiB'],
  ])('%s is %d bytes', (raw, bytes, display) => {
    expect(parseContainerMemoryLimit(raw)).toEqual({
      limit: { dockerValue: `${bytes}b`, display },
      error: null,
    });
  });

  test('empty means no cap and nothing to report', () => {
    for (const raw of [undefined, '', '   ']) {
      expect(parseContainerMemoryLimit(raw)).toEqual({
        limit: null,
        error: null,
      });
    }
  });

  test('a bare number is rejected, not read as bytes', () => {
    for (const raw of ['2048', '3', '1.5']) {
      expect(parseContainerMemoryLimit(raw)).toEqual({
        limit: null,
        error: 'has no unit (docker would read it as bytes)',
      });
    }
  });

  test('values below the docker minimum are rejected', () => {
    expect(parseContainerMemoryLimit('6m').limit?.dockerValue).toBe(
      `${6 * MiB}b`,
    );
    for (const raw of ['5m', '6143k', '0g', '512b']) {
      expect(parseContainerMemoryLimit(raw)).toEqual({
        limit: null,
        error: "is below docker's 6 MiB minimum",
      });
    }
  });

  test('values docker would not parse are reported', () => {
    for (const raw of [
      '3x',
      '3gg',
      '3ki',
      '3kbb',
      '-1g',
      'g',
      '1e3m',
      '3  g',
      '1.g',
      '3g ram',
    ]) {
      expect(parseContainerMemoryLimit(raw), raw).toEqual({
        limit: null,
        error: 'is not a docker memory size',
      });
    }
    expect(parseContainerMemoryLimit('99999999t')).toEqual({
      limit: null,
      error: 'is too large',
    });
  });

  test('config warns on an unusable value and applies no cap', async () => {
    vi.resetModules();
    vi.stubEnv('CONTAINER_MEMORY_LIMIT', '2048');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const config = await import('../src/config.js');
      expect(config.CONTAINER_MEMORY_LIMIT).toBeNull();
      const warning = warn.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes('CONTAINER_MEMORY_LIMIT'));
      expect(warning).toContain(
        '[happyclaw] CONTAINER_MEMORY_LIMIT="2048" has no unit',
      );
      expect(warning).toContain('run without a memory limit');
      expect(warning).toContain('256m or more');
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe('resolveOomLoopAction', () => {
  const limit = parseContainerMemoryLimit('3g').limit;

  test('a container under an admin cap keeps its context and names the cap', () => {
    const action = resolveOomLoopAction('container', limit);
    expect(action).toMatchObject({
      resetContext: false,
      noticeKey: 'oom-memory-limit',
      webType: 'system_error',
      terminalError: '容器超过内存上限（3 GiB）被终止（OOM）。',
    });
    expect(action.text).toContain('容器内存上限（3 GiB）');
    expect(action.text).toContain('会话上下文保留不变');
    expect(action.text).toContain('/fresh');
    expect(action.text).toContain('CONTAINER_MEMORY_LIMIT');
  });

  const reset = {
    resetContext: true,
    noticeKey: 'oom-context-reset',
    webType: 'context_reset',
    text: '会话文件过大导致内存溢出（OOM），已自动重置会话。之前的对话上下文已清除，请重新描述您的需求。',
    terminalError: '会话文件过大导致内存溢出（OOM），已自动重置会话。',
  };

  test('without a cap the session is reset as before', () => {
    expect(resolveOomLoopAction('container', null)).toEqual(reset);
  });

  test('host mode is never capped, so it resets as before', () => {
    expect(resolveOomLoopAction('host', limit)).toEqual(reset);
    expect(resolveOomLoopAction('host', null)).toEqual(reset);
  });
});
