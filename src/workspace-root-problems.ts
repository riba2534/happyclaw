/**
 * Why a workspace root candidate cannot be used, and what to tell the
 * person. The server checks candidates (src/workspace-root.ts) and returns
 * the code; the Web shows the same words for a fallback or a refused save.
 */
export type WorkspaceRootProblem =
  | 'not_absolute'
  | 'filesystem_root'
  | 'home_dir'
  | 'contains_home'
  | 'inside_install_dir'
  | 'contains_install_dir'
  | 'not_directory'
  | 'not_empty'
  | 'overlaps_workspace_paths'
  | 'claude_md_ancestor'
  | 'inside_git_repo'
  | 'not_writable';

export const WORKSPACE_ROOT_PROBLEM_MESSAGES: Record<
  WorkspaceRootProblem,
  string
> = {
  not_absolute: '工作区根目录必须是绝对路径（可以用 ~ 开头）。',
  filesystem_root: '工作区根目录不能是文件系统根目录。',
  home_dir: '工作区根目录不能是用户主目录本身，请用它下面的一个子目录。',
  contains_home: '工作区根目录不能是用户主目录的上层目录。',
  inside_install_dir:
    '工作区根目录不能放在 HappyClaw 安装目录里，否则 Agent 会读到项目自己的 CLAUDE.md。',
  contains_install_dir: '工作区根目录不能是 HappyClaw 安装目录的上层目录。',
  not_directory: '这个路径已存在，但不是目录（或是指向不存在位置的链接）。',
  not_empty:
    '这个目录已有不是 HappyClaw 创建的内容；请选择一个空目录或新目录。',
  overlaps_workspace_paths:
    '这个目录与已有工作区的自定义目录或挂载目录重叠；请选择别的位置。',
  claude_md_ancestor:
    '这个目录或它的上层目录里有 CLAUDE.md，工作区里的 Agent 会读到它。',
  inside_git_repo:
    '这个目录位于另一个 git 仓库里，工作区会混进那个仓库的未跟踪文件。',
  not_writable: '没有权限在这个位置创建目录。',
};

/** What a problem code means; an unknown code is shown as it is. */
export function workspaceRootProblemMessage(code: string): string {
  return WORKSPACE_ROOT_PROBLEM_MESSAGES[code as WorkspaceRootProblem] ?? code;
}
