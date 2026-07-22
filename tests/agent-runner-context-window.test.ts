import { describe, expect, test } from 'vitest';

import {
  isExtendedContextModel,
  resolveAutoCompactWindow,
  resolveLegacyAutoCompactWindow,
  resolveModelContextWindow,
} from '../container/agent-runner/src/context-window.js';

describe('Claude model-aware context compression', () => {
  test('uses 200K for ordinary models and 1M for [1m] models', () => {
    expect(resolveModelContextWindow('claude-sonnet-4-5')).toBe(200_000);
    expect(resolveModelContextWindow('model_hub/glm-5.2[1m]')).toBe(1_000_000);
    expect(resolveModelContextWindow('model[1m][1m]')).toBe(1_000_000);
    expect(isExtendedContextModel('model[1M]')).toBe(true);
    expect(isExtendedContextModel('model[1m] trailing')).toBe(false);
  });

  test('treats Fable 5 / Sonnet 5 / Mythos 5 as native 1M models without the suffix', () => {
    expect(resolveModelContextWindow('claude-fable-5')).toBe(1_000_000);
    expect(resolveModelContextWindow('fable-5')).toBe(1_000_000);
    expect(resolveModelContextWindow('claude-sonnet-5')).toBe(1_000_000);
    expect(resolveModelContextWindow('claude-mythos-5')).toBe(1_000_000);
    expect(resolveModelContextWindow('hub/claude-fable-5-20260101')).toBe(
      1_000_000,
    );
    expect(resolveAutoCompactWindow('claude-fable-5', 80)).toBe(800_000);
    // 名字里恰好含 fable 但不是 fable-5 的模型不受影响
    expect(resolveModelContextWindow('fables-5')).toBe(200_000);
    expect(resolveModelContextWindow('fable-50')).toBe(200_000);
    // Sonnet 4.5（claude-sonnet-4-5）仍是 200K，不能被 sonnet-5 误伤
    expect(resolveModelContextWindow('claude-sonnet-4-5')).toBe(200_000);
    expect(resolveModelContextWindow('claude-sonnet-4-5-20250929')).toBe(
      200_000,
    );
  });

  test('clamps legacy fixed thresholds to the active model window', () => {
    expect(resolveLegacyAutoCompactWindow('sonnet', 800_000)).toBe(180_000);
    expect(resolveLegacyAutoCompactWindow('sonnet', 120_000)).toBe(120_000);
    expect(resolveLegacyAutoCompactWindow('glm[1M]', 950_000)).toBe(900_000);
    expect(resolveLegacyAutoCompactWindow('glm[1m]', 800_000)).toBe(800_000);
    expect(resolveLegacyAutoCompactWindow('sonnet', 0)).toBeUndefined();
  });

  test('converts the same percentage relative to the effective model window', () => {
    expect(resolveAutoCompactWindow('claude-sonnet-4-5', 80)).toBe(160_000);
    expect(resolveAutoCompactWindow('glm-5.2[1m]', 80)).toBe(800_000);
  });

  test('rejects percentages outside the supported safety range', () => {
    expect(resolveAutoCompactWindow('claude-sonnet-4-5', 49)).toBeUndefined();
    expect(resolveAutoCompactWindow('claude-sonnet-4-5', 91)).toBeUndefined();
    expect(resolveAutoCompactWindow('claude-sonnet-4-5', 80.5)).toBeUndefined();
  });
});
