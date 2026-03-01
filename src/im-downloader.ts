import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from './config.js';

export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export class FileTooLargeError extends Error {
  constructor(filename: string, size: number) {
    super(
      `File "${filename}" is too large: ${size} bytes (max ${MAX_FILE_SIZE} bytes)`,
    );
    this.name = 'FileTooLargeError';
  }
}

/**
 * 将 Buffer 写入 downloads/{channel}/{YYYY-MM-DD}/ 目录，
 * 返回工作区相对路径（如 downloads/feishu/2026-03-01/report.pdf）。
 * @throws FileTooLargeError 当 buffer.length > MAX_FILE_SIZE
 */
export async function saveDownloadedFile(
  groupFolder: string,
  channel: 'feishu' | 'telegram',
  originalFilename: string,
  buffer: Buffer,
): Promise<string> {
  if (buffer.length > MAX_FILE_SIZE) {
    throw new FileTooLargeError(originalFilename, buffer.length);
  }

  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dir = path.join(GROUPS_DIR, groupFolder, 'downloads', channel, dateStr);
  fs.mkdirSync(dir, { recursive: true });

  // 安全处理：剥离目录部分，空时 fallback 为时间戳名
  let safeName = path.basename(originalFilename).trim();
  if (!safeName) {
    safeName = `file_${Date.now()}`;
  }

  // 冲突处理：目标文件已存在时，在扩展名之前追加 _HHmmss 后缀
  let absPath = path.join(dir, safeName);
  if (fs.existsSync(absPath)) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const suffix = `_${hh}${mm}${ss}`;
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext);
    safeName = `${base}${suffix}${ext}`;
    absPath = path.join(dir, safeName);
  }

  fs.writeFileSync(absPath, buffer, { mode: 0o644 });

  // 返回相对于群组工作区根目录的路径
  const groupRoot = path.join(GROUPS_DIR, groupFolder);
  return path.relative(groupRoot, absPath).replace(/\\/g, '/');
}
