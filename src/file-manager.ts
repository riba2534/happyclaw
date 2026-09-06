import path from 'path';
import fs from 'fs';
import { spawn, spawnSync } from 'child_process';
import { PassThrough, Readable } from 'stream';
import { fileURLToPath } from 'url';
import { DATA_DIR, GROUPS_DIR, MAX_FILE_SIZE } from './config.js';
import { deleteContainerEnvConfig } from './runtime-config.js';
import { logger } from './logger.js';

// --- Storage usage cache (5 minute TTL) ---
const _storageCache = new Map<string, { bytes: number; expires: number }>();
const STORAGE_CACHE_TTL = 5 * 60 * 1000;

function getStorageCacheKey(folder: string, rootOverride?: string): string {
  return getFileRoot(folder, rootOverride);
}

// 类型
export interface FileEntry {
  name: string;
  path: string; // 相对于 data/groups/{folder}/ 的路径
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
  isSystem: boolean;
  /**
   * 是否允许通过 Web 编辑内容。系统文件默认为 false，但 EDITABLE_SYSTEM_PATHS
   * 中的例外（工作区 CLAUDE.md）仍可编辑——它受保护是为了防删除/覆盖上传，
   * 不是为了禁止用户维护自己的工作区指令。
   */
  editable: boolean;
  absolutePath?: string; // Agent 视角的绝对路径（container 模式为 /workspace/group/...，host 模式为宿主机路径）
}

// 常量
// MAX_FILE_SIZE 统一由 config.ts 定义（可通过 MAX_FILE_SIZE_MB 环境变量配置），
// 此处 re-export 保持既有 import 路径不变。
export { MAX_FILE_SIZE };
const SYSTEM_PATHS = ['logs', 'CLAUDE.md', '.claude', 'conversations'];
// 预先转小写一次，匹配大小写不敏感文件系统（macOS APFS / Windows NTFS）。
const SYSTEM_PATHS_LOWER = SYSTEM_PATHS.map((p) => p.toLowerCase());

// 系统路径中允许编辑内容的例外。工作区根部的 CLAUDE.md 是用户自己维护的项目
// 指令文件（早期由已下线的文件式记忆模块提供编辑入口，那个入口消失后编辑能力
// 一并丢失）。它继续留在 SYSTEM_PATHS 中以保留「禁删除、禁覆盖上传」保护。
const EDITABLE_SYSTEM_PATHS = ['CLAUDE.md'];
const EDITABLE_SYSTEM_PATHS_LOWER = EDITABLE_SYSTEM_PATHS.map((p) =>
  p.toLowerCase(),
);

// 仅在大小写不敏感的平台启用 lowercased 比较。case-sensitive Linux 上
// 'Logs/' 与 'logs/' 是不同 inode，全局 toLowerCase 会误杀合法文件名。
// macOS / Windows 默认大小写不敏感（APFS / NTFS）→ 使用 lowercased 路径。
// 其它平台保留 strict ===。
const CASE_INSENSITIVE_FS =
  process.platform === 'darwin' || process.platform === 'win32';

const SAFE_WORKSPACE_FS_HELPER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scripts/safe-workspace-fs.py',
);

interface SafeWorkspaceMutationRequest {
  operation: 'write_file' | 'mkdir' | 'delete';
  root: string;
  path: string;
  dataBase64?: string;
  mustExist?: boolean;
  createParents?: boolean;
}

function runSafeWorkspaceMutation(request: SafeWorkspaceMutationRequest): void {
  if (process.platform === 'win32') {
    // Windows does not expose POSIX dir_fd/openat through its Python runtime.
    // Preserve the existing no-follow/revalidation behavior there; creating
    // symlinks/junctions already requires a privileged principal. Unix hosts,
    // including production macOS, use the descriptor-relative helper below.
    const root = path.resolve(request.root);
    const target = path.resolve(root, request.path);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Path traversal detected');
    }
    const verifyInsideRoot = (candidate: string): void => {
      let existing = candidate;
      while (!fs.existsSync(existing) && existing !== root) {
        existing = path.dirname(existing);
      }
      const realRoot = fs.realpathSync(root);
      const realExisting = fs.realpathSync(existing);
      if (
        realExisting !== realRoot &&
        !realExisting.startsWith(`${realRoot}${path.sep}`)
      ) {
        throw new Error('Symlink traversal detected');
      }
    };
    verifyInsideRoot(target);
    if (request.operation === 'mkdir') {
      if (fs.existsSync(target)) throw new Error('Directory already exists');
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      return;
    }
    if (request.operation === 'delete') {
      if (!fs.existsSync(target))
        throw new Error('File or directory not found');
      verifyInsideRoot(target);
      const info = fs.lstatSync(target);
      if (info.isSymbolicLink()) throw new Error('Symlink traversal detected');
      if (info.isDirectory()) fs.rmSync(target, { recursive: true });
      else fs.unlinkSync(target);
      return;
    }
    const parent = path.dirname(target);
    if (request.createParents) fs.mkdirSync(parent, { recursive: true });
    if (request.mustExist && !fs.existsSync(target)) {
      throw new Error('File not found');
    }
    verifyInsideRoot(target);
    let existingMode: number | undefined;
    if (fs.existsSync(target)) {
      const existing = fs.lstatSync(target);
      if (existing.isSymbolicLink()) {
        throw new Error('Refusing to overwrite symbolic link');
      }
      if (!existing.isFile()) {
        throw new Error('Target is not a regular file');
      }
      existingMode = existing.mode & 0o700;
    }
    const temporary = `${target}.happyclaw-${process.pid}-${Date.now()}.tmp`;
    try {
      fs.writeFileSync(
        temporary,
        Buffer.from(request.dataBase64 || '', 'base64'),
        { flag: 'wx', mode: existingMode ?? 0o644 },
      );
      fs.renameSync(temporary, target);
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // already renamed or never created
      }
    }
    return;
  }
  const python =
    process.env.HAPPYCLAW_PYTHON3?.trim() ||
    process.env.PYTHON3?.trim() ||
    'python3';
  const result = spawnSync(python, [SAFE_WORKSPACE_FS_HELPER], {
    input: JSON.stringify(request),
    encoding: 'utf-8',
    maxBuffer: 2 * 1024 * 1024,
  });
  let response: { ok?: boolean; error?: string } | undefined;
  try {
    response = JSON.parse(result.stdout.trim()) as {
      ok?: boolean;
      error?: string;
    };
  } catch {
    response = undefined;
  }
  if (result.status !== 0 || response?.ok !== true) {
    throw new Error(
      response?.error ||
        (result.error
          ? 'Secure workspace mutation helper is unavailable'
          : 'Secure workspace mutation failed'),
    );
  }
}

/** Atomically replace/create a file through descriptor-relative openat calls. */
export function safeWriteWorkspaceFile(
  folder: string,
  relativePath: string,
  data: Buffer,
  options: { mustExist: boolean; createParents: boolean },
  rootOverride?: string,
): void {
  runSafeWorkspaceMutation({
    operation: 'write_file',
    root: fs.realpathSync(getFileRoot(folder, rootOverride)),
    path: relativePath,
    dataBase64: data.toString('base64'),
    mustExist: options.mustExist,
    createParents: options.createParents,
  });
}

export function safeDeleteWorkspaceEntry(
  folder: string,
  relativePath: string,
  rootOverride?: string,
): void {
  runSafeWorkspaceMutation({
    operation: 'delete',
    root: fs.realpathSync(getFileRoot(folder, rootOverride)),
    path: relativePath,
  });
}

export function safeCreateWorkspaceDirectory(
  folder: string,
  relativePath: string,
  rootOverride?: string,
): void {
  runSafeWorkspaceMutation({
    operation: 'mkdir',
    root: fs.realpathSync(getFileRoot(folder, rootOverride)),
    path: relativePath,
  });
}

export interface SafeWorkspaceReadResult {
  size: number;
  mtimeMs: number;
  isRangeRequest: boolean;
  rangeSatisfiable?: boolean;
  start?: number;
  end?: number;
  contentLength: number;
  stream: ReadableStream<Uint8Array>;
  destroy: () => void;
  processPid?: number;
}

export async function safeOpenWorkspaceReadStream(
  folder: string,
  relativePath: string,
  options?: {
    rootOverride?: string;
    rangeHeader?: string;
    maxBytes?: number;
  },
): Promise<SafeWorkspaceReadResult> {
  const rootPath = getFileRoot(folder, options?.rootOverride);
  if (!fs.existsSync(rootPath)) {
    throw new Error('File not found');
  }
  const root = fs.realpathSync(rootPath);

  if (process.platform === 'win32') {
    // Windows does not expose POSIX openat(dir_fd) in standard runtime;
    // fail closed rather than providing a false sense of security with TOCTOU.
    throw new Error(
      'Descriptor-relative safe file open is unsupported on Windows; rejecting to prevent TOCTOU',
    );
  }

  const python =
    process.env.HAPPYCLAW_PYTHON3?.trim() ||
    process.env.PYTHON3?.trim() ||
    'python3';

  const request = {
    operation: 'read_file',
    root,
    path: relativePath,
    rangeHeader: options?.rangeHeader,
    maxBytes: options?.maxBytes,
  };

  return new Promise((resolve, reject) => {
    const child = spawn(python, [SAFE_WORKSPACE_FS_HELPER], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderrBuffer = '';
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
    });

    child.stdin.on('error', () => {
      // 避免子进程快速退出引发未捕获的 EPIPE
    });

    let settled = false;
    let accumulated = Buffer.alloc(0);

    const onHeaderFailure = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {}
      reject(err);
    };

    child.on('error', (err) => {
      onHeaderFailure(
        new Error(`Failed to launch safe read helper: ${err.message}`),
      );
    });

    child.on('close', () => {
      if (!settled) {
        let errorMsg = 'Safe read helper exited before header';
        try {
          const parsed = JSON.parse(accumulated.toString('utf-8'));
          if (parsed && parsed.error) errorMsg = parsed.error;
        } catch {
          if (stderrBuffer.trim()) errorMsg = stderrBuffer.trim();
        }
        onHeaderFailure(new Error(errorMsg));
      }
    });

    child.stdout.on('data', function onHeaderChunk(chunk: Buffer) {
      if (!settled) {
        accumulated = Buffer.concat([accumulated, chunk]);
        const newlineIndex = accumulated.indexOf(0x0a);
        if (newlineIndex !== -1) {
          child.stdout.removeListener('data', onHeaderChunk);
          const headerRaw = accumulated
            .subarray(0, newlineIndex)
            .toString('utf-8');
          const remainder = accumulated.subarray(newlineIndex + 1);

          let header: any;
          try {
            header = JSON.parse(headerRaw);
          } catch {
            onHeaderFailure(
              new Error(`Invalid header from safe read helper: ${headerRaw}`),
            );
            return;
          }

          if (!header.ok) {
            onHeaderFailure(new Error(header.error || 'Safe read failed'));
            return;
          }

          settled = true;

          const passThrough = new PassThrough();
          let isDestroyed = false;
          const destroy = () => {
            if (!isDestroyed) {
              isDestroyed = true;
              child.stdout.removeAllListeners();
              try {
                child.stdin.destroy();
              } catch {}
              try {
                child.kill('SIGTERM');
              } catch {}
              // 50ms 兜底强杀，确保子进程生命周期绝对与流取消连通
              setTimeout(() => {
                try {
                  if (child.exitCode === null && child.signalCode === null) {
                    child.kill('SIGKILL');
                  }
                } catch {}
              }, 50).unref?.();
              passThrough.destroy();
            }
          };

          passThrough.on('close', () => destroy());
          passThrough.on('error', () => destroy());

          if (header.isRangeRequest && header.rangeSatisfiable === false) {
            destroy();
            resolve({
              size: header.size,
              mtimeMs: header.mtimeMs,
              isRangeRequest: true,
              rangeSatisfiable: false,
              contentLength: 0,
              stream: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.close();
                },
              }),
              destroy,
            });
            return;
          }

          let receivedBytes = remainder.length;

          if (remainder.length > 0) {
            passThrough.write(remainder);
          }

          child.stdout.on('data', (dataChunk: Buffer) => {
            receivedBytes += dataChunk.length;
          });

          // 关键安全保证：阻止 child.stdout 自动结束 passThrough，
          // 防止 Node 管道自动 EOF 早于 child close 非0到达从而掩盖并发截断异常
          child.stdout.pipe(passThrough, { end: false });

          let finalized = false;
          const finalize = (
            code: number | null,
            signal: NodeJS.Signals | null,
          ) => {
            if (finalized) return;
            finalized = true;

            if (code !== 0 && code !== null && signal !== 'SIGTERM') {
              passThrough.destroy(
                new Error(
                  `Safe read helper exited unexpectedly with code ${code}${
                    stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : ''
                  }`,
                ),
              );
              return;
            }

            if (receivedBytes < header.contentLength) {
              passThrough.destroy(
                new Error(
                  `Truncated stream: received ${receivedBytes} of ${header.contentLength} bytes`,
                ),
              );
              return;
            }

            passThrough.end();
          };

          child.on('close', (code, signal) => {
            finalize(code, signal);
          });

          child.on('error', (err) => {
            if (!finalized) {
              finalized = true;
              passThrough.destroy(err);
            }
          });

          const baseWebStream = Readable.toWeb(
            passThrough,
          ) as ReadableStream<Uint8Array>;

          let streamReader: ReadableStreamDefaultReader<Uint8Array> | null =
            null;
          const cancellableWebStream = new ReadableStream<Uint8Array>({
            start(controller) {
              const reader = baseWebStream.getReader();
              streamReader = reader;
              function pump(): void {
                reader
                  .read()
                  .then(({ done, value }) => {
                    if (done) {
                      try {
                        controller.close();
                      } catch {}
                      return;
                    }
                    controller.enqueue(value);
                    pump();
                  })
                  .catch((err) => {
                    destroy();
                    try {
                      controller.error(err);
                    } catch {}
                  });
              }
              pump();
            },
            cancel(reason) {
              destroy();
              if (streamReader) {
                return streamReader.cancel(reason).catch(() => {});
              }
              return Promise.resolve();
            },
          });

          resolve({
            size: header.size,
            mtimeMs: header.mtimeMs,
            isRangeRequest: !!header.isRangeRequest,
            rangeSatisfiable: true,
            start: header.start,
            end: header.end,
            contentLength: header.contentLength,
            stream: cancellableWebStream,
            destroy,
            processPid: child.pid,
          });
        }
      }
    });

    child.stdin.end(JSON.stringify(request));
  });
}

export async function safeReadWorkspaceFileText(
  folder: string,
  relativePath: string,
  rootOverride?: string,
  maxBytes: number = 10 * 1024 * 1024,
): Promise<{ content: string; size: number }> {
  const result = await safeOpenWorkspaceReadStream(folder, relativePath, {
    rootOverride,
    maxBytes,
  });
  const reader = result.stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalReadBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        totalReadBytes += value.byteLength;
      }
    }
  } finally {
    result.destroy();
  }

  if (totalReadBytes < result.contentLength) {
    throw new Error(
      `File read truncated: expected ${result.contentLength} bytes, received ${totalReadBytes}`,
    );
  }

  const totalBuf = Buffer.concat(chunks);
  return {
    content: totalBuf.toString('utf-8'),
    size: result.size,
  };
}

/**
 * 获取会话流的文件根目录
 * @param folder 会话流文件夹名（如 main）
 * @param rootOverride 可选的自定义根目录（绝对路径），用于宿主机模式 customCwd
 * @returns 绝对路径
 */
export function getFileRoot(folder: string, rootOverride?: string): string {
  if (rootOverride && path.isAbsolute(rootOverride)) {
    return rootOverride;
  }
  return path.join(GROUPS_DIR, folder);
}

/**
 * 安全路径解析：防止路径遍历攻击
 * @param folder 会话流文件夹名
 * @param relativePath 用户提供的相对路径
 * @param rootOverride 可选的自定义根目录（绝对路径）
 * @returns 验证后的绝对路径
 * @throws 路径越界时抛出异常
 */
export function validateAndResolvePath(
  folder: string,
  relativePath: string,
  rootOverride?: string,
): string {
  const root = getFileRoot(folder, rootOverride);
  const normalized = path.normalize(relativePath);
  const resolved = path.resolve(root, normalized);

  // 使用 path.relative 检查是否在根目录内
  const relative = path.relative(root, resolved);

  if (relative.startsWith('..')) {
    throw new Error('Path traversal detected');
  }

  // 解析符号链接：沿路径向上找到最近的已存在祖先，确保其 realpath 仍在根目录内。
  // 这防止了"父级是 symlink、末级还不存在"的绕过场景。
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
  let checkPath = resolved;
  while (checkPath !== root && checkPath !== path.dirname(checkPath)) {
    if (fs.existsSync(checkPath)) {
      const realPath = fs.realpathSync(checkPath);
      if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
        throw new Error('Symlink traversal detected');
      }
      break;
    }
    checkPath = path.dirname(checkPath);
  }

  return resolved;
}

/**
 * 判断路径是否为系统路径（禁止删除）
 * @param relativePath 相对路径
 * @returns 是否为系统路径
 *
 * 平台敏感：APFS（macOS 默认）/ NTFS 上 `Logs` 与 `logs` 同 inode，必须
 * 大小写不敏感比较否则攻击者可通过大写绕过。case-sensitive Linux 上
 * 这种攻击不可达，强行 lowercased 反而误杀合法的 'Logs/' 等文件。
 */
export function isSystemPath(relativePath: string): boolean {
  const normalized = path.normalize(relativePath);
  const segments = normalized.split(path.sep).filter(Boolean);

  if (segments.length === 0) return false;

  // '.' alone is not a system path (root guard lives in deleteFile)
  if (segments.length === 1 && segments[0] === '.') return false;

  if (CASE_INSENSITIVE_FS) {
    const firstSegmentLower = segments[0].toLowerCase();
    const normalizedLower = normalized.toLowerCase();
    return SYSTEM_PATHS_LOWER.some(
      (sysPath) => firstSegmentLower === sysPath || normalizedLower === sysPath,
    );
  }
  // case-sensitive 平台保持 strict 比较
  const firstSegment = segments[0];
  return SYSTEM_PATHS.some(
    (sysPath) => firstSegment === sysPath || normalized === sysPath,
  );
}

/**
 * 系统路径中是否属于「内容可编辑」的例外。
 *
 * 只承认工作区根部的单段路径：`logs/CLAUDE.md`、`.claude/CLAUDE.md` 等嵌套
 * 同名文件必须继续锁定，否则解锁范围会顺着 SYSTEM_PATHS 的首段匹配扩散到
 * 整个系统目录。
 */
export function isEditableSystemPath(relativePath: string): boolean {
  const normalized = path.normalize(relativePath);
  const segments = normalized.split(path.sep).filter(Boolean);

  if (segments.length !== 1) return false;

  return CASE_INSENSITIVE_FS
    ? EDITABLE_SYSTEM_PATHS_LOWER.includes(segments[0].toLowerCase())
    : EDITABLE_SYSTEM_PATHS.includes(segments[0]);
}

/**
 * 判断路径是否禁止通过 Web 编辑内容。
 *
 * 与 isSystemPath 的区别：isSystemPath 管「禁删除 / 禁覆盖上传 / 禁建目录」，
 * 本函数只管内容写入，因此 CLAUDE.md 这类例外可以编辑但依然不能删。
 */
export function isEditLockedPath(relativePath: string): boolean {
  return isSystemPath(relativePath) && !isEditableSystemPath(relativePath);
}

/**
 * 列出目录内容
 * @param folder 会话流文件夹名
 * @param subPath 可选的子路径
 * @param rootOverride 可选的自定义根目录（绝对路径）
 * @returns 文件列表和当前路径
 */
export function listFiles(
  folder: string,
  subPath?: string,
  rootOverride?: string,
): { files: FileEntry[]; currentPath: string } {
  const relativePath = subPath || '';
  const absolutePath = validateAndResolvePath(
    folder,
    relativePath,
    rootOverride,
  );

  // 目录不存在时返回空列表，不自动创建（避免 GET 请求产生写副作用）
  if (!fs.existsSync(absolutePath)) {
    return { files: [], currentPath: relativePath };
  }

  const stat = fs.statSync(absolutePath);
  if (!stat.isDirectory()) {
    throw new Error('Path is not a directory');
  }

  const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
  const files: FileEntry[] = [];

  for (const entry of entries) {
    const name = entry.name;
    const entryPath = path.join(absolutePath, name);
    const entryRelativePath = path.join(relativePath, name);

    let stats: fs.Stats;
    try {
      stats = fs.statSync(entryPath);
    } catch {
      // Broken symlink or unreadable entry — skip rather than failing the whole
      // listing. statSync follows symlinks, so a dangling link throws ENOENT and
      // would otherwise 500 the entire directory (agent-triggerable DoS).
      continue;
    }

    const isDirectory = stats.isDirectory();
    files.push({
      name,
      path: entryRelativePath,
      type: isDirectory ? 'directory' : 'file',
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      isSystem: isSystemPath(entryRelativePath),
      editable: !isDirectory && !isEditLockedPath(entryRelativePath),
    });
  }

  // 文件夹在前，文件在后，按名称排序
  files.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return {
    files,
    currentPath: relativePath,
  };
}

/**
 * 删除文件或目录
 * @param folder 会话流文件夹名
 * @param relativePath 相对路径
 * @param rootOverride 可选的自定义根目录（绝对路径）
 * @throws 系统路径或路径不存在时抛出异常
 */
export function deleteFile(
  folder: string,
  relativePath: string,
  rootOverride?: string,
): void {
  // Reject empty / root-equivalent paths explicitly
  if (!relativePath || relativePath === '.' || relativePath === '/') {
    throw new Error('Cannot delete root directory');
  }

  // 检查是否为系统路径
  if (isSystemPath(relativePath)) {
    throw new Error('Cannot delete system path');
  }

  const absolutePath = validateAndResolvePath(
    folder,
    relativePath,
    rootOverride,
  );
  const root = getFileRoot(folder, rootOverride);

  // Double-check: never delete the group root itself
  if (path.resolve(absolutePath) === path.resolve(root)) {
    throw new Error('Cannot delete root directory');
  }

  if (!fs.existsSync(absolutePath)) {
    throw new Error('File or directory not found');
  }

  safeDeleteWorkspaceEntry(folder, relativePath, rootOverride);
}

/**
 * 创建目录
 * @param folder 会话流文件夹名
 * @param parentPath 父目录相对路径
 * @param name 新目录名称
 * @param rootOverride 可选的自定义根目录（绝对路径）
 * @throws 目录已存在时抛出异常
 */
export function createDirectory(
  folder: string,
  parentPath: string,
  name: string,
  rootOverride?: string,
): void {
  const targetPath = path.join(parentPath, name);

  // 禁止在系统路径下创建目录
  if (isSystemPath(targetPath)) {
    throw new Error('Cannot create directory in system path');
  }

  const absolutePath = validateAndResolvePath(folder, targetPath, rootOverride);

  if (fs.existsSync(absolutePath)) {
    throw new Error('Directory already exists');
  }

  safeCreateWorkspaceDirectory(folder, targetPath, rootOverride);
}

/**
 * 递归计算目录总大小（字节），带 5 分钟缓存
 */
export function getGroupStorageUsage(
  folder: string,
  rootOverride?: string,
): number {
  const cacheKey = getStorageCacheKey(folder, rootOverride);
  const cached = _storageCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.bytes;
  }

  const root = getFileRoot(folder, rootOverride);
  if (!fs.existsSync(root)) return 0;

  let totalBytes = 0;
  try {
    totalBytes = calculateDirSize(root);
  } catch (err) {
    logger.warn({ err, folder }, 'Failed to calculate storage usage');
  }

  _storageCache.set(cacheKey, {
    bytes: totalBytes,
    expires: Date.now() + STORAGE_CACHE_TTL,
  });
  return totalBytes;
}

export function invalidateGroupStorageUsage(
  folder: string,
  rootOverride?: string,
): void {
  _storageCache.delete(getStorageCacheKey(folder, rootOverride));
}

const MAX_DIR_DEPTH = 20;

function calculateDirSize(dirPath: string, depth = 0): number {
  if (depth > MAX_DIR_DEPTH) return 0;
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isSymbolicLink()) continue; // skip symlinks to avoid loops
    if (entry.isDirectory()) {
      total += calculateDirSize(fullPath, depth + 1);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(fullPath).size;
      } catch {
        /* skip unreadable files */
      }
    }
  }
  return total;
}

/** Remove all runtime artifacts for a group folder (workspace, sessions, ipc, env, memory). */
export function removeFlowArtifacts(folder: string): void {
  fs.rmSync(path.join(GROUPS_DIR, folder), { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, 'sessions', folder), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(DATA_DIR, 'ipc', folder), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(DATA_DIR, 'env', folder), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(DATA_DIR, 'memory', folder), {
    recursive: true,
    force: true,
  });
  deleteContainerEnvConfig(folder);
}
