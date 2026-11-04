/**
 * The workspace root: where new Host workspaces without a custom directory
 * are created (`src/workspace-root.ts` on the server).
 */

/** Same wording as the server's WORKSPACE_ROOT_PROBLEM_MESSAGES. */
const PROBLEM_MESSAGES: Record<string, string> = {
  not_absolute: '工作区根目录必须是绝对路径（可以用 ~ 开头）。',
  filesystem_root: '工作区根目录不能是文件系统根目录。',
  home_dir: '工作区根目录不能是用户主目录本身，请用它下面的一个子目录。',
  inside_install_dir:
    '工作区根目录不能放在 HappyClaw 安装目录里，否则 Agent 会读到项目自己的 CLAUDE.md。',
  not_directory: '这个路径已存在，但不是目录。',
  claude_md_ancestor:
    '这个目录或它的上层目录里有 CLAUDE.md，工作区里的 Agent 会读到它。',
  inside_git_repo:
    '这个目录位于另一个 git 仓库里，工作区会混进那个仓库的未跟踪文件。',
  not_writable: '没有权限在这个位置创建目录。',
};

/** What a problem code means; unknown codes are shown as they are. */
export function workspaceRootProblemMessage(code: string): string {
  return PROBLEM_MESSAGES[code] ?? code;
}

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
