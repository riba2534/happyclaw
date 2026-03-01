import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  isHostExecutionGroup,
  hasHostExecutionPermission,
  canAccessGroup,
} from '../web-context.js';
import type { AuthUser } from '../types.js';
import type { RegisteredGroup } from '../types.js';
import { getRegisteredGroup } from '../db.js';
import { logger } from '../logger.js';
import {
  listFiles,
  validateAndResolvePath,
  deleteFile,
  createDirectory,
  isSystemPath,
  MAX_FILE_SIZE,
} from '../file-manager.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// MIME 类型映射（预览和编辑端点共用）
const MIME_MAP: Record<string, string> = {
  // 图片
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
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

// 允许 inline 预览的安全 MIME 类型（排除 HTML 和 SVG 以防止 XSS）
const SAFE_PREVIEW_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/markdown',
  'text/css',
  'text/csv',
  'text/yaml',
  'text/x-python',
  'text/x-go',
  'text/x-rust',
  'text/x-java',
  'text/x-c',
  'text/x-c++',
  'text/x-sh',
  'text/x-toml',
  'text/javascript',
  'text/typescript',
  'application/json',
  'application/xml',
  'application/pdf',
]);

/**
 * 获取文件操作的根目录覆盖。
 * 宿主机模式下设置了 customCwd 时，文件面板以 customCwd 为根。
 */
function getFileRootOverride(group: RegisteredGroup): string | undefined {
  return group.executionMode === 'host' && group.customCwd ? group.customCwd : undefined;
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

const fileRoutes = new Hono<{ Variables: Variables }>();

// GET /api/groups/:jid/files?path= - 列出文件
fileRoutes.get('/:jid/files', authMiddleware, (c) => {
  const jid = c.req.param('jid');
  const subPath = c.req.query('path') || '';

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  try {
    const result = listFiles(group.folder, subPath, getFileRootOverride(group));
    return c.json(result);
  } catch (error) {
    logger.error({ err: error }, `Failed to list files for ${jid}`);
    return c.json({ error: 'Failed to list files' }, 500);
  }
});

// POST /api/groups/:jid/files - 上传文件
fileRoutes.post('/:jid/files', authMiddleware, async (c) => {
  const jid = c.req.param('jid');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  const rootOverride = getFileRootOverride(group);

  try {
    const body = await c.req.parseBody({ all: true });
    const targetPath = (typeof body.path === 'string' ? body.path : '') || '';
    const files = body.files;

    if (!files) {
      return c.json({ error: 'No files provided' }, 400);
    }

    // 支持单文件和多文件上传
    const fileList = Array.isArray(files) ? files : [files];
    const uploadedFiles: string[] = [];

    for (const file of fileList) {
      if (!(file instanceof File)) continue;

      // 检查文件大小
      if (file.size > MAX_FILE_SIZE) {
        return c.json(
          { error: `File ${file.name} exceeds maximum size of 50MB` },
          400,
        );
      }

      // 验证文件名，防止路径遍历攻击
      if (file.name.includes('..') || file.name.startsWith('/')) {
        return c.json(
          { error: `Invalid file name: ${file.name}` },
          400,
        );
      }

      // 禁止写入系统路径
      const relativeFilePath = path.join(targetPath, file.name);
      if (isSystemPath(targetPath) || isSystemPath(relativeFilePath)) {
        return c.json({ error: 'Cannot upload to system path' }, 403);
      }

      // 验证目标路径 + 文件名的完整路径（防止 file.name 含 ../../ 绕过）
      const fullRelativePath = path.join(targetPath, file.name);
      const targetFilePath = validateAndResolvePath(
        group.folder,
        fullRelativePath,
        rootOverride,
      );
      const targetDir = path.dirname(targetFilePath);

      // 确保目标目录存在
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      // 写入文件
      const buffer = await file.arrayBuffer();
      fs.writeFileSync(targetFilePath, Buffer.from(buffer));

      uploadedFiles.push(file.name);
    }

    return c.json({ success: true, files: uploadedFiles });
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

  try {
    const body = await c.req.json().catch(() => ({}));
    const targetPath = typeof body.path === 'string' ? body.path : '';
    const absolutePath = validateAndResolvePath(
      group.folder,
      targetPath,
      getFileRootOverride(group),
    );

    if (!fs.existsSync(absolutePath)) {
      return c.json({ error: 'Directory not found' }, 404);
    }

    const stats = fs.statSync(absolutePath);
    const targetDir = stats.isDirectory() ? absolutePath : path.dirname(absolutePath);

    await openDirectoryInFileManager(targetDir);
    return c.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, `Failed to open local directory for ${jid}`);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'NO_FILE_OPENER') {
      return c.json({ error: 'No desktop opener available on server' }, 503);
    }
    const msg = (error as Error).message;
    const safeMessages = ['Path traversal detected', 'Symlink traversal detected'];
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

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  try {
    // 解码 base64url 路径
    const relativePath = Buffer.from(encodedPath, 'base64url').toString(
      'utf-8',
    );
    const absolutePath = validateAndResolvePath(group.folder, relativePath, getFileRootOverride(group));

    if (!fs.existsSync(absolutePath)) {
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

    const stream = Readable.toWeb(fs.createReadStream(absolutePath)) as ReadableStream<Uint8Array>;
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

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  try {
    // 解码 base64url 路径
    const relativePath = Buffer.from(encodedPath, 'base64url').toString(
      'utf-8',
    );
    const absolutePath = validateAndResolvePath(group.folder, relativePath, getFileRootOverride(group));

    if (!fs.existsSync(absolutePath)) {
      return c.json({ error: 'File not found' }, 404);
    }

    const stats = fs.statSync(absolutePath);
    if (stats.isDirectory()) {
      return c.json({ error: 'Cannot preview directory' }, 400);
    }

    // 检测 MIME 类型（基于扩展名）
    const ext = path.extname(absolutePath).slice(1).toLowerCase();
    const mimeType = MIME_MAP[ext] || 'application/octet-stream';

    // 读取文件并返回
    const fileContent = fs.readFileSync(absolutePath);
    const fileName = path.basename(absolutePath);

    // 安全头：始终添加 CSP sandbox 和 nosniff
    c.header('Content-Security-Policy', "default-src 'none'; sandbox");
    c.header('X-Content-Type-Options', 'nosniff');

    if (SAFE_PREVIEW_MIME_TYPES.has(mimeType)) {
      // 安全类型：允许 inline 预览
      c.header('Content-Type', mimeType);
      c.header('Content-Disposition', 'inline');
    } else {
      // 不安全类型（HTML、SVG 等）：强制下载
      c.header('Content-Type', 'application/octet-stream');
      c.header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(fileName)}"`,
      );
    }

    return c.body(fileContent);
  } catch (error) {
    logger.error({ err: error }, `Failed to preview file for ${jid}`);
    return c.json({ error: 'Failed to preview file' }, 500);
  }
});

// GET /api/groups/:jid/files/content/:path - 读取文本文件内容
fileRoutes.get('/:jid/files/content/:path', authMiddleware, (c) => {
  const jid = c.req.param('jid');
  const encodedPath = c.req.param('path');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  try {
    const relativePath = Buffer.from(encodedPath, 'base64url').toString('utf-8');
    const absolutePath = validateAndResolvePath(group.folder, relativePath, getFileRootOverride(group));

    if (!fs.existsSync(absolutePath)) {
      return c.json({ error: 'File not found' }, 404);
    }

    const stats = fs.statSync(absolutePath);
    if (stats.isDirectory()) {
      return c.json({ error: 'Cannot read directory content' }, 400);
    }

    // 仅允许文本文件
    const ext = path.extname(absolutePath).slice(1).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) {
      return c.json({ error: 'File type not supported for content reading' }, 400);
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

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  try {
    const relativePath = Buffer.from(encodedPath, 'base64url').toString('utf-8');

    // 禁止写入系统路径
    if (isSystemPath(relativePath)) {
      return c.json({ error: 'Cannot edit system file' }, 403);
    }

    const absolutePath = validateAndResolvePath(group.folder, relativePath, getFileRootOverride(group));

    if (!fs.existsSync(absolutePath)) {
      return c.json({ error: 'File not found' }, 404);
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

    // 原子写入
    const tmp = `${absolutePath}.tmp`;
    fs.writeFileSync(tmp, body.content, 'utf-8');
    fs.renameSync(tmp, absolutePath);

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

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  try {
    // 解码 base64url 路径
    const relativePath = Buffer.from(encodedPath, 'base64url').toString(
      'utf-8',
    );
    deleteFile(group.folder, relativePath, getFileRootOverride(group));

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

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  try {
    const body = await c.req.json();
    const { path: parentPath, name } = body;

    if (!name || typeof name !== 'string') {
      return c.json({ error: 'Directory name is required' }, 400);
    }

    createDirectory(group.folder, parentPath || '', name, getFileRootOverride(group));

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
