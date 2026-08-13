import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-config-'));

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'HappyClaw',
  DATA_DIR: tmpDir,
}));

const runtime = await import('../src/runtime-config.js');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('system brand migration', () => {
  test('updates the site name without erasing legacy bot appearance data', () => {
    runtime.saveAppearanceConfig({
      appName: 'Before',
      aiName: 'Legacy bot',
      aiAvatarEmoji: '🦀',
      aiAvatarColor: '#123456',
      aiAvatarUrl: '/api/auth/avatars/system-agent-before.png',
      aiAvatarMode: 'brand',
    });

    expect(runtime.saveAppearanceConfig({ appName: 'Team Claw' })).toEqual({
      appName: 'Team Claw',
      aiName: 'Legacy bot',
      aiAvatarEmoji: '🦀',
      aiAvatarColor: '#123456',
      aiAvatarUrl: '/api/auth/avatars/system-agent-before.png',
      aiAvatarMode: 'brand',
      brandIconUrl: null,
      brandBannerUrl: null,
    });
  });

  test('can clear the global main Agent image without resetting its fallback', () => {
    expect(runtime.saveAppearanceConfig({ aiAvatarUrl: null })).toMatchObject({
      aiAvatarEmoji: '🦀',
      aiAvatarColor: '#123456',
      aiAvatarUrl: null,
      aiAvatarMode: 'brand',
    });
  });

  test('persists brand icon and banner URLs independently of each other', () => {
    expect(
      runtime.saveAppearanceConfig({
        brandIconUrl: '/api/config/brand-assets/brand-icon-abcd1234.png',
      }),
    ).toMatchObject({
      brandIconUrl: '/api/config/brand-assets/brand-icon-abcd1234.png',
      brandBannerUrl: null,
    });

    expect(
      runtime.saveAppearanceConfig({
        brandBannerUrl: '/api/config/brand-assets/brand-banner-abcd1234.png',
      }),
    ).toMatchObject({
      brandIconUrl: '/api/config/brand-assets/brand-icon-abcd1234.png',
      brandBannerUrl: '/api/config/brand-assets/brand-banner-abcd1234.png',
    });

    expect(runtime.saveAppearanceConfig({ brandIconUrl: null })).toMatchObject({
      brandIconUrl: null,
      brandBannerUrl: '/api/config/brand-assets/brand-banner-abcd1234.png',
    });
  });
});
