// ─── Codex 模型目录 — 上游同步层 ────────────────────────────────────
//
// model-catalog.ts 是离线兜底（baked-in）；本模块让目录"根据上游内容更新"：
// 定期 + 访问时拉取 openai/codex 仓库的 codex-rs/models-manager/models.json
// （codex CLI 自身捆绑的同一份目录），解析出在售模型与受支持的 reasoning
// effort 档位。任何失败（网络、结构、校验）都保留当前目录，绝不返回空目录。
//
// 缓存三级：内存（进程内即时生效）→ 磁盘（重启后免等待）→ baked-in 兜底。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  CODEX_KNOWN_EFFORTS,
  CODEX_MODEL_CATALOG,
  type CodexModelCatalogEntry,
} from './model-catalog.js';

const UPSTREAM_MODELS_URL =
  'https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json';

const UPSTREAM_FETCH_TIMEOUT_MS = 10_000;
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 拉取失败后的重试间隔：瞬时故障（断网/超时）不应换来整整 6 小时沉默。 */
const REFRESH_FAILURE_BACKOFF_MS = 5 * 60 * 1000;
/** 上游响应体硬上限：真实 models.json 远小于此，超限视为投毒/异常，拒绝解析。 */
const MAX_UPSTREAM_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_ENTRIES = 200;
const MAX_SLUG_LENGTH = 128;
const MAX_LABEL_LENGTH = 128;
const KNOWN_EFFORT_SET = new Set<string>(CODEX_KNOWN_EFFORTS);

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type CodexCatalogSource = 'builtin' | 'disk-cache' | 'upstream';

export interface ResolvedCodexCatalog {
  models: readonly CodexModelCatalogEntry[];
  source: CodexCatalogSource;
  fetchedAt: string | null;
}

interface UpstreamModelEntry {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  visibility?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
}

/** 带硬上限地读响应体：先查 Content-Length，再流式累计，超限立即中断。 */
async function readBodyWithCap(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') ?? '');
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_UPSTREAM_BODY_BYTES
  ) {
    throw new Error(
      `Upstream catalog body too large: ${contentLength} bytes (cap ${MAX_UPSTREAM_BODY_BYTES})`,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Upstream catalog response has no body');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_UPSTREAM_BODY_BYTES) {
      void reader.cancel().catch(() => {});
      throw new Error(
        `Upstream catalog body exceeds ${MAX_UPSTREAM_BODY_BYTES} byte cap`,
      );
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function resolveDiskCachePath(): string {
  return (
    diskCachePathOverride ??
    path.join(DATA_DIR, 'config', 'codex-model-catalog.json')
  );
}

let diskCachePathOverride: string | null | undefined;

const curatedLabels = new Map(
  CODEX_MODEL_CATALOG.map((entry) => [entry.value, entry.label]),
);

/**
 * 上游 models.json → 目录条目。只保留 visibility=list 的在售模型；
 * effort 档位先经已知档位白名单过滤再按上游顺序采用（上游数据不可信，
 * 未知档位会被请求侧透传导致 400）；已知模型保留人工中文标注，新模型用
 * display_name 自动生成标签。slug 去重（首见优先）。
 */
export function parseUpstreamModelCatalog(
  raw: unknown,
): CodexModelCatalogEntry[] {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Upstream model catalog payload is not an object');
  }
  const models = (raw as { models?: unknown }).models;
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('Upstream model catalog has no models array');
  }
  const entries: CodexModelCatalogEntry[] = [];
  const seenSlugs = new Set<string>();
  for (const item of models as UpstreamModelEntry[]) {
    if (!item || typeof item !== 'object') continue;
    const slug = typeof item.slug === 'string' ? item.slug.trim() : '';
    if (!slug || item.visibility !== 'list' || seenSlugs.has(slug)) continue;
    if (slug.length > MAX_SLUG_LENGTH) continue;
    const efforts = Array.isArray(item.supported_reasoning_levels)
      ? item.supported_reasoning_levels
          .map((level) =>
            level && typeof level === 'object'
              ? (level as { effort?: unknown }).effort
              : undefined,
          )
          .filter(
            (effort): effort is string =>
              typeof effort === 'string' && KNOWN_EFFORT_SET.has(effort),
          )
      : [];
    if (efforts.length === 0) continue;
    const upstreamDefault =
      typeof item.default_reasoning_level === 'string' &&
      efforts.includes(item.default_reasoning_level)
        ? item.default_reasoning_level
        : undefined;
    const curated = curatedLabels.get(slug);
    const displayName =
      typeof item.display_name === 'string' &&
      item.display_name.trim().length <= MAX_LABEL_LENGTH
        ? item.display_name.trim()
        : '';
    seenSlugs.add(slug);
    entries.push({
      value: slug,
      label: curated ?? (displayName ? `${slug}（${displayName}）` : slug),
      efforts,
      ...(upstreamDefault ? { defaultEffort: upstreamDefault } : {}),
    });
    if (entries.length > MAX_CATALOG_ENTRIES) {
      throw new Error(
        `Upstream model catalog exceeds ${MAX_CATALOG_ENTRIES} entries`,
      );
    }
  }
  if (entries.length === 0) {
    throw new Error('Upstream model catalog produced no usable entries');
  }
  return entries;
}

let resolved: ResolvedCodexCatalog = {
  models: CODEX_MODEL_CATALOG,
  source: 'builtin',
  fetchedAt: null,
};

let inflight: Promise<boolean> | null = null;
let lastRefreshAt = 0;
let lastRefreshFailed = false;

export function getResolvedCodexCatalog(): ResolvedCodexCatalog {
  return resolved;
}

function isValidCatalogEntry(entry: unknown): entry is CodexModelCatalogEntry {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as Partial<CodexModelCatalogEntry>;
  return (
    typeof candidate.value === 'string' &&
    candidate.value.length > 0 &&
    typeof candidate.label === 'string' &&
    Array.isArray(candidate.efforts) &&
    candidate.efforts.length > 0 &&
    candidate.efforts.every((effort) => typeof effort === 'string') &&
    (candidate.defaultEffort === undefined ||
      (typeof candidate.defaultEffort === 'string' &&
        candidate.efforts.includes(candidate.defaultEffort)))
  );
}

function loadDiskCache(): boolean {
  if (diskCachePathOverride === null) return false;
  try {
    const raw = readFileSync(resolveDiskCachePath(), 'utf8');
    if (raw.length > MAX_UPSTREAM_BODY_BYTES) {
      logger.warn(
        { bytes: raw.length },
        'Codex model catalog: disk cache too large, ignoring',
      );
      return false;
    }
    const parsed = JSON.parse(raw) as {
      models?: unknown;
      fetchedAt?: unknown;
    };
    const models = Array.isArray(parsed.models) ? parsed.models : [];
    if (
      models.length === 0 ||
      models.length > MAX_CATALOG_ENTRIES ||
      models.some((entry) => !isValidCatalogEntry(entry))
    ) {
      logger.warn(
        'Codex model catalog: disk cache failed validation, ignoring',
      );
      return false;
    }
    resolved = {
      models,
      source: 'disk-cache',
      fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : null,
    };
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.warn(
        { err },
        'Codex model catalog: failed to read disk cache, ignoring',
      );
    }
    return false;
  }
}

function writeDiskCache(models: readonly CodexModelCatalogEntry[]): void {
  if (diskCachePathOverride === null) return;
  const file = resolveDiskCachePath();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    // 先写临时文件再原子改名：进程中断不会留下半截缓存被下次启动读走。
    const tmpFile = `${file}.tmp`;
    writeFileSync(
      tmpFile,
      JSON.stringify({ models, fetchedAt: new Date().toISOString() }, null, 2),
    );
    renameSync(tmpFile, file);
  } catch (err) {
    logger.warn({ err }, 'Codex model catalog: failed to persist disk cache');
  }
}

/**
 * 拉取并应用上游目录。成功返回 true；任何失败保留当前目录。
 * 单飞：并发调用共享同一次拉取，避免重复请求。
 */
export async function refreshCodexCatalog(
  options: { fetchImpl?: FetchLike } = {},
): Promise<boolean> {
  if (inflight) return inflight;
  const doRefresh = async (): Promise<boolean> => {
    const fetchImpl = options.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(UPSTREAM_MODELS_URL, {
        headers: { 'User-Agent': 'happyclaw-codex-gateway' },
        signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Upstream catalog HTTP ${response.status}`);
      }
      const entries = parseUpstreamModelCatalog(
        JSON.parse(await readBodyWithCap(response)),
      );
      resolved = {
        models: entries,
        source: 'upstream',
        fetchedAt: new Date().toISOString(),
      };
      lastRefreshAt = Date.now();
      lastRefreshFailed = false;
      writeDiskCache(entries);
      logger.info(
        { count: entries.length },
        'Codex model catalog refreshed from upstream',
      );
      return true;
    } catch (err) {
      // 失败也推进时间戳，但用更短的后隔（避免瞬时故障被 6h TTL 惩罚）。
      lastRefreshAt = Date.now();
      lastRefreshFailed = true;
      logger.warn(
        { err },
        'Codex model catalog: upstream refresh failed, keeping current catalog',
      );
      return false;
    }
  };
  inflight = doRefresh().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** TTL 内不重复拉取；由目录路由与启动路径调用，fire-and-forget。 */
export function maybeRefreshCodexCatalog(
  options: { force?: boolean } = {},
): void {
  const interval = lastRefreshFailed
    ? REFRESH_FAILURE_BACKOFF_MS
    : REFRESH_INTERVAL_MS;
  const stale = Date.now() - lastRefreshAt >= interval;
  if (!stale && !options.force) return;
  if (inflight) return;
  void refreshCodexCatalog();
}

/**
 * 启动时调用：先同步读磁盘缓存（重启后立即可用），再后台拉一次上游。
 * 永不抛错、不阻塞启动。fetchImpl 供测试注入，避免测试触发真实网络。
 */
export function initCodexCatalogSync(
  options: { fetchImpl?: FetchLike } = {},
): void {
  if (loadDiskCache()) {
    logger.info(
      { count: resolved.models.length },
      'Codex model catalog loaded from disk cache',
    );
  }
  void refreshCodexCatalog(options);
}

/** 测试专用：重置内存状态与磁盘缓存路径覆写。 */
export function resetCodexCatalogSyncForTests(): void {
  resolved = {
    models: CODEX_MODEL_CATALOG,
    source: 'builtin',
    fetchedAt: null,
  };
  inflight = null;
  lastRefreshAt = 0;
  lastRefreshFailed = false;
  diskCachePathOverride = undefined;
}

/** 测试专用：覆写磁盘缓存路径（null 关闭磁盘读写）。 */
export function setCodexCatalogDiskCachePathForTests(
  value: string | null,
): void {
  diskCachePathOverride = value;
}
