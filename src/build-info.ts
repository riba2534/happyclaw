import fs from 'node:fs';
import path from 'node:path';

/**
 * Frontend build identity. The build-info plugin in web/vite.config.ts writes
 * it to dist/build.json and the same value into a meta tag in index.html, so
 * open tabs can tell that a different frontend is deployed.
 *
 * Deploys often rebuild the frontend without restarting the backend, so the
 * file is not read once at startup: every request stats it and re-parses only
 * when its mtime or size changed.
 */
export interface BuildInfo {
  /** Hash of the build output: the same source always builds the same id. */
  id: string;
  /** Build time in ms; orders builds whose ids differ. */
  builtAt: number;
}

export const BUILD_INFO_FILE = 'build.json';

// Same rules as parseBuildInfo in web/src/utils/versionCheck.ts; keep the two
// in sync.
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
