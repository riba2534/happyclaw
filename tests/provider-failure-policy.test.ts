import { describe, expect, test } from 'vitest';

import { resolveProviderFailureDisposition } from '../src/provider-failure.js';

describe('provider failure disposition', () => {
  test('preserves the input when another healthy provider exists', () => {
    expect(
      resolveProviderFailureDisposition('qwen', [
        { profileId: 'qwen', healthy: false },
        { profileId: 'glm', healthy: true },
      ]),
    ).toEqual({ retryElsewhere: true, terminal: false });
  });

  test('becomes terminal when the only provider is exhausted', () => {
    expect(
      resolveProviderFailureDisposition('qwen', [
        { profileId: 'qwen', healthy: false },
      ]),
    ).toEqual({ retryElsewhere: false, terminal: true });
  });

  test('becomes terminal when all configured providers are unhealthy', () => {
    expect(
      resolveProviderFailureDisposition('glm', [
        { profileId: 'qwen', healthy: false },
        { profileId: 'glm', healthy: false },
      ]),
    ).toEqual({ retryElsewhere: false, terminal: true });
  });

  test('fails terminally when no selected provider identity is available', () => {
    expect(
      resolveProviderFailureDisposition(null, [
        { profileId: 'glm', healthy: true },
      ]),
    ).toEqual({ retryElsewhere: false, terminal: true });
  });
});
