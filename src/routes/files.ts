import { Hono, type Context } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  isHostExecutionGroup,
  hasHostExecutionPermission,
} from '../web-context.js';
import { canAccessGroup } from '../group-acl.js';
import {
  canViewGroup,
  canViewHostGroup,
  isGuestHiddenWorkspacePath,
} from '../guest-access.js';
import type { AuthUser } from '../types.js';
import type { RegisteredGroup } from '../types.js';
import { getRegisteredGroup } from '../db.js';
import {
  resolveWorkspaceProjectRoot,
  workspaceSessionFromQuery,
} from '../session-worktree.js';
import { logger } from '../logger.js';
import {
  listFiles,
  validateAndResolvePath,
  deleteFile,
  createDirectory,
  isSystemPath,
  isEditLockedPath,
  MAX_FILE_SIZE,
  getGroupStorageUsage,
  invalidateGroupStorageUsage,
  getFileRoot,
  safeWriteWorkspaceFile,
} from '../file-manager.js';
import { checkStorageLimit, isBillingEnabled } from '../billing.js';
import { GROUPS_DIR, MAX_FILE_SIZE_MB } from '../config.js';
import { createUploadBodyLimit } from '../http-upload-policy.js';
import { getOfficePreviewPdf, OfficePreviewError } from '../office-preview.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Serialize Web uploads per workspace so two concurrent requests cannot both
// pass a quota check against the same pre-upload usage. The secure write helper
// still revalidates paths descriptor-relatively against non-HTTP writers.
const uploadMutationTails = new Map<string, Promise<void>>();

async function withUploadMutationLock<T>(
  workspaceRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = uploadMutationTails.get(workspaceRoot) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  uploadMutationTails.set(workspaceRoot, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (uploadMutationTails.get(workspaceRoot) === tail) {
      uploadMutationTails.delete(workspaceRoot);
    }
  }
}

function uploadTargetKey(absolutePath: string): string {
  const normalized = path.resolve(absolutePath);
  return process.platform === 'darwin' || process.platform === 'win32'
    ? normalized.toLowerCase()
    : normalized;
}

// MIME 类型映射（预览和编辑端点共用）
const MIME_MAP: Record<string, string> = {
  // 图片
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  // 文本和代码
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  js: 'text/javascript',
  ts: 'text/typescript',
  jsx: 'text/javascript',
  tsx: 'text/typescript',
  css: 'text/css',
  html: 'text/html',
  xml: 'application/xml',
  py: 'text/x-python',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  c: 'text/x-c',
  cpp: 'text/x-c++',
  h: 'text/x-c',
  sh: 'text/x-sh',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/x-toml',
  ini: 'text/plain',
  conf: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  // PDF
  pdf: 'application/pdf',
  // 视频
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  // 音频
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  // 压缩文件
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  '7z': 'application/x-7z-compressed',
};

// 文本文件扩展名（用于编辑端点判断）
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'json',
  'js',
  'ts',
  'jsx',
  'tsx',
  'css',
  'html',
  'xml',
  'py',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'sh',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'log',
  'csv',
  'svg',
]);

// 不安全的扩展名（HTML/SVG 有 XSS 风险，压缩包不可预览）
const UNSAFE_PREVIEW_EXTENSIONS = new Set([
  'html',
  'svg',
  'zip',
  'tar',
  'gz',
  '7z',
]);

// 允许 inline 预览的安全 MIME 类型（从 MIME_MAP 中排除不安全扩展名自动推导）
const SAFE_PREVIEW_MIME_TYPES = new Set(
  Object.entries(MIME_MAP)
    .filter(([ext]) => !UNSAFE_PREVIEW_EXTENSIONS.has(ext))
    .map(([, mime]) => mime),
);

/**
 * 获取文件操作的根目录覆盖：与该会话运行时的工作目录一致。
 * 会话有独立 worktree 时以 worktree 为根；宿主机模式设置了 customCwd 时
 * 以 customCwd 为根；否则为 data/groups/{folder}（返回 undefined）。
 */
function getFileRootOverride(
  group: RegisteredGroup,
  agentId?: string | null,
): string | undefined {
  const root = resolveWorkspaceProjectRoot(group, { agentId });
  return root === path.join(GROUPS_DIR, group.folder) ? undefined : root;
}

/**
 * 计算 Agent 视角的绝对路径（供前端"复制路径"功能使用）。
 * - container 模式：容器内挂载路径 /workspace/group/<relative>
 * - host 模式：宿主机绝对路径（worktree、customCwd 或 data/groups/{folder}）+ relative
 */
function getAgentAbsolutePath(
  group: RegisteredGroup,
  relativePath: string,
  rootOverride: string | undefined,
): string {
  if (group.executionMode === 'host') {
    const base = getFileRoot(group.folder, rootOverride);
    return relativePath ? path.join(base, relativePath) : base;
  }
  return relativePath
    ? path.posix.join('/workspace/group', relativePath)
    : '/workspace/group';
}

function buildAttachmentContentDisposition(fileName: string): string {
  const sanitized = fileName.replace(/["\\\r\n]/g, '_');
  const asciiFallback = sanitized.replace(/[^\x20-\x7E]/g, '_') || 'download';
  const encoded = encodeURIComponent(fileName);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function parseSingleRange(
  rangeHeader: string,
  fileSize: number,
): { start: number; end: number } | null {
  if (fileSize <= 0) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  // Suffix bytes range (e.g. bytes=-500)
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    if (suffixLength >= fileSize) return { start: 0, end: fileSize - 1 };
    return { start: fileSize - suffixLength, end: fileSize - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isInteger(start) || start < 0 || start >= fileSize) return null;

  const parsedEnd = rawEnd ? Number(rawEnd) : fileSize - 1;
  if (!Number.isInteger(parsedEnd) || parsedEnd < start) return null;

  return { start, end: Math.min(parsedEnd, fileSize - 1) };
}

async function openDirectoryInFileManager(targetDir: string): Promise<void> {
  const attempts: Array<{ cmd: string; args: string[] }> = (() => {
    if (process.platform === 'darwin') {
      return [{ cmd: 'open', args: [targetDir] }];
    }
    if (process.platform === 'win32') {
      return [{ cmd: 'explorer', args: [targetDir] }];
    }
    // Linux 桌面环境兼容：优先 xdg-open，失败后回退到常见 opener
    return [
      { cmd: 'xdg-open', args: [targetDir] },
      { cmd: 'gio', args: ['open', targetDir] },
      { cmd: 'kde-open5', args: [targetDir] },
      { cmd: 'kde-open', args: [targetDir] },
    ];
  })();

  const failureCodes: string[] = [];
  for (const attempt of attempts) {
    try {
      await execFileAsync(attempt.cmd, attempt.args, { timeout: 10_000 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 命令不存在：继续尝试下一个 opener
      if (code === 'ENOENT') {
        failureCodes.push(`${attempt.cmd}:ENOENT`);
        continue;
      }
      failureCodes.push(`${attempt.cmd}:${code || 'ERROR'}`);
    }
  }

  const err = new Error('No compatible desktop opener available');
  (err as Error & { code?: string; detail?: string[] }).code = 'NO_FILE_OPENER';
  (err as Error & { code?: string; detail?: string[] }).detail = failureCodes;
  throw err;
}

/**
 * The file root for the session named by `?agentId=` (a Runtime Session of
 * this workspace; absent or `main` is the main session), or a 404.
 */
function resolveRequestFileRoot(
  c: Context<{ Variables: Variables }>,
  jid: string,
  group: RegisteredGroup,
): { rootOverride: string | undefined } | Response {
  const agentId = workspaceSessionFromQuery(c.req.query('agentId'), jid);
  if (agentId === undefined) {
    return c.json({ error: 'Session not found' }, 404);
  }
  return { rootOverride: getFileRootOverride(group, agentId) };
}

/** Names of the symlinks in `dir`, or null when it cannot be read. */
function symlinkNames(dir: string): Set<string> | null {
  try {
    return new Set(
      fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isSymbolicLink())
        .map((entry) => entry.name),
    );
  } catch {
    return null;
  }
}

/** Never hides anything: owners see every file. */
const SHOW_ALL = () => false;

/**
 * Whether a path is hidden from a guest. Checks both the requested relative
 * path and where it really points, so a symlink cannot reach a hidden entry
 * under another name or leave the file root.
 */
function guestPathHider(
  fileRoot: string,
): (relativePath: string, absolutePath: string) => boolean {
  let realRoot: string | undefined;
  return (relativePath, absolutePath) => {
    if (isGuestHiddenWorkspacePath(relativePath)) return true;
    try {
      realRoot ??= fs.realpathSync(fileRoot);
      const rel = path.relative(realRoot, fs.realpathSync(absolutePath));
      if (rel.startsWith('..') || path.isAbsolute(rel)) return true;
      return isGuestHiddenWorkspacePath(rel);
    } catch {
      // Fail closed: a path whose real location cannot be resolved is hidden.
      return true;
    }
  };
}

/**
 * Resolve the group for a file route, or the error response to return.
 * `read` (list/download/preview/content) also admits guests holding an
 * active grant, Host workspaces included, and hands back which paths they
 * may not see; `write` stays owner-only.
 */
function authorizeFileGroup(
  c: Context<{ Variables: Variables }>,
  jid: string,
  mode: 'read' | 'write' = 'write',
):
  | {
      group: RegisteredGroup;
      authUser: AuthUser;
      rootOverride?: string;
      isHidden: (relativePath: string, absolutePath: string) => boolean;
    }
  | Response {
  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  const principal = { id: authUser.id, role: authUser.role };
  const read = mode === 'read';
  if (
    !(read ? canViewGroup(principal, group) : canAccessGroup(principal, group))
  ) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (
    isHostExecutionGroup(group) &&
    !(read
      ? canViewHostGroup(authUser, group)
      : hasHostExecutionPermission(authUser))
  ) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }
  const root = resolveRequestFileRoot(c, jid, group);
  if (root instanceof Response) return root;
  const { rootOverride } = root;
  return {
    group,
    authUser,
    rootOverride,
    isHidden:
      authUser.role === 'guest'
        ? guestPathHider(getFileRoot(group.folder, rootOverride))
        : SHOW_ALL,
  };
}

const fileRoutes = new Hono<{ Variables: Variables }>();

// GET /api/groups/:jid/files?path= - 列出文件
fileRoutes.get('/:jid/files', authMiddleware, (c) => {
  const jid = c.req.param('jid');
  const subPath = c.req.query('path') || '';

  const access = authorizeFileGroup(c, jid, 'read');
  if (access instanceof Response) return access;
  const { group, authUser, rootOverride, isHidden } = access;
  const isGuest = authUser.role === 'guest';
  const fileRoot = getFileRoot(group.folder, rootOverride);
  if (subPath && isHidden(subPath, path.join(fileRoot, subPath))) {
    return c.json({ error: 'File not found' }, 404);
  }

  try {
    const result = listFiles(group.folder, subPath, rootOverride);
    // The listed directory itself passed the real-path check, so only its
    // symlinks can point elsewhere; every other entry is judged by its name.
    const links = isGuest
      ? symlinkNames(path.join(fileRoot, subPath))
      : undefined;
    const files = result.files
      .filter(
        (entry) =>
          !isGuest ||
          !(
            isGuestHiddenWorkspacePath(entry.path) ||
            ((!links || links.has(entry.name)) &&
              isHidden(entry.path, path.join(fileRoot, entry.path)))
          ),
      )
      .map((entry) => ({
        ...entry,
        // Guests do not need (and should not learn) host filesystem paths.
        absolutePath: isGuest
          ? undefined
          : getAgentAbsolutePath(group, entry.path, rootOverride),
      }));
    return c.json({ ...result, files });
  } catch (error) {
    logger.error({ err: error }, `Failed to list files for ${jid}`);
    return c.json({ error: 'Failed to list files' }, 500);
  }
});

// The web client uploads one file per request, so cap the multipart body at
// MAX_FILE_SIZE plus overhead before parseBody() buffers it in memory.
const uploadBodyLimit = createUploadBodyLimit(MAX_FILE_SIZE);

// POST /api/groups/:jid/files - 上传文件
fileRoutes.post('/:jid/files', authMiddleware, uploadBodyLimit, async (c) => {
  const jid = c.req.param('jid');

  const access = authorizeFileGroup(c, jid);
  if (access instanceof Response) return access;
  const { group, authUser, rootOverride } = access;

  try {
    const body = await c.req.parseBody({ all: true });
    const targetPath = (typeof body.path === 'string' ? body.path : '') || '';
    const files = body.files;

    if (!files) {
      return c.json({ error: 'No files provided' }, 400);
    }

    // 支持单文件和多文件上传。锁内先验证整批并计算最终净增量，再开始写入：
    // 配额拒绝或后续文件路径非法时，不会留下半批文件。
    const fileList = Array.isArray(files) ? files : [files];
    const workspaceRoot = path.resolve(getFileRoot(group.folder, rootOverride));

    if (!fs.existsSync(workspaceRoot)) {
      logger.error(
        { jid, folder: group.folder, workspaceRoot },
        'Workspace directory missing on disk during upload',
      );
      return c.json(
        {
          error:
            'Workspace directory not initialized yet. Please try again in a moment, or re-login and retry.',
        },
        409,
      );
    }

    return await withUploadMutationLock(workspaceRoot, async () => {
      const uploads: Array<{ file: File; relativePath: string }> = [];
      const quotaTargets = new Map<
        string,
        { existingSize: number; finalSize: number }
      >();

      for (const file of fileList) {
        if (!(file instanceof File)) continue;

        if (file.size > MAX_FILE_SIZE) {
          return c.json(
            {
              error: `File ${file.name} exceeds maximum size of ${MAX_FILE_SIZE_MB}MB`,
            },
            400,
          );
        }

        // 保留原有文件名、系统路径与 symlink 防护；配额只能在这些验证之后计算。
        if (file.name.includes('..') || file.name.startsWith('/')) {
          return c.json({ error: `Invalid file name: ${file.name}` }, 400);
        }

        const fullRelativePath = path.join(targetPath, file.name);
        if (isSystemPath(targetPath) || isSystemPath(fullRelativePath)) {
          return c.json({ error: 'Cannot upload to system path' }, 403);
        }

        const absolutePath = validateAndResolvePath(
          group.folder,
          fullRelativePath,
          rootOverride,
        );
        let existingSize = 0;
        try {
          const stats = fs.lstatSync(absolutePath);
          if (stats.isSymbolicLink()) {
            return c.json({ error: 'Cannot overwrite symbolic link' }, 403);
          }
          if (!stats.isFile()) {
            return c.json(
              { error: `Upload target is not a regular file: ${file.name}` },
              400,
            );
          }
          existingSize = stats.size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }

        uploads.push({ file, relativePath: fullRelativePath });
        const key = uploadTargetKey(absolutePath);
        const prior = quotaTargets.get(key);
        quotaTargets.set(key, {
          // Repeated names in one multipart batch replace the same original
          // inode; charge only the size of the final value, never each part.
          existingSize: prior?.existingSize ?? existingSize,
          finalSize: file.size,
        });
      }

      if (isBillingEnabled() && group.created_by) {
        const totalDelta = Array.from(quotaTargets.values()).reduce(
          (sum, target) => sum + target.finalSize - target.existingSize,
          0,
        );
        const additionalBytes = Math.max(0, totalDelta);
        if (additionalBytes > 0) {
          const currentUsage = getGroupStorageUsage(group.folder, rootOverride);
          const storageCheck = checkStorageLimit(
            group.created_by,
            authUser.role,
            currentUsage,
            additionalBytes,
          );
          if (!storageCheck.allowed) {
            return c.json({ error: storageCheck.reason }, 403);
          }
        }
      }

      const uploadedFiles: string[] = [];
      let wroteAnyFile = false;
      try {
        for (const { file, relativePath } of uploads) {
          const data = Buffer.from(await file.arrayBuffer());
          safeWriteWorkspaceFile(
            group.folder,
            relativePath,
            data,
            { mustExist: false, createParents: true },
            rootOverride,
          );
          wroteAnyFile = true;
          uploadedFiles.push(file.name);
        }
      } finally {
        // The batch is not transactional: if a later read/write fails, earlier
        // files remain on disk. Never leave the pre-upload quota snapshot cached.
        if (wroteAnyFile) {
          invalidateGroupStorageUsage(group.folder, rootOverride);
        }
      }

      return c.json({ success: true, files: uploadedFiles });
    });
  } catch (error) {
    logger.error({ err: error }, `Failed to upload files for ${jid}`);
    return c.json({ error: 'Failed to upload files' }, 500);
  }
});

// POST /api/groups/:jid/files/open-directory - 在本地文件管理器中打开目录
fileRoutes.post('/:jid/files/open-directory', authMiddleware, async (c) => {
  const jid = c.req.param('jid');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  // 打开本地目录属于宿主机操作，限制为有宿主机权限的用户
  if (!hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions to open local directory' },
      403,
    );
  }

  const root = resolveRequestFileRoot(c, jid, group);
  if (root instanceof Response) return root;

  try {
    const body = await c.req.json().catch(() => ({}));
    const targetPath = typeof body.path === 'string' ? body.path : '';
    const absolutePath = validateAndResolvePath(
      group.folder,
      targetPath,
      root.rootOverride,
    );

    if (!fs.existsSync(absolutePath)) {
      return c.json({ error: 'Directory not found' }, 404);
    }

    const stats = fs.statSync(absolutePath);
    const targetDir = stats.isDirectory()
      ? absolutePath
      : path.dirname(absolutePath);

    await openDirectoryInFileManager(targetDir);
    return c.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, `Failed to open local directory for ${jid}`);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'NO_FILE_OPENER') {
      return c.json({ error: 'No desktop opener available on server' }, 503);
    }
    const msg = (error as Error).message;
    const safeMessages = [
      'Path traversal detected',
      'Symlink traversal detected',
    ];
    const publicMsg = safeMessages.includes(msg)
      ? msg
      : 'Failed to open local directory';
    const status = safeMessages.includes(msg) ? 400 : 500;
    return c.json({ error: publicMsg }, status);
  }
});

// GET /api/groups/:jid/files/download/:path - 下载文件
fileRoutes.get('/:jid/files/download/:path', authMiddleware, (c) => {
  const jid = c.req.param('jid');
  const encodedPath = c.req.param('path');

  const access = authorizeFileGroup(c, jid, 'read');
  if (access instanceof Response) return access;
  const { group, rootOverride, isHidden } = access;

  try {
    // 解码 base64url 路径
    const relativePath = Buffer.from(encodedPath, 'base64url').toString(
      'utf-8',
    );
    const absolutePath = validateAndResolvePath(
      group.folder,
      relativePath,
      rootOverride,
    );

    if (!fs.existsSync(absolutePath) || isHidden(relativePath, absolutePath)) {
      return c.json({ error: 'File not found' }, 404);
    }

    const stats = fs.statSync(absolutePath);
    if (stats.isDirectory()) {
      return c.json({ error: 'Cannot download directory' }, 400);
    }

    const fileName = path.basename(absolutePath);
    const fileSize = stats.size;
    const commonHeaders = {
      'Content-Disposition': buildAttachmentContentDisposition(fileName),
      'Content-Type': 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Accept-Ranges': 'bytes',
    };

    const rangeHeader = c.req.header('range');
    if (rangeHeader) {
      const normalizedRange = rangeHeader.trim();
      const isBytesRange = normalizedRange.toLowerCase().startsWith('bytes=');
      const isMultiRange = isBytesRange && normalizedRange.includes(',');

      // 多区间请求当前未实现 multipart/byteranges，回退为完整下载响应
      if (isBytesRange && !isMultiRange) {
        const parsedRange = parseSingleRange(normalizedRange, fileSize);
        if (!parsedRange) {
          return new Response(null, {
            status: 416,
            headers: {
              ...commonHeaders,
              'Content-Range': `bytes */${fileSize}`,
            },
          });
        }

        const { start, end } = parsedRange;
        const stream = Readable.toWeb(
          fs.createReadStream(absolutePath, { start, end }),
        ) as ReadableStream<Uint8Array>;
        return new Response(stream, {
          status: 206,
          headers: {
            ...commonHeaders,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          },
        });
      }
    }

    const stream = Readable.toWeb(
      fs.createReadStream(absolutePath),
    ) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: 200,
      headers: {
        ...commonHeaders,
        'Content-Length': String(fileSize),
      },
    });
  } catch (error) {
    logger.error({ err: error }, `Failed to download file for ${jid}`);
    return c.json({ error: 'Failed to download file' }, 500);
  }
});

// GET /api/groups/:jid/files/preview/:path - 预览文件
fileRoutes.get('/:jid/files/preview/:path', authMiddleware, (c) => {
  const jid = c.req.param('jid');
  const encodedPath = c.req.param('path');

  const access = authorizeFileGroup(c, jid, 'read');
  if (access instanceof Response) return access;
  const { group, rootOverride, isHidden } = access;

  try {
    // 解码 base64url 路径
    const relativePath = Buffer.from(encodedPath, 'base64url').toString(
      'utf-8',
    );
    const absolutePath = validateAndResolvePath(
      group.folder,
      relativePath,
      rootOverride,
    );

    if (!fs.existsSync(absolutePath) || isHidden(relativePath, absolutePath)) {
      return c.json({ error: 'File not found' }, 404);
    }

    const stats = fs.statSync(absolutePath);
    if (stats.isDirectory()) {
      return c.json({ error: 'Cannot preview directory' }, 400);
    }

    // 检测 MIME 类型（基于扩展名）
    const ext = path.extname(absolutePath).slice(1).toLowerCase();
    const mimeType = MIME_MAP[ext] || 'application/octet-stream';
    const fileName = path.basename(absolutePath);
    const fileSize = stats.size;

    // 判断是否为流媒体类型（视频/音频），需支持 Range 请求
    const isStreamable =
      mimeType.startsWith('video/') || mimeType.startsWith('audio/');

    // 安全头
    const securityHeaders: Record<string, string> = {
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    };

    // Content-Type 和 Content-Disposition
    let contentType: string;
    let disposition: string;
    if (SAFE_PREVIEW_MIME_TYPES.has(mimeType)) {
      contentType = mimeType;
      disposition = 'inline';
    } else {
      contentType = 'application/octet-stream';
      disposition = `attachment; filename="${encodeURIComponent(fileName)}"`;
    }

    // 预览经公网链路往返很慢：用大小+修改时间做 ETag，浏览器 5 分钟内直接用缓存，
    // 之后带 If-None-Match 重新验证，没变就回 304、不再传整个文件。
    const etag = `W/"${fileSize.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
    const commonHeaders = {
      ...securityHeaders,
      'Content-Type': contentType,
      'Content-Disposition': disposition,
      'Cache-Control': 'private, max-age=300',
      ETag: etag,
      'Last-Modified': stats.mtime.toUTCString(),
    };
    const ifNoneMatch = c.req.header('if-none-match');
    if (
      ifNoneMatch &&
      ifNoneMatch.split(',').some((tag) => tag.trim() === etag)
    ) {
      return new Response(null, { status: 304, headers: commonHeaders });
    }

    // 流媒体类型：支持 Range 请求（浏览器 <video>/<audio> seek 依赖此机制）
    if (isStreamable) {
      const rangeHeader = c.req.header('range');
      if (rangeHeader) {
        const normalizedRange = rangeHeader.trim();
        const isBytesRange = normalizedRange.toLowerCase().startsWith('bytes=');
        const isMultiRange = isBytesRange && normalizedRange.includes(',');

        if (isBytesRange && !isMultiRange) {
          const parsedRange = parseSingleRange(normalizedRange, fileSize);
          if (!parsedRange) {
            return new Response(null, {
              status: 416,
              headers: {
                ...commonHeaders,
                'Content-Range': `bytes */${fileSize}`,
              },
            });
          }

          const { start, end } = parsedRange;
          const stream = Readable.toWeb(
            fs.createReadStream(absolutePath, { start, end }),
          ) as ReadableStream<Uint8Array>;
          return new Response(stream, {
            status: 206,
            headers: {
              ...commonHeaders,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(end - start + 1),
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            },
          });
        }
      }

      // 无 Range 或多区间回退：流式返回完整文件
      const stream = Readable.toWeb(
        fs.createReadStream(absolutePath),
      ) as ReadableStream<Uint8Array>;
      return new Response(stream, {
        status: 200,
        headers: {
          ...commonHeaders,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(fileSize),
        },
      });
    }

    // 非流媒体类型：也使用流式响应避免大文件占满内存
    const stream = Readable.toWeb(
      fs.createReadStream(absolutePath),
    ) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: 200,
      headers: {
        ...commonHeaders,
        'Content-Length': String(fileSize),
      },
    });
  } catch (error) {
    logger.error({ err: error }, `Failed to preview file for ${jid}`);
    return c.json({ error: 'Failed to preview file' }, 500);
  }
});

// GET /api/groups/:jid/files/office-preview/:path - Office 文件转 PDF 预览
fileRoutes.get(
  '/:jid/files/office-preview/:path',
  authMiddleware,
  async (c) => {
    const jid = c.req.param('jid');
    const encodedPath = c.req.param('path');

    const access = authorizeFileGroup(c, jid);
    if (access instanceof Response) return access;
    const { group } = access;

    try {
      const relativePath = Buffer.from(encodedPath, 'base64url').toString(
        'utf-8',
      );
      const absolutePath = validateAndResolvePath(
        group.folder,
        relativePath,
        getFileRootOverride(group),
      );

      if (!fs.existsSync(absolutePath)) {
        return c.json({ error: 'File not found' }, 404);
      }
      const stats = fs.statSync(absolutePath);
      if (stats.isDirectory()) {
        return c.json({ error: 'Cannot preview directory' }, 400);
      }

      const { pdfPath, cacheHit } = await getOfficePreviewPdf(absolutePath);
      const stream = Readable.toWeb(
        fs.createReadStream(pdfPath),
      ) as ReadableStream<Uint8Array>;
      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'inline',
          'Content-Length': String(fs.statSync(pdfPath).size),
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'X-Content-Type-Options': 'nosniff',
          'X-Office-Preview-Cache': cacheHit ? 'hit' : 'miss',
        },
      });
    } catch (error) {
      if (error instanceof OfficePreviewError) {
        return c.json(
          { error: error.message, code: error.code },
          error.status as 400 | 413 | 501 | 502 | 504,
        );
      }
      logger.error({ err: error }, `Failed to build office preview for ${jid}`);
      return c.json({ error: 'Failed to build office preview' }, 500);
    }
  },
);

// GET /api/groups/:jid/files/content/:path - 读取文本文件内容
fileRoutes.get('/:jid/files/content/:path', authMiddleware, (c) => {
  const jid = c.req.param('jid');
  const encodedPath = c.req.param('path');

  const access = authorizeFileGroup(c, jid, 'read');
  if (access instanceof Response) return access;
  const { group, rootOverride, isHidden } = access;

  try {
    const relativePath = Buffer.from(encodedPath, 'base64url').toString(
      'utf-8',
    );
    const absolutePath = validateAndResolvePath(
      group.folder,
      relativePath,
      rootOverride,
    );

    if (!fs.existsSync(absolutePath) || isHidden(relativePath, absolutePath)) {
      return c.json({ error: 'File not found' }, 404);
    }

    const stats = fs.statSync(absolutePath);
    if (stats.isDirectory()) {
      return c.json({ error: 'Cannot read directory content' }, 400);
    }

    // 仅允许文本文件
    const ext = path.extname(absolutePath).slice(1).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) {
      return c.json(
        { error: 'File type not supported for content reading' },
        400,
      );
    }

    // 限制文件大小（10MB）
    if (stats.size > 10 * 1024 * 1024) {
      return c.json({ error: 'File too large to read (max 10MB)' }, 400);
    }

    const content = fs.readFileSync(absolutePath, 'utf-8');
    return c.json({ content, size: stats.size });
  } catch (error) {
    logger.error({ err: error }, `Failed to read file content for ${jid}`);
    return c.json({ error: 'Failed to read file content' }, 500);
  }
});

// PUT /api/groups/:jid/files/content/:path - 保存文本文件内容
fileRoutes.put('/:jid/files/content/:path', authMiddleware, async (c) => {
  const jid = c.req.param('jid');
  const encodedPath = c.req.param('path');

  const access = authorizeFileGroup(c, jid);
  if (access instanceof Response) return access;
  const { group, authUser, rootOverride } = access;

  try {
    const relativePath = Buffer.from(encodedPath, 'base64url').toString(
      'utf-8',
    );

    // 禁止写入系统路径（CLAUDE.md 等例外仍可编辑内容，删除/覆盖上传照旧禁止）
    if (isEditLockedPath(relativePath)) {
      return c.json({ error: 'Cannot edit system file' }, 403);
    }

    const absolutePath = validateAndResolvePath(
      group.folder,
      relativePath,
      rootOverride,
    );

    if (!fs.existsSync(absolutePath)) {
      return c.json({ error: 'File not found' }, 404);
    }

    const stats = fs.statSync(absolutePath);
    if (stats.isDirectory()) {
      return c.json({ error: 'Cannot edit directory content' }, 400);
    }

    // 仅允许文本文件
    const ext = path.extname(absolutePath).slice(1).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) {
      return c.json({ error: 'File type not supported for editing' }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    if (typeof body.content !== 'string') {
      return c.json({ error: 'Content field is required' }, 400);
    }

    // 限制内容大小（10MB）
    if (Buffer.byteLength(body.content, 'utf-8') > 10 * 1024 * 1024) {
      return c.json({ error: 'Content too large (max 10MB)' }, 400);
    }

    if (isBillingEnabled() && group.created_by) {
      const nextSize = Buffer.byteLength(body.content, 'utf-8');
      const additionalBytes = Math.max(0, nextSize - stats.size);
      if (additionalBytes > 0) {
        const currentUsage = getGroupStorageUsage(group.folder, rootOverride);
        const storageCheck = checkStorageLimit(
          group.created_by,
          authUser.role,
          currentUsage,
          additionalBytes,
        );
        if (!storageCheck.allowed) {
          return c.json({ error: storageCheck.reason }, 403);
        }
      }
    }

    // The helper performs descriptor-relative openat/renameat traversal, so a
    // concurrent Agent cannot replace an ancestor with an external symlink in
    // the await window above and redirect this host write outside the workspace.
    safeWriteWorkspaceFile(
      group.folder,
      relativePath,
      Buffer.from(body.content, 'utf-8'),
      { mustExist: true, createParents: false },
      rootOverride,
    );

    invalidateGroupStorageUsage(group.folder, rootOverride);
    return c.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, `Failed to save file content for ${jid}`);
    return c.json({ error: 'Failed to save file content' }, 500);
  }
});

// DELETE /api/groups/:jid/files/:path - 删除文件
fileRoutes.delete('/:jid/files/:path', authMiddleware, (c) => {
  const jid = c.req.param('jid');
  const encodedPath = c.req.param('path');

  const access = authorizeFileGroup(c, jid);
  if (access instanceof Response) return access;
  const { group, rootOverride } = access;

  try {
    // 解码 base64url 路径
    const relativePath = Buffer.from(encodedPath, 'base64url').toString(
      'utf-8',
    );
    deleteFile(group.folder, relativePath, rootOverride);
    invalidateGroupStorageUsage(group.folder, rootOverride);

    return c.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, `Failed to delete file for ${jid}`);
    const msg = (error as Error).message;
    // Only expose known safe error messages, not internal paths
    const safeMessages = [
      'Cannot delete system path',
      'Cannot delete root directory',
      'File or directory not found',
      'Path traversal detected',
      'Symlink traversal detected',
    ];
    const publicMsg = safeMessages.includes(msg)
      ? msg
      : 'Failed to delete file';
    return c.json({ error: publicMsg }, 400);
  }
});

// POST /api/groups/:jid/directories - 创建目录
fileRoutes.post('/:jid/directories', authMiddleware, async (c) => {
  const jid = c.req.param('jid');

  const access = authorizeFileGroup(c, jid);
  if (access instanceof Response) return access;
  const { group, rootOverride } = access;

  try {
    const body = await c.req.json();
    const { path: parentPath, name } = body;

    if (!name || typeof name !== 'string') {
      return c.json({ error: 'Directory name is required' }, 400);
    }

    createDirectory(group.folder, parentPath || '', name, rootOverride);

    return c.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, `Failed to create directory for ${jid}`);
    const msg = (error as Error).message;
    const safeMessages = [
      'Cannot create system path',
      'Cannot create root directory',
      'Directory already exists',
      'Path traversal detected',
      'Symlink traversal detected',
      'Directory name is required',
      'Invalid directory name',
    ];
    const publicMsg = safeMessages.includes(msg)
      ? msg
      : 'Failed to create directory';
    return c.json({ error: publicMsg }, 400);
  }
});

export default fileRoutes;
