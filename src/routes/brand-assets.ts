import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Hono, type MiddlewareHandler } from 'hono';
import { DATA_DIR } from '../config.js';
import { detectImageMimeTypeStrict } from '../image-detector.js';
import {
  brandAssetUploadBodyLimit,
  BRAND_ASSET_MAX_FILE_BYTES,
} from '../http-upload-policy.js';
import { logger } from '../logger.js';
import { adminRoleMiddleware, authMiddleware } from '../middleware/auth.js';
import {
  saveAppearanceConfig,
  type AppearanceConfig,
} from '../runtime-config.js';
import type { Variables } from '../web-context.js';

const BRAND_ASSET_KINDS = {
  icon: { field: 'brandIconUrl', prefix: 'brand-icon-' },
  banner: { field: 'brandBannerUrl', prefix: 'brand-banner-' },
} as const;
type BrandAssetKind = keyof typeof BRAND_ASSET_KINDS;

const BRAND_ASSET_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
};
const BRAND_ASSET_FILENAME_RE =
  /^brand-(?:icon|banner)-[a-f0-9]{8}\.(?:jpg|png)$/;

interface BrandAssetLogger {
  error: (details: Record<string, unknown>, message: string) => void;
  warn: (details: Record<string, unknown>, message: string) => void;
}

interface BrandAssetFileOps {
  existsSync: typeof fs.existsSync;
  mkdirSync: typeof fs.mkdirSync;
  readFile: (filename: string) => Promise<Buffer>;
  readdirSync: typeof fs.readdirSync;
  renameSync: typeof fs.renameSync;
  rmSync: typeof fs.rmSync;
  writeFileSync: typeof fs.writeFileSync;
}

export interface BrandAssetRouteDeps {
  dataDir: string;
  saveAppearance: (next: Partial<AppearanceConfig>) => AppearanceConfig;
  auth: MiddlewareHandler<{ Variables: Variables }>;
  requireAdmin: MiddlewareHandler<{ Variables: Variables }>;
  log: BrandAssetLogger;
  fileOps?: Partial<BrandAssetFileOps>;
}

const DEFAULT_FILE_OPS: BrandAssetFileOps = {
  existsSync: fs.existsSync,
  mkdirSync: fs.mkdirSync,
  readFile: (filename) => fs.promises.readFile(filename),
  readdirSync: fs.readdirSync,
  renameSync: fs.renameSync,
  rmSync: fs.rmSync,
  writeFileSync: fs.writeFileSync,
};

/**
 * Build the brand-asset routes with explicit dependencies so filesystem and
 * failure semantics can be exercised without loading the full config router.
 */
export function createBrandAssetRoutes(deps: BrandAssetRouteDeps) {
  const routes = new Hono<{ Variables: Variables }>();
  const fileOps: BrandAssetFileOps = {
    ...DEFAULT_FILE_OPS,
    ...deps.fileOps,
  };
  const assetsDir = path.join(deps.dataDir, 'brand-assets');

  // Appearance settings are stored in one JSON file and each asset kind owns a
  // shared directory. Serialize mutations so concurrent stale cleanup cannot
  // remove a file that another request has just selected.
  let mutation = Promise.resolve();
  async function withMutation<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = mutation;
    let release!: () => void;
    mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  function removeStaleAssets(prefix: string, keep?: string): void {
    if (!fileOps.existsSync(assetsDir)) return;
    for (const filename of fileOps.readdirSync(assetsDir)) {
      if (!filename.startsWith(prefix) || filename === keep) continue;
      fileOps.rmSync(path.join(assetsDir, filename), { force: true });
    }
  }

  function cleanupStaleAssets(
    kind: BrandAssetKind,
    prefix: string,
    keep?: string,
  ): void {
    try {
      removeStaleAssets(prefix, keep);
    } catch (err) {
      // The new appearance config is already committed. Cleanup is best-effort:
      // deleting the selected file here would leave a durable URL pointing at
      // a 404. Retain the active file and report only the stale-file failure.
      deps.log.warn(
        { err, kind, keep: keep ?? null },
        'Failed to remove stale brand assets',
      );
    }
  }

  function removeUncommittedFile(
    filename: string,
    kind: BrandAssetKind,
    phase: 'temporary' | 'destination',
  ): void {
    try {
      fileOps.rmSync(filename, { force: true });
    } catch (cleanupError) {
      deps.log.warn(
        { cleanupError, filename, kind, phase },
        'Failed to remove uncommitted brand asset file',
      );
    }
  }

  function registerUploadRoute(kind: BrandAssetKind): void {
    const { field, prefix } = BRAND_ASSET_KINDS[kind];
    routes.post(
      `/appearance/brand-${kind}`,
      deps.auth,
      deps.requireAdmin,
      brandAssetUploadBodyLimit,
      async (c) => {
        if (
          !(c.req.header('content-type') || '').includes('multipart/form-data')
        ) {
          return c.json({ error: 'Expected multipart/form-data' }, 400);
        }
        const formData = await c.req.formData();
        const file = formData.get(kind);
        if (!file || !(file instanceof File)) {
          return c.json({ error: `No ${kind} file provided` }, 400);
        }
        if (file.size > BRAND_ASSET_MAX_FILE_BYTES) {
          return c.json({ error: 'File too large (max 3MB)' }, 413);
        }

        const bytes = Buffer.from(await file.arrayBuffer());
        const mimeType = detectImageMimeTypeStrict(bytes);
        const extension = mimeType
          ? BRAND_ASSET_EXTENSIONS[mimeType]
          : undefined;
        if (!extension) {
          return c.json(
            { error: 'Unsupported image type. Use jpg or png' },
            400,
          );
        }

        try {
          return await withMutation(() => {
            fileOps.mkdirSync(assetsDir, { recursive: true });
            const filename = `${prefix}${randomBytes(4).toString('hex')}${extension}`;
            const destination = path.join(assetsDir, filename);
            const temporary = `${destination}.tmp`;
            try {
              fileOps.writeFileSync(temporary, bytes);
              fileOps.renameSync(temporary, destination);
            } catch (err) {
              removeUncommittedFile(temporary, kind, 'temporary');
              throw err;
            }

            const assetUrl = `/api/config/brand-assets/${filename}`;
            let appearance: AppearanceConfig;
            try {
              appearance = deps.saveAppearance({ [field]: assetUrl });
            } catch (err) {
              removeUncommittedFile(destination, kind, 'destination');
              throw err;
            }

            cleanupStaleAssets(kind, prefix, filename);
            return c.json({ appearance, assetUrl });
          });
        } catch (err) {
          deps.log.error({ err, kind }, 'Failed to save brand asset');
          return c.json({ error: 'Failed to save brand asset' }, 500);
        }
      },
    );

    routes.delete(
      `/appearance/brand-${kind}`,
      deps.auth,
      deps.requireAdmin,
      async (c) => {
        try {
          return await withMutation(() => {
            const appearance = deps.saveAppearance({ [field]: null });
            cleanupStaleAssets(kind, prefix);
            return c.json({ appearance });
          });
        } catch (err) {
          deps.log.error({ err, kind }, 'Failed to remove brand asset');
          return c.json({ error: 'Failed to remove brand asset' }, 500);
        }
      },
    );
  }

  registerUploadRoute('icon');
  registerUploadRoute('banner');

  // Public by design: login and sidebar surfaces need these resources before
  // an authenticated session exists. The filename allowlist is the boundary.
  routes.get('/brand-assets/:filename', async (c) => {
    const filename = c.req.param('filename');
    if (!filename || !BRAND_ASSET_FILENAME_RE.test(filename)) {
      return c.json({ error: 'Invalid filename' }, 400);
    }

    let data: Buffer;
    try {
      data = await fileOps.readFile(path.join(assetsDir, filename));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return c.json({ error: 'Brand asset not found' }, 404);
      }
      deps.log.error({ err, filename }, 'Failed to read brand asset');
      return c.json({ error: 'Failed to read brand asset' }, 500);
    }

    const contentType = filename.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  });

  return routes;
}

export default createBrandAssetRoutes({
  dataDir: DATA_DIR,
  saveAppearance: saveAppearanceConfig,
  auth: authMiddleware,
  requireAdmin: adminRoleMiddleware,
  log: logger,
});
