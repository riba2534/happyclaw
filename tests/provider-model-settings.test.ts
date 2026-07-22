import { describe, expect, test } from 'vitest';

import {
  buildDefaultProviderEnv,
  buildProviderModel,
  parseProviderModel,
} from '../web/src/utils/provider-model.js';

describe('third-party provider model settings', () => {
  test('parses the one-million context suffix from an existing model', () => {
    expect(parseProviderModel('  glm-5.2[1m]  ')).toEqual({
      model: 'glm-5.2',
      oneMillionContext: true,
    });
  });

  test('normalizes duplicate or mixed-case suffixes', () => {
    expect(buildProviderModel('qwen3.7-max[1M][1m]', true)).toBe(
      'qwen3.7-max[1m]',
    );
  });

  test('removes the suffix when one-million context is disabled', () => {
    expect(buildProviderModel('MiniMax-M3[1m]', false)).toBe('MiniMax-M3');
  });

  test('does not create a suffix without a model name', () => {
    expect(buildProviderModel(' ', true)).toBe('');
  });

  test('shows all managed values for a one-million context provider', () => {
    expect(
      Object.fromEntries(
        buildDefaultProviderEnv('glm-5.2', true).map(({ key, value }) => [
          key,
          value,
        ]),
      ),
    ).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.2[1m]',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
      CLAUDE_CODE_NO_FLICKER: '1',
      API_TIMEOUT_MS: '3000000',
    });
  });

  test('treats native 1M models (Fable 5) as 1M without the toggle', () => {
    const rows = buildDefaultProviderEnv('claude-fable-5', false);

    expect(
      rows.find((row) => row.key === 'CLAUDE_CODE_AUTO_COMPACT_WINDOW')?.value,
    ).toBe('1000000');
    expect(
      rows.find((row) => row.key === 'ANTHROPIC_DEFAULT_OPUS_MODEL')?.value,
    ).toBe('claude-fable-5');
  });

  test('keeps model-derived rows pending until a model is entered', () => {
    const rows = buildDefaultProviderEnv('', false);

    expect(rows.filter((row) => row.source === 'model')).toHaveLength(3);
    expect(rows.filter((row) => row.source === 'model')).toSatisfy((items) =>
      items.every((row) => row.value === ''),
    );
    expect(
      rows.find((row) => row.key === 'CLAUDE_CODE_AUTO_COMPACT_WINDOW')?.value,
    ).toBe('200000');
  });
});
