/**
 * 草稿键工具函数
 *
 * 保证草稿按 Workspace + Session（含明确 Main）存储与隔离。
 * - 主会话：`{workspaceJid}::main`
 * - 子会话（Runtime Session / 话题等）：`{workspaceJid}::{sessionId}`
 */
export function getDraftStorageKey(
  workspaceJid?: string,
  sessionId?: string | null,
): string {
  if (!workspaceJid) return '';
  const normalizedSession =
    sessionId && sessionId.trim() ? sessionId.trim() : 'main';
  return `${workspaceJid}::${normalizedSession}`;
}

/**
 * 提取草稿键中的会话标识
 */
export function parseDraftStorageKey(
  draftKey: string,
): { workspaceJid: string; sessionId: string } | null {
  const sepIndex = draftKey.indexOf('::');
  if (sepIndex === -1) return null;
  return {
    workspaceJid: draftKey.slice(0, sepIndex),
    sessionId: draftKey.slice(sepIndex + 2),
  };
}
