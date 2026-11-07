import { describe, expect, test } from 'vitest';

import {
  parseDeploymentMode,
  resolveDeploymentMode,
} from '../src/deployment-mode.js';

describe('deployment mode', () => {
  test('the stored setting wins, then the environment, then multi_user', () => {
    expect(
      resolveDeploymentMode({
        configured: 'single_user_host',
        env: 'multi_user',
      }),
    ).toEqual({
      mode: 'single_user_host',
      source: 'settings',
      configured: 'single_user_host',
    });
    expect(
      resolveDeploymentMode({ configured: '', env: 'single_user_host' }),
    ).toEqual({ mode: 'single_user_host', source: 'env', configured: null });
    expect(resolveDeploymentMode({ configured: '', env: undefined })).toEqual({
      mode: 'multi_user',
      source: 'default',
      configured: null,
    });
  });

  test('unknown values are ignored, not guessed', () => {
    expect(parseDeploymentMode('single')).toBeNull();
    expect(parseDeploymentMode(' single_user_host ')).toBe('single_user_host');
    expect(parseDeploymentMode(1)).toBeNull();
    expect(
      resolveDeploymentMode({ configured: 'bogus', env: 'nope' }).mode,
    ).toBe('multi_user');
  });
});
