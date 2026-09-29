import { describe, expect, test } from 'vitest';

import {
  clampCodexEffort,
  CODEX_DEFAULT_EFFORT,
  CODEX_DEFAULT_MODEL,
  CODEX_MODEL_CATALOG,
  resolveCodexCatalogEntry,
} from '../src/codex-gateway/model-catalog.js';

describe('Codex model catalog', () => {
  test('default model/effort exist in the catalog', () => {
    const entry = resolveCodexCatalogEntry(CODEX_DEFAULT_MODEL);
    expect(entry).toBeDefined();
    expect(entry?.efforts).toContain(CODEX_DEFAULT_EFFORT);
  });

  test('catalog values are unique and efforts non-empty', () => {
    const values = CODEX_MODEL_CATALOG.map((entry) => entry.value);
    expect(new Set(values).size).toBe(values.length);
    for (const entry of CODEX_MODEL_CATALOG) {
      expect(entry.efforts.length).toBeGreaterThan(0);
      expect(entry.label).toContain(entry.value);
    }
  });

  test('gpt-6 family is the primary catalog with legacy gpt-5.5 kept', () => {
    const values = CODEX_MODEL_CATALOG.map((entry) => entry.value);
    expect(values).toEqual(
      expect.arrayContaining([
        'gpt-6-sol',
        'gpt-6-astra',
        'gpt-6-luna',
        'gpt-5.5',
      ]),
    );
  });

  test('clampCodexEffort resets unsupported efforts to the catalog default', () => {
    // gpt-6-luna 没有 ultra 档
    expect(clampCodexEffort('gpt-6-luna', 'ultra')).toBe(CODEX_DEFAULT_EFFORT);
    // gpt-5.5 没有 max/ultra
    expect(clampCodexEffort('gpt-5.5', 'max')).toBe(CODEX_DEFAULT_EFFORT);
    // 支持的档位透传
    expect(clampCodexEffort('gpt-6-sol', 'xhigh')).toBe('xhigh');
    // 未配置时原样返回（undefined 语义由 normalizeCodexEffort 兜底）
    expect(clampCodexEffort('gpt-6-sol', undefined)).toBeUndefined();
  });

  test('clampCodexEffort passes through models outside the catalog', () => {
    // 上游新模型尚未收录时不应被本地目录误伤
    expect(clampCodexEffort('gpt-7-future', 'ultra')).toBe('ultra');
  });
});
