/**
 * The workspace root: where new Host workspaces without a custom directory
 * are created (`src/workspace-root.ts` on the server).
 */

export { workspaceRootProblemMessage } from './workspace-root-problems';

export const WORKSPACE_ROOT_SOURCE_LABELS = {
  settings: '系统设置',
  env: '环境变量 HAPPYCLAW_WORKSPACE_ROOT',
  default: '默认值',
} as const;

/** Placeholder of a Host workspace's directory field: where it goes by default. */
export function workspaceDirPlaceholder(root?: string | null): string {
  const trimmed = root?.trim().replace(/\/+$/, '');
  return trimmed ? `默认: ${trimmed}/<文件夹>` : '默认: data/groups/{folder}/';
}
