import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

/**
 * Office 文件预览：把 docx/xlsx/pptx 等转成 PDF（按源文件内容的 sha256 缓存），
 * 前端复用现有 PDF 预览。
 *
 * 转换器按优先级选择：
 *   1. Stirling-PDF 兼容服务：OFFICE_PREVIEW_STIRLING_URL（完整的
 *      convert/file/pdf 接口地址）+ OFFICE_PREVIEW_STIRLING_KEY_FILE（可选，
 *      文件内容作为 X-API-KEY；密钥只从文件读取，不进日志、不进命令行）。
 *   2. 本机 LibreOffice：只在显式设置 OFFICE_PREVIEW_SOFFICE_BIN（绝对路径）时启用，
 *      不搜索 PATH 或常见安装目录。soffice 在宿主机上以服务身份解析文档，Container
 *      工作区里不可信的文档也一样，所以必须由运维显式选择。子进程只拿到最小环境，
 *      在独立进程组里运行，超时连同它派生的进程一起杀掉。
 *   3. 都没有：抛出 NOT_CONFIGURED，由路由返回 501。
 *
 * 资源边界：同时最多 OFFICE_PREVIEW_MAX_ACTIVE 个转换，最多
 * OFFICE_PREVIEW_MAX_QUEUED 个排队，再多返回 BUSY（503）；源文件只在拿到转换名额后
 * 才复制进临时目录（流式，不整份读入内存）；转换结果不得超过源文件上限的
 * OUTPUT_LIMIT_FACTOR 倍。
 *
 * 其他可调项：OFFICE_PREVIEW_MAX_MB（源文件上限，默认 50）、
 * OFFICE_PREVIEW_TIMEOUT_MS（转换超时，默认 60000）、
 * OFFICE_PREVIEW_CACHE_MAX_MB（缓存总量上限，默认 1024）。
 */

// 前端 web/src/components/chat/FilePanel.tsx 的 OFFICE_EXTENSIONS 是同一份列表。
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

/** 同时进行的转换数。每次 soffice 运行都有自己的 UserInstallation，可以并发。 */
export const OFFICE_PREVIEW_MAX_ACTIVE = 2;
/** 等待转换名额的请求数上限，超出返回 BUSY。 */
export const OFFICE_PREVIEW_MAX_QUEUED = 8;
/** 转换结果的大小上限 = 源文件上限 × 该倍数。 */
const OUTPUT_LIMIT_FACTOR = 4;

const ERROR_STATUS = {
  NOT_CONFIGURED: 501,
  UNSUPPORTED_TYPE: 400,
  FILE_TOO_LARGE: 413,
  BUSY: 503,
  TIMEOUT: 504,
  CONVERT_FAILED: 502,
} as const;

export type OfficePreviewErrorCode = keyof typeof ERROR_STATUS;

export class OfficePreviewError extends Error {
  readonly status: (typeof ERROR_STATUS)[OfficePreviewErrorCode];
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

interface Limits {
  maxBytes: number;
  maxOutputBytes: number;
  timeoutMs: number;
  cacheMaxBytes: number;
}

function limits(): Limits {
  const env = process.env;
  const maxBytes = positiveInt(env.OFFICE_PREVIEW_MAX_MB, 50) * 1024 * 1024;
  return {
    maxBytes,
    maxOutputBytes: maxBytes * OUTPUT_LIMIT_FACTOR,
    timeoutMs: positiveInt(env.OFFICE_PREVIEW_TIMEOUT_MS, 60_000),
    cacheMaxBytes:
      positiveInt(env.OFFICE_PREVIEW_CACHE_MAX_MB, 1024) * 1024 * 1024,
  };
}

function megabytes(bytes: number): number {
  return Math.floor(bytes / 1024 / 1024);
}

function sourceTooLarge(maxBytes: number): OfficePreviewError {
  return new OfficePreviewError(
    'FILE_TOO_LARGE',
    `文件超过 Office 预览上限（${megabytes(maxBytes)} MB）`,
  );
}

function outputTooLarge(maxOutputBytes: number): OfficePreviewError {
  return new OfficePreviewError(
    'FILE_TOO_LARGE',
    `转换后的 PDF 超过预览上限（${megabytes(maxOutputBytes)} MB）`,
  );
}

function timedOut(): OfficePreviewError {
  return new OfficePreviewError('TIMEOUT', 'Office 转换超时');
}

function convertFailed(message = 'Office 转换失败'): OfficePreviewError {
  return new OfficePreviewError('CONVERT_FAILED', message);
}

function notConfigured(): OfficePreviewError {
  return new OfficePreviewError(
    'NOT_CONFIGURED',
    '未配置 Office 预览转换器（需要 OFFICE_PREVIEW_STIRLING_URL 或 OFFICE_PREVIEW_SOFFICE_BIN）',
  );
}

export function getOfficePreviewCacheDir(): string {
  return path.join(DATA_DIR, 'cache', 'office-preview');
}

function cachePathFor(hash: string): string {
  return path.join(getOfficePreviewCacheDir(), `${hash}.pdf`);
}

type Converter =
  | { kind: 'stirling'; url: string; keyFile?: string }
  | { kind: 'soffice'; bin: string };

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
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
  const bin = env.OFFICE_PREVIEW_SOFFICE_BIN?.trim();
  if (bin && path.isAbsolute(bin) && isExecutable(bin)) {
    return { kind: 'soffice', bin };
  }
  return null;
}

/**
 * The sha256 of at most `maxBytes` of the source, read from position 0 in
 * chunks, so hashing never blocks the event loop or holds the file in
 * memory; with `copyTo`, the bytes hashed are also written there. Positional
 * reads, not a stream: destroying a stream on the shared descriptor would
 * close it.
 */
async function hashSource(
  source: FileHandle,
  maxBytes: number,
  copyTo?: string,
): Promise<string> {
  const hash = crypto.createHash('sha256');
  const copy = copyTo ? await fs.promises.open(copyTo, 'w') : null;
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (let position = 0; ; ) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      position += bytesRead;
      if (position > maxBytes) throw sourceTooLarge(maxBytes);
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await copy?.write(chunk);
    }
  } finally {
    await copy?.close();
  }
  return hash.digest('hex');
}

// ─── Conversion slots ──────────────────────────────────────────

let activeConversions = 0;
const conversionWaiters: Array<() => void> = [];

async function withConversionSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeConversions < OFFICE_PREVIEW_MAX_ACTIVE) {
    activeConversions++;
  } else if (conversionWaiters.length >= OFFICE_PREVIEW_MAX_QUEUED) {
    throw new OfficePreviewError(
      'BUSY',
      '正在转换的 Office 文件较多，请稍后再试',
    );
  } else {
    await new Promise<void>((resolve) => conversionWaiters.push(resolve));
  }
  try {
    return await run();
  } finally {
    // Hand the slot straight to the next waiter, or give it back.
    const next = conversionWaiters.shift();
    if (next) next();
    else activeConversions--;
  }
}

// ─── Converters ────────────────────────────────────────────────
// Each converts `input` (a private copy in `work`) and returns the path of
// its output inside `work`, which is checked before it is cached.

async function convertWithStirling(
  converter: Extract<Converter, { kind: 'stirling' }>,
  input: string,
  ext: string,
  work: string,
  lim: Limits,
): Promise<string> {
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
  form.append('fileInput', await fs.openAsBlob(input), `document.${ext}`);

  const output = path.join(work, 'output.pdf');
  const out = await fs.promises.open(output, 'w');
  let res: Response | undefined;
  try {
    // The signal also bounds reading the response body.
    res = await fetch(converter.url, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(lim.timeoutMs),
    });
    if (!res.ok) {
      // 响应体可能含上游细节，只记状态码。
      logger.warn(
        { status: res.status },
        'Office preview: Stirling returned error',
      );
      throw convertFailed(`Office 转换失败（服务返回 ${res.status}）`);
    }
    if (Number(res.headers.get('content-length')) > lim.maxOutputBytes) {
      throw outputTooLarge(lim.maxOutputBytes);
    }
    let total = 0;
    for await (const chunk of res.body ?? []) {
      total += chunk.byteLength;
      if (total > lim.maxOutputBytes) throw outputTooLarge(lim.maxOutputBytes);
      await out.write(chunk);
    }
    return output;
  } catch (err) {
    // Release whatever of the response is still unread.
    await res?.body?.cancel().catch(() => undefined);
    if (err instanceof OfficePreviewError) throw err;
    const name = (err as Error | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw timedOut();
    throw convertFailed('Office 转换服务不可用');
  } finally {
    await out.close();
  }
}

/**
 * soffice's environment: never the service's own (it holds credentials).
 * HOME and TMPDIR point into this run's scratch directory.
 */
function sofficeEnv(work: string): NodeJS.ProcessEnv {
  const lang = process.env.LANG || 'C.UTF-8';
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: work,
    TMPDIR: work,
    LANG: lang,
    LC_ALL: process.env.LC_ALL || lang,
  };
}

interface GroupRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderr: string;
}

/**
 * Runs `bin` as the leader of its own process group and SIGKILLs the whole
 * group on timeout and again once the leader exits: on Linux `soffice` is a
 * wrapper script, so killing only the direct child would leave soffice.bin
 * running and holding the scratch directory.
 */
function runInProcessGroup(
  bin: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<GroupRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const killGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
    };
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf-8')).slice(-1000);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      killGroup();
      reject(err);
    });
    // 'exit', not 'close': a grandchild may still hold stderr open.
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      killGroup();
      resolve({ code, signal, timedOut, stderr });
    });
  });
}

async function convertWithSoffice(
  converter: Extract<Converter, { kind: 'soffice' }>,
  input: string,
  work: string,
  lim: Limits,
): Promise<string> {
  let result: GroupRunResult;
  try {
    result = await runInProcessGroup(
      converter.bin,
      [
        `-env:UserInstallation=${pathToFileURL(path.join(work, 'profile')).href}`,
        '--headless',
        '--convert-to',
        'pdf',
        '--outdir',
        work,
        input,
      ],
      { cwd: work, env: sofficeEnv(work), timeoutMs: lim.timeoutMs },
    );
  } catch (err) {
    logger.warn({ err }, 'Office preview: soffice could not start');
    throw convertFailed();
  }
  if (result.timedOut) throw timedOut();
  if (result.code !== 0) {
    logger.warn(
      { code: result.code, signal: result.signal, stderr: result.stderr },
      'Office preview: soffice failed',
    );
    throw convertFailed();
  }
  // soffice names the result after the input: input.<ext> → input.pdf.
  return path.join(work, 'input.pdf');
}

/** Checks a converter's output on disk by size first, then by its header. */
async function assertPdfOutput(file: string, lim: Limits): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch {
    throw convertFailed();
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw convertFailed();
    if (st.size > lim.maxOutputBytes) throw outputTooLarge(lim.maxOutputBytes);
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(5), 0, 5, 0);
    if (bytesRead < 5 || buffer.toString('latin1') !== '%PDF-') {
      throw convertFailed('Office 转换结果不是 PDF');
    }
  } finally {
    await handle.close();
  }
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

async function storeInCache(
  output: string,
  hash: string,
  cacheMaxBytes: number,
): Promise<void> {
  const pdfPath = cachePathFor(hash);
  await fs.promises.mkdir(path.dirname(pdfPath), { recursive: true });
  const tmp = `${pdfPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.copyFile(output, tmp);
    await fs.promises.rename(tmp, pdfPath);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
  try {
    pruneOfficePreviewCache(cacheMaxBytes, pdfPath);
  } catch (err) {
    logger.warn({ err }, 'Office preview: cache prune failed');
  }
}

/**
 * Converts the source as it is now and caches the PDF under the hash of the
 * bytes actually converted, which is returned: the file may have changed
 * since the caller hashed it, and a content-addressed cache shared by every
 * user must never file one content's PDF under another's hash.
 */
function convertIntoCache(
  converter: Converter,
  source: FileHandle,
  ext: string,
): Promise<string> {
  const lim = limits();
  return withConversionSlot(async () => {
    const work = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'happyclaw-office-'),
    );
    try {
      const input = path.join(work, `input.${ext}`);
      const hash = await hashSource(source, lim.maxBytes, input);
      if (fs.existsSync(cachePathFor(hash))) return hash;
      const output =
        converter.kind === 'stirling'
          ? await convertWithStirling(converter, input, ext, work, lim)
          : await convertWithSoffice(converter, input, work, lim);
      await assertPdfOutput(output, lim);
      await storeInCache(output, hash, lim.cacheMaxBytes);
      return hash;
    } finally {
      await fs.promises.rm(work, { recursive: true, force: true });
    }
  });
}

/**
 * Conversions in progress, by the hash their requester computed. A request
 * for the same hash waits for it, but uses the result only when it is that
 * hash's PDF, and never takes on its error: the requester's file may have
 * changed (or failed to convert) after it was hashed, and the waiting
 * request's own bytes are still the ones it must be served.
 */
const inflight = new Map<string, Promise<string>>();

async function convertShared(
  converter: Converter,
  source: FileHandle,
  ext: string,
  hash: string,
): Promise<string> {
  const convert = () => convertIntoCache(converter, source, ext);
  const joined = inflight.get(hash);
  if (joined) {
    const result = await joined.catch(() => null);
    if (result === hash) return hash;
    // Someone else's bytes or someone else's failure: convert our own, once.
    return convert();
  }
  const pending = convert().finally(() => inflight.delete(hash));
  inflight.set(hash, pending);
  return pending;
}

/**
 * Opens a cached PDF and marks it recently used, or null when it is gone or
 * cannot be read (the caller then converts it again).
 */
async function openCached(
  hash: string,
): Promise<{ handle: FileHandle; size: number } | null> {
  let handle: FileHandle;
  try {
    handle = await fs.promises.open(cachePathFor(hash), 'r');
  } catch {
    return null;
  }
  try {
    const now = new Date();
    // touch 失败只影响 LRU 精度
    await handle.utimes(now, now).catch(() => undefined);
    return { handle, size: (await handle.stat()).size };
  } catch {
    await handle.close();
    return null;
  }
}

function assertSupported(absolutePath: string): string {
  const ext = path.extname(absolutePath).slice(1).toLowerCase();
  if (!isOfficePreviewExtension(ext)) {
    throw new OfficePreviewError(
      'UNSUPPORTED_TYPE',
      '不支持的 Office 文件类型',
    );
  }
  return ext;
}

/**
 * The file's extension if it could be previewed at all: a supported
 * extension and a configured converter; otherwise throws. Checked before the
 * file is opened, so the default deployment (no converter) answers 501
 * without reading anything; a cached PDF is not served once its converter is
 * gone.
 */
export function assertOfficePreviewAvailable(absolutePath: string): string {
  const ext = assertSupported(absolutePath);
  if (!resolveConverter()) throw notConfigured();
  return ext;
}

/**
 * The sha256 of an Office file's content: its cache key and the preview's
 * ETag. `source` is the descriptor the route opened after validating the
 * path; nothing here reads the path again, which may be swapped for a
 * symlink to a host file while the request waits for a conversion slot.
 * Hashing reads the file (bounded by the size limit) every time rather than
 * memoising by (dev, ino, size, mtime): an mtime that is coarse or restored
 * would hand back a stale hash, and in a cache shared across users that
 * serves someone else's PDF.
 */
export async function hashOfficePreviewSource(
  source: FileHandle,
): Promise<string> {
  const { maxBytes } = limits();
  if ((await source.stat()).size > maxBytes) throw sourceTooLarge(maxBytes);
  return hashSource(source, maxBytes);
}

export interface OfficePreviewPdf {
  /** Hash of the source content this PDF was converted from. */
  hash: string;
  /** Open read handle on the cached PDF; the caller closes it. */
  handle: FileHandle;
  size: number;
  cacheHit: boolean;
}

/**
 * The cached PDF for a source (with extension `ext`) whose content hashed to
 * `hash`, converting it on a miss. The caller is responsible for
 * authorisation, path validation and closing `source`. Opening (not just
 * stat-ing) the cached file is what counts as a hit, so an entry another
 * request's prune removes in between is converted again instead of failing.
 */
export async function openOfficePreviewPdf(
  source: FileHandle,
  ext: string,
  hash: string,
): Promise<OfficePreviewPdf> {
  const cached = await openCached(hash);
  if (cached) return { hash, ...cached, cacheHit: true };

  const converter = resolveConverter();
  if (!converter) throw notConfigured();
  const converted = await convertShared(converter, source, ext, hash);
  const opened = await openCached(converted);
  if (!opened) throw convertFailed();
  return { hash: converted, ...opened, cacheHit: false };
}
