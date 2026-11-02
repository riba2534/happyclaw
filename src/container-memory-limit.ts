/**
 * The opt-in per-container memory cap (`CONTAINER_MEMORY_LIMIT`) and what a
 * session's repeated OOM kill (exit 137) means with and without it.
 */
import type { ExecutionMode } from './types.js';

export interface ContainerMemoryLimit {
  /** Value for `docker run --memory` and `--memory-swap`: exact bytes. */
  dockerValue: string;
  /** Binary size for logs and user notices, e.g. `3 GiB`. */
  display: string;
}

type ContainerMemoryLimitParse =
  | { limit: ContainerMemoryLimit; error: null }
  | { limit: null; error: string | null };

/** Docker refuses `--memory` below 6 MiB. */
const DOCKER_MIN_MEMORY_BYTES = 6 * 1024 * 1024;

const UNIT_BYTES: Record<string, number> = {
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
};

// The subset of docker/go-units `RAMInBytes` that names a unit: a decimal
// number, an optional space, then `b` or k/m/g/t with an optional `b` or `ib`,
// case-insensitive. A bare number is bytes to docker, so `2048` written as
// megabytes would cap every container at 2 KiB and none would start.
const MEMORY_SIZE_RE = /^(\d+(?:\.\d+)?|\.\d+) ?(b|[kmgt](?:i?b)?)$/i;

const DISPLAY_UNITS: Array<[string, number]> = [
  ['TiB', 1024 ** 4],
  ['GiB', 1024 ** 3],
  ['MiB', 1024 ** 2],
];

function formatBinarySize(bytes: number): string {
  const [unit, size] = DISPLAY_UNITS.find(([, size]) => bytes >= size)!;
  return `${Number((bytes / size).toFixed(2))} ${unit}`;
}

/**
 * Parse `CONTAINER_MEMORY_LIMIT`. Empty means no cap; an unusable value is an
 * error the caller reports, and also means no cap.
 */
export function parseContainerMemoryLimit(
  raw: string | undefined,
): ContainerMemoryLimitParse {
  const value = raw?.trim() ?? '';
  if (!value) return { limit: null, error: null };
  const match = MEMORY_SIZE_RE.exec(value);
  if (!match) {
    return {
      limit: null,
      error: /^\d+(?:\.\d+)?$/.test(value)
        ? 'has no unit (docker would read it as bytes)'
        : 'is not a docker memory size',
    };
  }
  const bytes = Math.floor(
    Number(match[1]) * UNIT_BYTES[match[2][0].toLowerCase()],
  );
  if (!Number.isSafeInteger(bytes)) {
    return { limit: null, error: 'is too large' };
  }
  if (bytes < DOCKER_MIN_MEMORY_BYTES) {
    return { limit: null, error: "is below docker's 6 MiB minimum" };
  }
  return {
    limit: { dockerValue: `${bytes}b`, display: formatBinarySize(bytes) },
    error: null,
  };
}

export interface OomLoopAction {
  /** Clear the session's Claude context to break the loop. */
  resetContext: boolean;
  noticeKey: string;
  /** System message type for the Web record. */
  webType: string;
  text: string;
  terminalError: string;
}

const OOM_CONTEXT_RESET_NOTICE =
  '会话文件过大导致内存溢出（OOM），已自动重置会话。';

/**
 * What a session does once its consecutive OOM kills reach the threshold.
 * Without a cap the kill is taken to come from an oversized session and the
 * context is cleared. Under an admin cap it most likely comes from this turn's
 * own load, which clearing the context would not fix, so the context is kept
 * and the user is told about the cap instead.
 */
export function resolveOomLoopAction(
  executionMode: ExecutionMode,
  memoryLimit: ContainerMemoryLimit | null,
): OomLoopAction {
  if (executionMode === 'container' && memoryLimit) {
    return {
      resetContext: false,
      noticeKey: 'oom-memory-limit',
      webType: 'system_error',
      text:
        `容器以退出码 137 被终止，重试后仍然如此，很可能是本轮运行超过了管理员设置的` +
        `容器内存上限（${memoryLimit.display}）。已停止重试，会话上下文保留不变。` +
        `可以精简任务后再试，或用 /fresh 开一个新的上下文窗口；如果经常发生，` +
        `请管理员调高 CONTAINER_MEMORY_LIMIT。`,
      terminalError: `容器超过内存上限（${memoryLimit.display}）被终止（OOM）。`,
    };
  }
  return {
    resetContext: true,
    noticeKey: 'oom-context-reset',
    webType: 'context_reset',
    text: `${OOM_CONTEXT_RESET_NOTICE}之前的对话上下文已清除，请重新描述您的需求。`,
    terminalError: OOM_CONTEXT_RESET_NOTICE,
  };
}
