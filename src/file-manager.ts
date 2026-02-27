import path from 'path';
import fs from 'fs';
import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

// 类型
export interface FileEntry {
  name: string;
  path: string; // 相对于 data/groups/{folder}/ 的路径
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
  isSystem: boolean;
}

// 常量
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const SYSTEM_PATHS = ['logs', 'CLAUDE.md', '.claude', 'conversations'];

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
 */
export function isSystemPath(relativePath: string): boolean {
  const normalized = path.normalize(relativePath);
  const segments = normalized.split(path.sep).filter(Boolean);

  if (segments.length === 0) return false;

  // '.' alone is not a system path (root guard lives in deleteFile)
  if (segments.length === 1 && segments[0] === '.') return false;

  // 检查第一段或完全匹配
  const firstSegment = segments[0];
  return SYSTEM_PATHS.some(
    (sysPath) => firstSegment === sysPath || normalized === sysPath,
  );
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
  const absolutePath = validateAndResolvePath(folder, relativePath, rootOverride);

  // 目录不存在时返回空列表，不自动创建（避免 GET 请求产生写副作用）
  if (!fs.existsSync(absolutePath)) {
    return { files: [], currentPath: relativePath };
  }

  const stat = fs.statSync(absolutePath);
  if (!stat.isDirectory()) {
    throw new Error('Path is not a directory');
  }

  const entries = fs.readdirSync(absolutePath);
  const files: FileEntry[] = [];

  for (const name of entries) {
    const entryPath = path.join(absolutePath, name);
    const stats = fs.statSync(entryPath);
    const entryRelativePath = path.join(relativePath, name);

    files.push({
      name,
      path: entryRelativePath,
      type: stats.isDirectory() ? 'directory' : 'file',
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      isSystem: isSystemPath(entryRelativePath),
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
export function deleteFile(folder: string, relativePath: string, rootOverride?: string): void {
  // Reject empty / root-equivalent paths explicitly
  if (!relativePath || relativePath === '.' || relativePath === '/') {
    throw new Error('Cannot delete root directory');
  }

  // 检查是否为系统路径
  if (isSystemPath(relativePath)) {
    throw new Error('Cannot delete system path');
  }

  const absolutePath = validateAndResolvePath(folder, relativePath, rootOverride);
  const root = getFileRoot(folder, rootOverride);

  // Double-check: never delete the group root itself
  if (path.resolve(absolutePath) === path.resolve(root)) {
    throw new Error('Cannot delete root directory');
  }

  if (!fs.existsSync(absolutePath)) {
    throw new Error('File or directory not found');
  }

  // Re-verify realpath right before destructive operation (TOCTOU defense-in-depth)
  const realRoot = fs.realpathSync(root);
  const realPath = fs.realpathSync(absolutePath);
  if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
    throw new Error('Symlink traversal detected');
  }
  if (realPath === realRoot) {
    throw new Error('Cannot delete root directory');
  }

  const stats = fs.statSync(absolutePath);
  if (stats.isDirectory()) {
    fs.rmSync(absolutePath, { recursive: true, force: true });
  } else {
    fs.unlinkSync(absolutePath);
  }
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

  fs.mkdirSync(absolutePath, { recursive: true });
  // chmod 0o777 确保容器（node/1000）与宿主机用户均可读写
  // 与 container-runner.ts 的 mkdirForContainer() 行为一致
  try { fs.chmodSync(absolutePath, 0o777); } catch { /* 忽略只读文件系统 */ }
}
