import { describe, expect, test } from 'vitest';
import { isSuspectTruncatedStreamResult } from '../container/agent-runner/src/utils.js';

// 上游断流截断指纹：subtype=success + 正文非空 + result.usage 的
// input/output tokens 双零（健康 turn 的 result.usage 恒为正累计值）。
// 实测事故：glm-5.2 网关在长文本生成中断流，SDK 把 907 字符 partial 按
// success 收口，usage 全 0（logs/host-2026-07-05T10-29-49-545Z.log）。
describe('isSuspectTruncatedStreamResult', () => {
  test('零 usage + 正文非空 → 疑似截断', () => {
    expect(
      isSuspectTruncatedStreamResult(
        { input_tokens: 0, output_tokens: 0 },
        907,
      ),
    ).toBe(true);
  });

  test('usage 字段缺省为 0 也命中（空对象 usage）', () => {
    expect(isSuspectTruncatedStreamResult({}, 100)).toBe(true);
  });

  test('健康 turn（正 usage）不误报', () => {
    expect(
      isSuspectTruncatedStreamResult(
        { input_tokens: 77445, output_tokens: 28 },
        51,
      ),
    ).toBe(false);
  });

  test('仅 output 为 0 但 input 为正（缓存命中等）不误报', () => {
    expect(
      isSuspectTruncatedStreamResult(
        { input_tokens: 1200, output_tokens: 0 },
        30,
      ),
    ).toBe(false);
  });

  test('仅 input 为 0 但 output 为正不误报', () => {
    expect(
      isSuspectTruncatedStreamResult(
        { input_tokens: 0, output_tokens: 15 },
        30,
      ),
    ).toBe(false);
  });

  test('正文为空不判定为截断（无内容可续写）', () => {
    expect(
      isSuspectTruncatedStreamResult({ input_tokens: 0, output_tokens: 0 }, 0),
    ).toBe(false);
  });

  test('usage 整体缺失保守不判定（未知 SDK 变体）', () => {
    expect(isSuspectTruncatedStreamResult(undefined, 500)).toBe(false);
    expect(isSuspectTruncatedStreamResult(null, 500)).toBe(false);
  });
});
