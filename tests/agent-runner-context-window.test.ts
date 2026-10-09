import { describe, expect, test } from 'vitest';

import {
  buildClaudeRuntimeEnv,
  resolveAutoCompactEnv,
} from '../container/agent-runner/src/claude-runtime-env.js';
import { isExtendedContextModel } from '../container/agent-runner/src/context-window.js';

describe('extended context detection', () => {
  test('recognises only an explicit [1m] suffix', () => {
    expect(isExtendedContextModel('model_hub/glm-5.2[1m]')).toBe(true);
    expect(isExtendedContextModel('model[1m][1m]')).toBe(true);
    expect(isExtendedContextModel('model[1M]')).toBe(true);
    expect(isExtendedContextModel('model[1m] trailing')).toBe(false);
    expect(isExtendedContextModel('claude-sonnet-5')).toBe(false);
  });
});

// The runner used to turn these policies into the `autoCompactWindow`
// setting, computed against an assumed 200K window. Third-party providers set
// CLAUDE_CODE_AUTO_COMPACT_WINDOW, which outranks that setting, and 1M-native
// models made the 200K assumption compact at a fraction of the real window.
describe('auto-compact policy to Claude Code environment', () => {
  test('a percentage becomes CLAUDE_AUTOCOMPACT_PCT_OVERRIDE and wins over a window', () => {
    expect(
      resolveAutoCompactEnv({
        AUTO_COMPACT_PERCENTAGE: '80',
        AUTO_COMPACT_WINDOW: '500000',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000',
      }),
    ).toEqual({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80' });
  });

  test('an absolute window never exceeds the provider cap', () => {
    expect(
      resolveAutoCompactEnv({
        AUTO_COMPACT_WINDOW: '500000',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000',
      }),
    ).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' });
    expect(
      resolveAutoCompactEnv({
        AUTO_COMPACT_WINDOW: '150000',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000',
      }),
    ).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000' });
  });

  test('an absolute window applies as is without a provider cap', () => {
    expect(resolveAutoCompactEnv({ AUTO_COMPACT_WINDOW: '800000' })).toEqual({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '800000',
    });
  });

  test('out-of-range percentages fall back to the window policy', () => {
    for (const percentage of ['49', '91', '80.5', 'abc']) {
      expect(
        resolveAutoCompactEnv({
          AUTO_COMPACT_PERCENTAGE: percentage,
          AUTO_COMPACT_WINDOW: '300000',
        }),
      ).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' });
    }
  });

  test('no policy leaves the provider and model defaults untouched', () => {
    expect(
      resolveAutoCompactEnv({
        AUTO_COMPACT_PERCENTAGE: '0',
        AUTO_COMPACT_WINDOW: '0',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000',
      }),
    ).toEqual({});
  });
});

describe('Claude runtime environment', () => {
  test('always enables Claude Code transcript GC alongside the compact policy', () => {
    expect(buildClaudeRuntimeEnv({ AUTO_COMPACT_PERCENTAGE: '70' })).toEqual({
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70',
      CLAUDE_CODE_TRANSCRIPT_LOCAL_GC: '1',
    });
  });
});
