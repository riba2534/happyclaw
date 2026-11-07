import { toast } from 'sonner';
import { apiFetch } from '../api/client';
import { wsManager } from '../api/ws';
import {
  UPDATE_TOAST_ID,
  createVersionChecker,
  installVersionCheck,
  parseBuildInfo,
  readLocalBuild,
  type BuildInfo,
} from './versionCheck';

/** 常驻提示：不自动消失，用户点「刷新」或关闭。 */
export function showUpdateToast(
  onDismiss: () => void,
  reload: () => void = () => window.location.reload(),
): void {
  toast('HappyClaw 已更新，点击刷新', {
    id: UPDATE_TOAST_ID,
    duration: Infinity,
    closeButton: true,
    action: { label: '刷新', onClick: reload },
    onDismiss,
  });
}

async function fetchServerBuild(): Promise<BuildInfo | null> {
  // 公开接口，访客与未登录页面都能读；后端尚未部署该接口时返回 404，按「无信息」处理。
  const body = await apiFetch<unknown>('/api/build', { cache: 'no-store' });
  return parseBuildInfo(body);
}

/**
 * 开发服务器（vite dev）和没有构建标识的环境不提示。草稿由输入框自己持久化
 * 到 localStorage，刷新不会丢，所以刷新前不再确认。
 */
export function startAppUpdateCheck(): (() => void) | null {
  if (import.meta.env.DEV) return null;
  const local = readLocalBuild(document);
  if (!local) return null;
  const checker = createVersionChecker({
    local,
    fetchServer: fetchServerBuild,
    prompt: (_server, dismiss) => showUpdateToast(dismiss),
  });
  return installVersionCheck(checker, {
    win: window,
    doc: document,
    onWsConnected: (handler) => wsManager.on('connected', handler),
  });
}
