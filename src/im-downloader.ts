import fs from 'fs';
import path from 'path';
import { GROUPS_DIR, MAX_FILE_SIZE } from './config.js';

// MAX_FILE_SIZE 统一由 config.ts 定义（可通过 MAX_FILE_SIZE_MB 环境变量配置），
// 此处 re-export 保持既有 import 路径不变。IM 渠道收文件与 Web 上传共用此上限。
export { MAX_FILE_SIZE };

export class FileTooLargeError extends Error {
  constructor(filename: string, size: number) {
    super(
      `File "${filename}" is too large: ${size} bytes (max ${MAX_FILE_SIZE} bytes)`,
    );
    this.name = 'FileTooLargeError';
  }
}

function resolvedPathStaysInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

/**
 * `mkdir({recursive:true})` 会穿过目录符号链接。日期段可预测，而 O_EXCL
 * 只拒绝叶子文件上的符号链接，所以工作区内预先放好的
 * downloads/<channel>/<YYYY-MM-DD> 目录链接会把文件写到群组根之外。
 * 写盘前要求 realpath(dir) 仍落在 realpath(groupRoot) 里面。
 */
function assertDownloadDirInsideGroup(groupRoot: string, dir: string): void {
  let resolvedRoot: string;
  let resolvedDir: string;
  try {
    resolvedRoot = fs.realpathSync(groupRoot);
    resolvedDir = fs.realpathSync(dir);
  } catch {
    throw new Error(
      `Refusing to save download outside the group workspace: ${dir}`,
    );
  }
  if (!resolvedPathStaysInside(resolvedRoot, resolvedDir)) {
    throw new Error(
      `Refusing to save download outside the group workspace: ${dir}`,
    );
  }
}

/**
 * 清洗来自 IM 渠道的文件名，剥离用于 prompt 注入的字符。`path.basename` 不
 * 剥离这些字符，所以仅依赖它会把攻击载荷透传到 Agent prompt。
 *
 * 行为：
 * - 始终先 path.basename 剥离目录部分。
 * - 控制字符替换为空格：ASCII C0+DEL（含 \n/\r/\t）、C1（U+0080-U+009F）、
 *   行/段分隔符（U+2028/U+2029）、bidi 控制（U+200E/U+200F/U+202A-U+202E/
 *   U+2066-U+2069）、零宽（U+200B-U+200D）、word joiner（U+2060）、
 *   interlinear annotation（U+FFF9-U+FFFB）、BOM/U+FEFF。
 * - 反引号 / box-drawing（U+2500-U+257F 整段）替换为空格。
 * - 半角 + 全角中括号转空格（防 `[文件: …]` 围栏被攻破）。
 * - 折叠空白，截断到 200 字符；空字符串回落 `unnamed`。
 */
export function sanitizeImFilename(raw: string | undefined | null): string {
  const base = path.basename(String(raw ?? '')).trim();
  if (!base) return 'unnamed';
  const cleaned = base
    // C0 + DEL + C1 + 行段分隔 + bidi + 零宽 + 其他
    .replace(
      /[\x00-\x1f\x7f-\x9f\u00ad\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff\ufff9-\ufffb]/g,
      ' ',
    )
    // box-drawing 整段
    .replace(/[\u2500-\u257f]+/g, ' ')
    // 反引号
    .replace(/`+/g, ' ')
    // 半角 + 全角中括号
    .replace(/[\[\]\uff3b\uff3d]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'unnamed';
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
}

/**
 * Agent 视角的工作区根目录解析器。Host 模式配置了 customCwd 时，Runner 的
 * cwd 是 customCwd 而不是 data/groups/{folder}（与 Web 文件面板
 * getFileRootOverride 一致）；附件必须落在 Agent 用相对路径能打开的位置。
 * 由主进程在启动时注册；未注册或返回空值时回落到 GROUPS_DIR/{folder}。
 */
type DownloadRootResolver = (groupFolder: string) => string | null | undefined;
let downloadRootResolver: DownloadRootResolver | null = null;

export function setImDownloadRootResolver(
  resolver: DownloadRootResolver | null,
): void {
  downloadRootResolver = resolver;
}

/** 当前 folder 的附件根目录（绝对路径）。 */
export function resolveImDownloadRoot(groupFolder: string): string {
  let override: string | null | undefined;
  try {
    override = downloadRootResolver?.(groupFolder);
  } catch {
    override = undefined;
  }
  return override && path.isAbsolute(override)
    ? override
    : path.join(GROUPS_DIR, groupFolder);
}

/**
 * 将 Buffer 写入 downloads/{channel}/{YYYY-MM-DD}/ 目录，
 * 返回 Agent 工作目录相对路径（如 downloads/feishu/2026-03-01/report.pdf）。
 * 工作目录为 resolveImDownloadRoot(groupFolder)：通常是 data/groups/{folder}，
 * Host 模式配置 customCwd 时为 customCwd。
 * @throws FileTooLargeError 当 buffer.length > MAX_FILE_SIZE
 */
export async function saveDownloadedFile(
  groupFolder: string,
  channel:
    | 'feishu'
    | 'telegram'
    | 'qq'
    | 'wechat'
    | 'dingtalk'
    | 'discord'
    | 'whatsapp'
    | 'wecom',
  originalFilename: string,
  buffer: Buffer,
): Promise<string> {
  if (buffer.length > MAX_FILE_SIZE) {
    throw new FileTooLargeError(originalFilename, buffer.length);
  }

  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const groupRoot = resolveImDownloadRoot(groupFolder);
  const dir = path.join(groupRoot, 'downloads', channel, dateStr);
  fs.mkdirSync(dir, { recursive: true });
  assertDownloadDirInsideGroup(groupRoot, dir);

  // 同时清洗控制字符：returned relPath 会被插入 agent prompt，
  // 不能保留 \n / 反引号等可被滥用的字符。sanitize 失败 fallback 时
  // 用时间戳重命名，避免和合法叫 "unnamed" 的文件冲突。
  let safeName = sanitizeImFilename(originalFilename);
  if (safeName === 'unnamed') {
    safeName = `file_${Date.now()}`;
  }

  // 冲突处理：原方案只用 _HHmmss 后缀，同秒并发会让两个并发写入指向同一
  // 后缀名互相覆盖。改为 while 循环递增 -2 / -3 / ... 保证每次都拿到独立
  // 文件名。`fs.openSync(absPath, 'wx')` 仍可能竞速，但两端命名不同时它能
  // 把同名冲突显式抛出来，不再静默覆写。
  let absPath = path.join(dir, safeName);
  if (fs.existsSync(absPath)) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const baseSuffix = `_${hh}${mm}${ss}`;
    const ext = path.extname(safeName);
    const baseName = path.basename(safeName, ext);
    let i = 0;
    while (true) {
      const tail = i === 0 ? baseSuffix : `${baseSuffix}_${i}`;
      safeName = `${baseName}${tail}${ext}`;
      absPath = path.join(dir, safeName);
      if (!fs.existsSync(absPath)) break;
      i++;
      if (i > 1000) {
        // 极端兜底：上千次同秒同名几乎不可能，但避免死循环。
        safeName = `${baseName}${baseSuffix}_${Date.now()}${ext}`;
        absPath = path.join(dir, safeName);
        break;
      }
    }
  }

  // 用 'wx' 标志原子创建：仍有 race（两个进程同时拿到 doesn't-exist 后都
  // 创建），用 wx 让冲突方收到 EEXIST 而不是悄悄覆写；外层 catch 会回到
  // 路由层的错误处理（IM media 一般会触发重试机制）。
  let fd: number;
  try {
    fd = fs.openSync(
      absPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o644,
    );
  } catch (err: any) {
    if (err && err.code === 'EEXIST') {
      // 极端竞态：另一进程刚刚抢占同名。再换一次后缀重试。
      safeName = `${path.basename(safeName, path.extname(safeName))}_${Date.now()}${path.extname(safeName)}`;
      absPath = path.join(dir, safeName);
      fd = fs.openSync(
        absPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o644,
      );
    } else {
      throw err;
    }
  }
  try {
    fs.writeFileSync(fd, buffer);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }

  // 返回相对于群组工作区根目录的路径
  return path.relative(groupRoot, absPath).replace(/\\/g, '/');
}
