// 重新部署后旧页面仍引用已被替换的哈希 chunk，懒加载会报
// "Failed to fetch dynamically imported module"。这种错误刷新即可恢复，
// 自动整页刷新一次；用时间窗防止 chunk 真缺失时陷入刷新循环。

const RELOAD_MARK_KEY = 'happyclaw:stale-chunk-reload-at';
const RELOAD_COOLDOWN_MS = 30_000;

const STALE_CHUNK_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /Unable to preload CSS/i,
];

export function isStaleChunkError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return STALE_CHUNK_PATTERNS.some((pattern) => pattern.test(message));
}

function readLastReloadAt(): number {
  try {
    return Number(window.sessionStorage.getItem(RELOAD_MARK_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** 返回 true 表示已触发刷新；冷却期内返回 false，交给错误界面兜底。 */
export function reloadForStaleChunk(
  now: number = Date.now(),
  reload: () => void = () => window.location.reload(),
): boolean {
  if (now - readLastReloadAt() < RELOAD_COOLDOWN_MS) return false;
  try {
    window.sessionStorage.setItem(RELOAD_MARK_KEY, String(now));
  } catch {
    // sessionStorage 不可用时无法防循环，放弃自动刷新。
    return false;
  }
  reload();
  return true;
}

const handledChunkErrors = new WeakSet<object>();

/**
 * 调用方能就地恢复的懒加载失败（空闲预取、带重试的对话框和面板）在这里登记，
 * 全局监听就不会为它们自动刷新页面。
 */
export function markChunkErrorHandled(error: unknown): void {
  if (error && typeof error === 'object') handledChunkErrors.add(error);
}

export function installStaleChunkRecovery(
  reload: () => void = () => window.location.reload(),
): void {
  window.addEventListener('vite:preloadError', (event) => {
    const error = (event as Event & { payload?: unknown }).payload;
    // 错误照常抛给发起 import 的调用方，调用方在 Promise 结算（微任务）内登记；
    // 下一个宏任务再判断是否需要刷新。
    window.setTimeout(() => {
      if (error && typeof error === 'object' && handledChunkErrors.has(error))
        return;
      reloadForStaleChunk(Date.now(), reload);
    }, 0);
  });
}
