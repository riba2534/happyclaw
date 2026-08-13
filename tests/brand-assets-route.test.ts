import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createBrandAssetRoutes } from '../src/routes/brand-assets.js';
import type { AppearanceConfig } from '../src/runtime-config.js';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function defaultAppearance(): AppearanceConfig {
  return {
    appName: 'HappyClaw',
    aiName: 'HappyClaw',
    aiAvatarEmoji: '🐱',
    aiAvatarColor: '#0d9488',
    aiAvatarUrl: null,
    aiAvatarMode: 'brand',
    brandIconUrl: null,
    brandBannerUrl: null,
  };
}

function createHarness(
  options: {
    role?: 'admin' | 'member';
    rmSync?: typeof fs.rmSync;
    saveAppearance?: (
      current: AppearanceConfig,
      next: Partial<AppearanceConfig>,
    ) => AppearanceConfig;
  } = {},
) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-assets-route-'));
  tempDirs.push(dataDir);
  let appearance = defaultAppearance();
  const warn = vi.fn();
  const error = vi.fn();
  const role = options.role ?? 'admin';

  const routes = createBrandAssetRoutes({
    dataDir,
    auth: async (c, next) => {
      c.set('user', {
        id: 'test-user',
        username: 'test-user',
        role,
        permissions: [],
      });
      await next();
    },
    requireAdmin: async (c, next) => {
      if (c.get('user').role !== 'admin') {
        return c.json({ error: 'Forbidden: admin role required' }, 403);
      }
      await next();
    },
    saveAppearance: (next) => {
      appearance = options.saveAppearance
        ? options.saveAppearance(appearance, next)
        : { ...appearance, ...next };
      return { ...appearance };
    },
    log: { warn, error },
    ...(options.rmSync ? { fileOps: { rmSync: options.rmSync } } : {}),
  });

  return {
    assetsDir: path.join(dataDir, 'brand-assets'),
    error,
    getAppearance: () => appearance,
    routes,
    warn,
  };
}

function imageForm(kind: 'icon' | 'banner', bytes = PNG_BYTES): FormData {
  const form = new FormData();
  form.append(kind, new File([bytes], `${kind}.png`, { type: 'image/png' }));
  return form;
}

async function upload(
  routes: ReturnType<typeof createBrandAssetRoutes>,
  kind: 'icon' | 'banner',
  bytes = PNG_BYTES,
) {
  return routes.request(`/appearance/brand-${kind}`, {
    method: 'POST',
    body: imageForm(kind, bytes),
  });
}

describe('brand asset routes', () => {
  test('keeps frontend URLs and delete responses aligned with the API', () => {
    const sidebar = fs.readFileSync(
      path.join(process.cwd(), 'web/src/components/layout/UnifiedSidebar.tsx'),
      'utf8',
    );
    const appearance = fs.readFileSync(
      path.join(
        process.cwd(),
        'web/src/components/settings/AppearanceSection.tsx',
      ),
      'utf8',
    );

    expect(sidebar).toContain('withBasePath(appearance.brandIconUrl)');
    expect(sidebar).toContain('withBasePath(appearance.brandBannerUrl)');
    expect(appearance).toContain(
      'api.delete<{ appearance: AppearanceConfig }>',
    );
    expect(appearance).toContain('onChange(result.appearance)');
  });

  test('requires an admin for writes', async () => {
    const { routes } = createHarness({ role: 'member' });

    expect((await upload(routes, 'icon')).status).toBe(403);
    expect(
      (await routes.request('/appearance/brand-icon', { method: 'DELETE' }))
        .status,
    ).toBe(403);
  });

  test('rejects spoofed image MIME and oversized files', async () => {
    const { routes } = createHarness();
    const spoofed = Buffer.alloc(16, 0x61);
    const oversized = Buffer.alloc(3 * 1024 * 1024 + 1, 0x61);
    PNG_BYTES.copy(oversized);

    expect((await upload(routes, 'icon', spoofed)).status).toBe(400);
    expect((await upload(routes, 'icon', oversized)).status).toBe(413);
  });

  test('uploads and publicly serves an allowlisted asset asynchronously', async () => {
    const { assetsDir, routes } = createHarness();
    const response = await upload(routes, 'icon');
    const body = (await response.json()) as {
      appearance: AppearanceConfig;
      assetUrl: string;
    };

    expect(response.status).toBe(200);
    expect(body.assetUrl).toMatch(
      /^\/api\/config\/brand-assets\/brand-icon-[a-f0-9]{8}\.png$/,
    );
    expect(body.appearance.brandIconUrl).toBe(body.assetUrl);
    expect(
      fs.readFileSync(path.join(assetsDir, path.basename(body.assetUrl))),
    ).toEqual(PNG_BYTES);

    const publicResponse = await routes.request(
      body.assetUrl.replace('/api/config', ''),
    );
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await publicResponse.arrayBuffer())).toEqual(PNG_BYTES);
    expect(
      (await routes.request('/brand-assets/not-allowlisted.svg')).status,
    ).toBe(400);
    expect(
      (await routes.request('/brand-assets/brand-icon-00000000.png')).status,
    ).toBe(404);
  });

  test('returns a stable response contract when deleting an asset', async () => {
    const { assetsDir, routes } = createHarness();
    const uploaded = (await (await upload(routes, 'banner')).json()) as {
      assetUrl: string;
    };
    const response = await routes.request('/appearance/brand-banner', {
      method: 'DELETE',
    });
    const body = (await response.json()) as { appearance: AppearanceConfig };

    expect(response.status).toBe(200);
    expect(body).toHaveProperty('appearance');
    expect(body.appearance.brandBannerUrl).toBeNull();
    expect(
      fs.existsSync(path.join(assetsDir, path.basename(uploaded.assetUrl))),
    ).toBe(false);
  });

  test('keeps the committed asset when stale-file cleanup fails', async () => {
    let stalePath: string | null = null;
    const rmSync: typeof fs.rmSync = (filename, options) => {
      if (String(filename) === stalePath) throw new Error('cleanup denied');
      return fs.rmSync(filename, options as Parameters<typeof fs.rmSync>[1]);
    };
    const { assetsDir, getAppearance, routes, warn } = createHarness({
      rmSync,
    });
    const first = (await (await upload(routes, 'icon')).json()) as {
      assetUrl: string;
    };
    stalePath = path.join(assetsDir, path.basename(first.assetUrl));

    const response = await upload(routes, 'icon');
    const second = (await response.json()) as {
      appearance: AppearanceConfig;
      assetUrl: string;
    };
    const selectedPath = path.join(assetsDir, path.basename(second.assetUrl));

    expect(response.status).toBe(200);
    expect(getAppearance().brandIconUrl).toBe(second.assetUrl);
    expect(fs.existsSync(selectedPath)).toBe(true);
    expect(fs.existsSync(stalePath)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'icon' }),
      'Failed to remove stale brand assets',
    );
  });

  test('commits deletion even when physical cleanup is unavailable', async () => {
    let blockedPath: string | null = null;
    const rmSync: typeof fs.rmSync = (filename, options) => {
      if (String(filename) === blockedPath) throw new Error('cleanup denied');
      return fs.rmSync(filename, options as Parameters<typeof fs.rmSync>[1]);
    };
    const { assetsDir, getAppearance, routes, warn } = createHarness({
      rmSync,
    });
    const uploaded = (await (await upload(routes, 'icon')).json()) as {
      assetUrl: string;
    };
    blockedPath = path.join(assetsDir, path.basename(uploaded.assetUrl));

    const response = await routes.request('/appearance/brand-icon', {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    expect(getAppearance().brandIconUrl).toBeNull();
    expect(fs.existsSync(blockedPath)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  test('removes a newly written file when config persistence fails', async () => {
    const { assetsDir, error, routes } = createHarness({
      saveAppearance: () => {
        throw new Error('config write failed');
      },
    });

    const response = await upload(routes, 'icon');

    expect(response.status).toBe(500);
    expect(fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : []).toEqual(
      [],
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'icon' }),
      'Failed to save brand asset',
    );
  });
});
