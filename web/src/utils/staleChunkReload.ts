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

export function installStaleChunkRecovery(): void {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadForStaleChunk()) event.preventDefault();
  });
}
