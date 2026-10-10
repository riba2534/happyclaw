import { describe, expect, test } from 'vitest';

import { isOneMillionContextModel as backendIsOneMillion } from '../src/runtime-config.js';
import {
  buildDefaultProviderEnv,
  buildProviderModel,
  isOneMillionContextModel,
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

  test('prefills the 1M compact window for 1M-native Claude models like the backend', () => {
    const window = (model: string) =>
      buildDefaultProviderEnv(model, false).find(
        (row) => row.key === 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
      )?.value;
    expect(window('claude-sonnet-5-5')).toBe('1000000');
    expect(window('claude-haiku-4-5')).toBe('200000');
    expect(window('glm-5.2')).toBe('200000');

    for (const model of [
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-5-5',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-5-5',
      'claude-haiku-5',
      'claude-haiku-4-5',
      'glm-5.2',
      'glm-5.2[1m]',
      'deepseek-v4',
    ]) {
      expect(isOneMillionContextModel(model), model).toBe(
        backendIsOneMillion(model),
      );
    }
  });
});
