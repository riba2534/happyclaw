// 后端更新后，已打开的旧页面（尤其是常驻数天的 iOS 主屏 PWA）不会报错，也没有
// 任何迹象说明自己过期。这里把页面自带的构建标识和后端当前部署的前端比一比，
// 服务端更新时提示用户点击刷新。没有 Service Worker 缓存要协调，刷新即可。

export interface BuildInfo {
  id: string;
  builtAt: number;
}

/** 同一时刻的重复触发（恢复前台常同时触发 pageshow、visibilitychange、WS 重连）合并。 */
export const VERSION_CHECK_MIN_GAP_MS = 10_000;
/** 兜底：页面一直在前台、也没有重连时的定时检查间隔。 */
export const VERSION_CHECK_INTERVAL_MS = 30 * 60_000;

export const UPDATE_TOAST_ID = 'app-update-available';

export function parseBuildInfo(raw: unknown): BuildInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const { id, builtAt } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || !id) return null;
  if (typeof builtAt !== 'number' || !Number.isFinite(builtAt) || builtAt <= 0)
    return null;
  return { id, builtAt };
}

/** 只有服务端比本页新才算过期；相同或更旧（回滚部署）都不提示。 */
export function isServerNewer(server: BuildInfo, local: BuildInfo): boolean {
  return server.builtAt > local.builtAt;
}

export interface VersionChecker {
  /** 查一次；10 秒内的重复调用和正在进行的检查合并。 */
  check(): Promise<void>;
}

export interface VersionCheckerOptions {
  /** 本页的构建标识；为 null（开发模式、未经构建的环境）时不做任何事。 */
  local: BuildInfo | null;
  fetchServer: () => Promise<BuildInfo | null>;
  /** 弹出提示。`dismiss` 由实现在用户关闭提示时调用。 */
  prompt: (server: BuildInfo, dismiss: () => void) => void;
  now?: () => number;
}

export function createVersionChecker(
  options: VersionCheckerOptions,
): VersionChecker {
  const { local, fetchServer, prompt } = options;
  const now = options.now ?? Date.now;
  let inflight: Promise<void> | null = null;
  let lastCheckAt = -Infinity;
  let dismissed = false;
  const prompted = new Set<string>();

  const run = async () => {
    let server: BuildInfo | null = null;
    try {
      server = await fetchServer();
    } catch {
      return; // 网络抖动：下一次触发再查。
    }
    if (!server || !local || dismissed) return;
    if (!isServerNewer(server, local)) return;
    if (prompted.has(server.id)) return;
    prompted.add(server.id);
    prompt(server, () => {
      dismissed = true;
    });
  };

  return {
    check() {
      if (!local || dismissed) return Promise.resolve();
      if (inflight) return inflight;
      if (now() - lastCheckAt < VERSION_CHECK_MIN_GAP_MS)
        return Promise.resolve();
      lastCheckAt = now();
      inflight = run().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}

export interface VersionCheckEnv {
  win: Window;
  doc: Document;
  /** 订阅 WS 的 connected（含重连）事件，返回取消订阅函数。 */
  onWsConnected: (handler: () => void) => () => void;
}

/** 接上触发时机，返回卸载函数。 */
export function installVersionCheck(
  checker: VersionChecker,
  env: VersionCheckEnv,
): () => void {
  const check = () => void checker.check();
  const onVisible = () => {
    if (env.doc.visibilityState === 'visible') check();
  };
  const offWs = env.onWsConnected(check);
  env.doc.addEventListener('visibilitychange', onVisible);
  env.win.addEventListener('pageshow', check);
  // 隐藏的页面不主动查：回到前台时 visibilitychange 会查。
  const timer = env.win.setInterval(() => {
    if (env.doc.visibilityState === 'visible') check();
  }, VERSION_CHECK_INTERVAL_MS);

  return () => {
    offWs();
    env.doc.removeEventListener('visibilitychange', onVisible);
    env.win.removeEventListener('pageshow', check);
    env.win.clearInterval(timer);
  };
}
