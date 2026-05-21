import { describe, expect, test } from 'vitest';
import { resolveImGroupDefaults } from '../src/im-group-defaults.js';

describe('resolveImGroupDefaults', () => {
  test('owner 偏好 = true → 新群 require_mention = true', () => {
    expect(
      resolveImGroupDefaults({ ownerDefaultRequireMention: true }),
    ).toEqual({ requireMention: true });
  });

  test('owner 偏好 = false → 新群 require_mention = false（保留 legacy 行为）', () => {
    expect(
      resolveImGroupDefaults({ ownerDefaultRequireMention: false }),
    ).toEqual({ requireMention: false });
  });

  test('owner 偏好缺失（用户记录已删/未配置） → require_mention = false', () => {
    // 防御性：getUserById 在 auto-register 和 user 删除之间存在竞态，
    // 找不到 user 时不应默认开启 mention 门控（避免静默把所有新群锁死）
    expect(resolveImGroupDefaults({})).toEqual({ requireMention: false });
    expect(
      resolveImGroupDefaults({ ownerDefaultRequireMention: null }),
    ).toEqual({ requireMention: false });
    expect(
      resolveImGroupDefaults({ ownerDefaultRequireMention: undefined }),
    ).toEqual({ requireMention: false });
  });

  test('truthy 但非 boolean 的值不应被当作 true（fail-safe）', () => {
    // 防御性：DB 列若被外部脚本写入非 0/1 整数（如 2），mapUserRow 会
    // 转成 boolean。这里只是再加一道防线，确保只有严格 === true 才生效。
    expect(
      resolveImGroupDefaults({
        // @ts-expect-error: 模拟运行时被注入的脏数据
        ownerDefaultRequireMention: 1,
      }),
    ).toEqual({ requireMention: false });
  });
});
