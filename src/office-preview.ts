import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

/**
 * Office 文件预览：把 docx/xlsx/pptx 等转成 PDF（按内容哈希缓存），
 * 前端复用现有 PDF 预览。
 *
 * 转换器按优先级选择：
 *   1. Stirling-PDF 兼容服务：OFFICE_PREVIEW_STIRLING_URL（完整的
 *      convert/file/pdf 接口地址）+ OFFICE_PREVIEW_STIRLING_KEY_FILE（可选，
 *      文件内容作为 X-API-KEY；密钥只从文件读取，不进日志、不进命令行）。
 *   2. 本机 LibreOffice：OFFICE_PREVIEW_SOFFICE_BIN，或 PATH / macOS 应用目录
 *      里的 soffice。
 *   3. 都没有：抛出 NOT_CONFIGURED，由路由返回 501。
 *
 * 其他可调项：OFFICE_PREVIEW_MAX_MB（源文件上限，默认 50）、
 * OFFICE_PREVIEW_TIMEOUT_MS（转换超时，默认 60000）、
 * OFFICE_PREVIEW_CACHE_MAX_MB（缓存总量上限，默认 1024）。
 */

export const OFFICE_PREVIEW_EXTENSIONS = new Set([
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
]);

export type OfficePreviewErrorCode =
  | 'NOT_CONFIGURED'
  | 'UNSUPPORTED_TYPE'
  | 'FILE_TOO_LARGE'
  | 'TIMEOUT'
  | 'CONVERT_FAILED';

const ERROR_STATUS: Record<OfficePreviewErrorCode, number> = {
  NOT_CONFIGURED: 501,
  UNSUPPORTED_TYPE: 400,
  FILE_TOO_LARGE: 413,
  TIMEOUT: 504,
  CONVERT_FAILED: 502,
};

export class OfficePreviewError extends Error {
  readonly status: number;
  constructor(
    readonly code: OfficePreviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OfficePreviewError';
    this.status = ERROR_STATUS[code];
  }
}

export function isOfficePreviewExtension(ext: string): boolean {
  return OFFICE_PREVIEW_EXTENSIONS.has(ext.toLowerCase());
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function limits(env: NodeJS.ProcessEnv) {
  return {
    maxBytes: positiveInt(env.OFFICE_PREVIEW_MAX_MB, 50) * 1024 * 1024,
    timeoutMs: positiveInt(env.OFFICE_PREVIEW_TIMEOUT_MS, 60_000),
    cacheMaxBytes:
      positiveInt(env.OFFICE_PREVIEW_CACHE_MAX_MB, 1024) * 1024 * 1024,
  };
}

export function getOfficePreviewCacheDir(): string {
  return path.join(DATA_DIR, 'cache', 'office-preview');
}

type Converter =
  | { kind: 'stirling'; url: string; keyFile?: string }
  | { kind: 'soffice'; bin: string };

const SOFFICE_FALLBACKS = [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/usr/bin/soffice',
  '/usr/local/bin/soffice',
  '/opt/homebrew/bin/soffice',
];

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function findSoffice(env: NodeJS.ProcessEnv): string | null {
  const configured = env.OFFICE_PREVIEW_SOFFICE_BIN?.trim();
  if (configured) return isExecutable(configured) ? configured : null;
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'soffice');
    if (isExecutable(candidate)) return candidate;
  }
  return SOFFICE_FALLBACKS.find(isExecutable) ?? null;
}

export function resolveConverter(
  env: NodeJS.ProcessEnv = process.env,
): Converter | null {
  const url = env.OFFICE_PREVIEW_STIRLING_URL?.trim();
  if (url) {
    return {
      kind: 'stirling',
      url,
      keyFile: env.OFFICE_PREVIEW_STIRLING_KEY_FILE?.trim() || undefined,
    };
  }
  const bin = findSoffice(env);
  return bin ? { kind: 'soffice', bin } : null;
}

function notConfigured(): OfficePreviewError {
  return new OfficePreviewError(
    'NOT_CONFIGURED',
    '未配置 Office 预览转换器（需要 OFFICE_PREVIEW_STIRLING_URL 或本机安装 LibreOffice）',
  );
}

function isPdf(buf: Buffer): boolean {
  return buf.length > 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

async function convertWithStirling(
  converter: Extract<Converter, { kind: 'stirling' }>,
  source: Buffer,
  ext: string,
  timeoutMs: number,
): Promise<Buffer> {
  const headers: Record<string, string> = {};
  if (converter.keyFile) {
    let key: string;
    try {
      key = fs.readFileSync(converter.keyFile, 'utf-8').trim();
    } catch {
      throw new OfficePreviewError(
        'NOT_CONFIGURED',
        '无法读取 Office 预览转换器的密钥文件',
      );
    }
    if (key) headers['X-API-KEY'] = key;
  }

  // 只传 ASCII 文件名：转换服务靠扩展名判断类型，原始文件名没有意义。
  const form = new FormData();
  form.append(
    'fileInput',
    new Blob([new Uint8Array(source)]),
    `document.${ext}`,
  );

  let res: Response;
  try {
    res = await fetch(converter.url, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new OfficePreviewError('TIMEOUT', 'Office 转换超时');
    }
    throw new OfficePreviewError('CONVERT_FAILED', 'Office 转换服务不可用');
  }
  if (!res.ok) {
    // 响应体可能含上游细节，只记状态码。
    logger.warn(
      { status: res.status },
      'Office preview: Stirling returned error',
    );
    throw new OfficePreviewError(
      'CONVERT_FAILED',
      `Office 转换失败（服务返回 ${res.status}）`,
    );
  }
  let out: Buffer;
  try {
    out = Buffer.from(await res.arrayBuffer());
  } catch {
    throw new OfficePreviewError('TIMEOUT', 'Office 转换超时');
  }
  if (!isPdf(out)) {
    throw new OfficePreviewError('CONVERT_FAILED', 'Office 转换服务未返回 PDF');
  }
  return out;
}

// soffice 同一用户配置目录不能并发使用，串行化。
let sofficeTail: Promise<unknown> = Promise.resolve();

async function convertWithSoffice(
  converter: Extract<Converter, { kind: 'soffice' }>,
  source: Buffer,
  ext: string,
  timeoutMs: number,
): Promise<Buffer> {
  const run = async (): Promise<Buffer> => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-office-'));
    try {
      const input = path.join(work, `input.${ext}`);
      fs.writeFileSync(input, source);
      try {
        await execFileAsync(
          converter.bin,
          [
            `-env:UserInstallation=${new URL(`file://${path.join(work, 'profile')}`).href}`,
            '--headless',
            '--convert-to',
            'pdf',
            '--outdir',
            work,
            input,
          ],
          { timeout: timeoutMs, killSignal: 'SIGKILL' },
        );
      } catch (err) {
        if ((err as { killed?: boolean }).killed) {
          throw new OfficePreviewError('TIMEOUT', 'Office 转换超时');
        }
        logger.warn({ err }, 'Office preview: soffice failed');
        throw new OfficePreviewError('CONVERT_FAILED', 'Office 转换失败');
      }
      const out = path.join(work, 'input.pdf');
      const buf = fs.existsSync(out) ? fs.readFileSync(out) : Buffer.alloc(0);
      if (!isPdf(buf)) {
        throw new OfficePreviewError('CONVERT_FAILED', 'Office 转换失败');
      }
      return buf;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  };
  const result = sofficeTail.then(run, run);
  sofficeTail = result.catch(() => undefined);
  return result;
}

/** 缓存超限时按 mtime（命中时会 touch）从旧到新淘汰，保留 keep 指定的文件。 */
export function pruneOfficePreviewCache(maxBytes: number, keep?: string): void {
  const dir = getOfficePreviewCacheDir();
  let entries: { file: string; size: number; mtimeMs: number }[];
  try {
    entries = fs.readdirSync(dir).flatMap((name) => {
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) return [];
        // 残留的临时文件（崩溃遗留）超过一小时直接清掉。
        if (name.endsWith('.tmp')) {
          if (Date.now() - st.mtimeMs > 3_600_000)
            fs.rmSync(file, { force: true });
          return [];
        }
        return name.endsWith('.pdf')
          ? [{ file, size: st.size, mtimeMs: st.mtimeMs }]
          : [];
      } catch {
        return [];
      }
    });
  } catch {
    return;
  }
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  if (total <= maxBytes) return;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries) {
    if (total <= maxBytes) break;
    if (entry.file === keep) continue;
    fs.rmSync(entry.file, { force: true });
    total -= entry.size;
  }
}

const inflight = new Map<string, Promise<string>>();

export interface OfficePreviewResult {
  /** 缓存 PDF 的绝对路径 */
  pdfPath: string;
  cacheHit: boolean;
}

/**
 * 把已通过路径校验的 Office 文件转成 PDF 并返回缓存文件路径。
 * 调用方负责权限与路径校验。
 */
export async function getOfficePreviewPdf(
  absolutePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OfficePreviewResult> {
  const ext = path.extname(absolutePath).slice(1).toLowerCase();
  if (!isOfficePreviewExtension(ext)) {
    throw new OfficePreviewError(
      'UNSUPPORTED_TYPE',
      '不支持的 Office 文件类型',
    );
  }
  const { maxBytes, timeoutMs, cacheMaxBytes } = limits(env);
  const size = fs.statSync(absolutePath).size;
  if (size > maxBytes) {
    throw new OfficePreviewError(
      'FILE_TOO_LARGE',
      `文件超过 Office 预览上限（${Math.floor(maxBytes / 1024 / 1024)} MB）`,
    );
  }

  const source = fs.readFileSync(absolutePath);
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  const cacheDir = getOfficePreviewCacheDir();
  const pdfPath = path.join(cacheDir, `${hash}.pdf`);

  if (fs.existsSync(pdfPath)) {
    const now = new Date();
    try {
      fs.utimesSync(pdfPath, now, now);
    } catch {
      // touch 失败只影响 LRU 精度
    }
    return { pdfPath, cacheHit: true };
  }

  // 缓存未命中才需要转换器；缓存命中时即使转换器被移除也能预览。
  const converter = resolveConverter(env);
  if (!converter) throw notConfigured();

  let pending = inflight.get(hash);
  if (!pending) {
    pending = (async () => {
      const pdf =
        converter.kind === 'stirling'
          ? await convertWithStirling(converter, source, ext, timeoutMs)
          : await convertWithSoffice(converter, source, ext, timeoutMs);
      fs.mkdirSync(cacheDir, { recursive: true });
      const tmp = `${pdfPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(tmp, pdf);
      fs.renameSync(tmp, pdfPath);
      try {
        pruneOfficePreviewCache(cacheMaxBytes, pdfPath);
      } catch (err) {
        logger.warn({ err }, 'Office preview: cache prune failed');
      }
      return pdfPath;
    })().finally(() => inflight.delete(hash));
    inflight.set(hash, pending);
  }
  await pending;
  return { pdfPath, cacheHit: false };
}
