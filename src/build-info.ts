import fs from 'node:fs';
import path from 'node:path';

/**
 * 前端构建标识：vite 构建时写进 `web/dist/build.json`，同一份值也编译进前端
 * 代码。后端据此告诉已打开的旧页面「服务端的前端已经更新」。
 *
 * 本机部署常常只重建前端、不重启后端，所以不能在启动时固定读一次：每次请求
 * stat 一下文件，mtime 或大小变了才重新解析。
 */
export interface BuildInfo {
  /** 展示与去重用的构建标识。 */
  id: string;
  /** 构建时刻（毫秒时间戳），比较新旧只看它。 */
  builtAt: number;
}

export const BUILD_INFO_FILE = 'build.json';

export function parseBuildInfo(raw: unknown): BuildInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const { id, builtAt } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || !id || id.length > 200) return null;
  if (typeof builtAt !== 'number' || !Number.isFinite(builtAt) || builtAt <= 0)
    return null;
  return { id, builtAt };
}

export interface BuildInfoReader {
  read(): BuildInfo | null;
}

/** 读取 `<distRoot>/build.json`，按 mtime 与大小缓存；缺失或损坏返回 null。 */
export function createBuildInfoReader(distRoot: string): BuildInfoReader {
  const file = path.join(distRoot, BUILD_INFO_FILE);
  let cached: { mtimeMs: number; size: number; info: BuildInfo | null } | null =
    null;

  return {
    read() {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        // 前端正在重建（dist 被清空）或从未构建：此刻没有可比较的值。
        cached = null;
        return null;
      }
      if (
        cached &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.size === stat.size
      ) {
        return cached.info;
      }
      let info: BuildInfo | null = null;
      try {
        info = parseBuildInfo(JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch {
        // 写入中途或内容损坏：不缓存，下一次请求再读。
        cached = null;
        return null;
      }
      cached = { mtimeMs: stat.mtimeMs, size: stat.size, info };
      return info;
    },
  };
}
