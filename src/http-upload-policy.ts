import { bodyLimit } from 'hono/body-limit';

export const AVATAR_MAX_FILE_BYTES = 3 * 1024 * 1024;
export const SKILL_ARCHIVE_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const BRAND_ASSET_MAX_FILE_BYTES = 3 * 1024 * 1024;

// Multipart boundaries and field metadata add a small amount of overhead on
// top of the file itself. Keep the allowance bounded so chunked uploads are
// stopped before Hono buffers an untrusted request body in memory.
const MULTIPART_OVERHEAD_BYTES = 256 * 1024;

function createUploadBodyLimit(maxFileBytes: number) {
  return bodyLimit({
    maxSize: maxFileBytes + MULTIPART_OVERHEAD_BYTES,
    onError: (c) => c.json({ error: 'Payload too large' }, 413),
  });
}

export const avatarUploadBodyLimit = createUploadBodyLimit(
  AVATAR_MAX_FILE_BYTES,
);
export const skillArchiveUploadBodyLimit = createUploadBodyLimit(
  SKILL_ARCHIVE_MAX_FILE_BYTES,
);
export const brandAssetUploadBodyLimit = createUploadBodyLimit(
  BRAND_ASSET_MAX_FILE_BYTES,
);

// Exported for focused middleware tests with a tiny byte budget.
export const createUploadBodyLimitForTest = createUploadBodyLimit;
