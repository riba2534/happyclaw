import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Monitor,
  Box,
  FolderInput,
  GitBranch,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DirectoryBrowser } from '../shared/DirectoryBrowser';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { useAgentProfilesStore } from '../../stores/agent-profiles';
import {
  getAgentContextSource,
  type CreateWorkspaceOptions,
  type InteractionMode,
} from '../../types';
import { workspaceCreationBlockReason } from '../../utils/agent-product';
import { extractErrorMessage } from '../../utils/error';
import { InteractionModeSelector } from './InteractionModeSelector';
import {
  HostDirectoryMountEditor,
  type HostDirectoryMountDraft,
  toAdditionalMountInputs,
  validateHostDirectoryMounts,
} from './HostDirectoryMountEditor';

interface CreateContainerDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (jid: string, folder: string) => void;
  initialAgentProfileId?: string;
}

function extractFieldErrors(error: unknown): Record<string, string> {
  if (typeof error !== 'object' || error === null || !('body' in error)) {
    return {};
  }
  const body = (error as { body?: unknown }).body;
  if (typeof body !== 'object' || body === null) return {};
  const raw =
    (body as Record<string, unknown>).field_errors ??
    (body as Record<string, unknown>).fieldErrors;
  const normalizeField = (field: string) => field.replace(/\[(\d+)\]/g, '.$1');
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return Object.fromEntries(
      Object.entries(raw).flatMap(([field, message]) => {
        const normalizedMessage =
          typeof message === 'string'
            ? message
            : Array.isArray(message) &&
                message.every((item) => typeof item === 'string')
              ? message.join('；')
              : '';
        return normalizedMessage.trim()
          ? [[normalizeField(field), normalizedMessage] as const]
          : [];
      }),
    );
  }

  const issues =
    (body as Record<string, unknown>).issues ??
    (body as Record<string, unknown>).details;
  if (!Array.isArray(issues)) return {};
  return Object.fromEntries(
    issues.flatMap((issue) => {
      if (typeof issue !== 'object' || issue === null) return [];
      const path = (issue as Record<string, unknown>).path;
      const message = (issue as Record<string, unknown>).message;
      const field = Array.isArray(path)
        ? path.map(String).join('.')
        : typeof path === 'string'
          ? normalizeField(path)
          : '';
      return field && typeof message === 'string' && message.trim()
        ? [[field, message] as const]
        : [];
    }),
  );
}

export function CreateContainerDialog({
  open,
  onClose,
  onCreated,
  initialAgentProfileId,
}: CreateContainerDialogProps) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [executionMode, setExecutionMode] = useState<'container' | 'host'>(
    'container',
  );
  const [customCwd, setCustomCwd] = useState('');
  const [initMode, setInitMode] = useState<'empty' | 'local' | 'git'>('empty');
  const [initSourcePath, setInitSourcePath] = useState('');
  const [initGitUrl, setInitGitUrl] = useState('');
  const [selectedAgentProfileId, setSelectedAgentProfileId] = useState(
    () => initialAgentProfileId || '',
  );
  const [interactionMode, setInteractionMode] =
    useState<InteractionMode>('assistant');
  const [hostMounts, setHostMounts] = useState<HostDirectoryMountDraft[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const createFlow = useChatStore((s) => s.createFlow);
  const adminHostOnlyMode = useChatStore((s) => s.adminHostOnlyMode);
  const canHostExec = useAuthStore((s) => s.user?.role === 'admin');
  const rawProfiles = useAgentProfilesStore((s) => s.profiles);
  const profiles = Array.isArray(rawProfiles) ? rawProfiles : [];
  const profilesLoading = useAgentProfilesStore((s) => s.loading);
  const profilesError = useAgentProfilesStore((s) => s.profilesError);
  const loadProfiles = useAgentProfilesStore((s) => s.loadProfiles);
  const selectedProfile = profiles.find(
    (profile) => profile.id === selectedAgentProfileId,
  );
  const inheritsHostClaude =
    canHostExec &&
    getAgentContextSource(
      selectedProfile?.effective_runtime_policy ??
        selectedProfile?.runtime_policy,
    ) === 'host_claude';
  const hostSkillsMode =
    selectedProfile?.runtime_policy.skills.host?.mode ??
    (inheritsHostClaude ? 'inherit' : 'disabled');

  useEffect(() => {
    if (open) void loadProfiles();
  }, [open, loadProfiles]);

  useEffect(() => {
    if (!open) return;
    if (initialAgentProfileId) {
      setSelectedAgentProfileId(initialAgentProfileId);
    } else if (!selectedAgentProfileId && profiles.length > 0) {
      const defaultProfile =
        profiles.find((profile) => profile.is_default) ?? profiles[0];
      setSelectedAgentProfileId(defaultProfile.id);
    }
  }, [open, initialAgentProfileId, profiles, selectedAgentProfileId]);

  useEffect(() => {
    if (canHostExec || executionMode === 'container') return;
    setExecutionMode('container');
    setCustomCwd('');
  }, [canHostExec, executionMode]);

  useEffect(() => {
    if (!open || !canHostExec || !adminHostOnlyMode) return;
    setExecutionMode('host');
    setInitMode('empty');
    setInitSourcePath('');
    setInitGitUrl('');
    setHostMounts([]);
    setFieldErrors({});
    setSubmitError(null);
  }, [open, canHostExec, adminHostOnlyMode]);

  useEffect(() => {
    if (canHostExec && executionMode === 'container') return;
    setHostMounts([]);
    setFieldErrors({});
    setSubmitError(null);
  }, [canHostExec, executionMode]);

  useEffect(() => {
    if (canHostExec) return;
    setInitMode((current) =>
      current === 'local' || current === 'git' ? 'empty' : current,
    );
    setInitSourcePath('');
    setInitGitUrl('');
  }, [canHostExec]);

  const clearSubmissionErrors = () => {
    setSubmitError(null);
    setFieldErrors({});
  };

  const reset = () => {
    setName('');
    setAdvancedOpen(false);
    setExecutionMode(canHostExec && adminHostOnlyMode ? 'host' : 'container');
    setCustomCwd('');
    setInitMode('empty');
    setInitSourcePath('');
    setInitGitUrl('');
    setSelectedAgentProfileId('');
    setInteractionMode('assistant');
    setHostMounts([]);
    setSubmitError(null);
    setFieldErrors({});
  };

  const handleClose = () => {
    onClose();
    reset();
  };

  const handleConfirm = async () => {
    const trimmed = name.trim();
    const blocked = workspaceCreationBlockReason({
      name: trimmed,
      submitting: loading,
      profilesLoading,
      profilesError,
      selectedAgentProfileId,
    });
    if (blocked) return;

    const mountErrors =
      canHostExec && executionMode === 'container'
        ? validateHostDirectoryMounts(hostMounts)
        : {};
    if (Object.keys(mountErrors).length > 0) {
      setFieldErrors(mountErrors);
      setSubmitError('请检查宿主机目录挂载配置');
      return;
    }

    clearSubmissionErrors();
    setLoading(true);
    try {
      const options: CreateWorkspaceOptions = {};
      if (executionMode === 'host' && canHostExec) {
        options.execution_mode = 'host';
        if (customCwd.trim()) options.custom_cwd = customCwd.trim();
      } else {
        if (canHostExec && initMode === 'local' && initSourcePath.trim()) {
          options.init_source_path = initSourcePath.trim();
        } else if (canHostExec && initMode === 'git' && initGitUrl.trim()) {
          options.init_git_url = initGitUrl.trim();
        }
        if (canHostExec && hostMounts.length > 0) {
          options.execution_mode = 'container';
          options.additional_mounts = toAdditionalMountInputs(hostMounts);
        }
      }
      if (selectedAgentProfileId)
        options.agent_profile_id = selectedAgentProfileId;
      options.interaction_mode = interactionMode;
      const created = await createFlow(
        trimmed,
        Object.keys(options).length ? options : undefined,
      );
      onCreated(created.jid, created.folder);
      handleClose();
    } catch (err) {
      const message = extractErrorMessage(err) || '创建失败，请重试';
      setSubmitError(message);
      setFieldErrors(extractFieldErrors(err));
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-xl">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>为智能体新建工作区</DialogTitle>
          <DialogDescription>
            选择智能体，并确认工作区的回复模式、运行位置和上下文。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <div>
            <label
              htmlFor="workspace-agent-profile"
              className="mb-2 block text-sm font-medium"
            >
              智能体
            </label>
            <Select
              value={selectedAgentProfileId}
              onValueChange={(value) => {
                setSelectedAgentProfileId(value);
                clearSubmissionErrors();
              }}
              disabled={profilesLoading || profiles.length === 0}
            >
              <SelectTrigger id="workspace-agent-profile" className="w-full">
                <SelectValue
                  placeholder={
                    profilesLoading ? '正在加载智能体...' : '选择智能体'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{profile.name}</span>
                      {profile.is_default && (
                        <span className="text-[10px] text-muted-foreground">
                          默认
                        </span>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {profilesError && (
              <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-error/20 bg-error-bg px-2.5 py-2 text-xs text-error">
                <span className="min-w-0">
                  智能体列表加载失败：{profilesError}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 flex-shrink-0"
                  onClick={() => void loadProfiles()}
                  disabled={profilesLoading}
                >
                  重试
                </Button>
              </div>
            )}
            {!profilesLoading && !profilesError && profiles.length === 0 && (
              <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                暂无可用智能体，请先到智能体页面创建。
              </p>
            )}
            {profiles.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                {selectedProfile?.identity_prompt ||
                  '使用默认智能体行为，不追加额外身份提示词。'}
              </p>
            )}
          </div>

          <InteractionModeSelector
            value={interactionMode}
            onChange={setInteractionMode}
            name="create-workspace-interaction-mode"
            disabled={loading}
          />

          {/* Name input */}
          <div>
            <label
              htmlFor="workspace-name"
              className="mb-2 block text-sm font-medium"
            >
              工作区名称
            </label>
            <Input
              id="workspace-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                clearSubmissionErrors();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirm();
              }}
              placeholder="输入这个智能体工作区的名称"
              autoFocus
            />
          </div>

          {selectedProfile && (
            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="min-w-0">
                  <div className="text-[11px] font-medium text-muted-foreground">
                    运行位置
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-sm font-medium text-foreground">
                    {executionMode === 'host' && canHostExec ? (
                      <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <Box className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                    {executionMode === 'host' && canHostExec
                      ? '宿主机'
                      : 'Docker 容器'}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] font-medium text-muted-foreground">
                    智能体上下文
                  </div>
                  <div className="mt-1 text-sm font-medium text-foreground">
                    {inheritsHostClaude ? '继承 ~/.claude' : 'HappyClaw 管理'}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] font-medium text-muted-foreground">
                    回复模式
                  </div>
                  <div className="mt-1 text-sm font-medium text-foreground">
                    {interactionMode === 'proactive'
                      ? '主动模式'
                      : 'Assistant 模式'}
                  </div>
                </div>
              </div>
              <p className="mt-2 border-t pt-2 text-[11px] leading-5 text-muted-foreground">
                {canHostExec
                  ? inheritsHostClaude
                    ? `运行位置只决定命令在哪里执行。该智能体会将完整 ~/.claude 作为用户配置层叠加，工作区仍是 cwd；宿主机 Skills：${hostSkillsMode === 'inherit' ? '全部使用' : hostSkillsMode === 'custom' ? `选择 ${selectedProfile?.runtime_policy.skills.host?.ids.length ?? 0} 项` : '不使用'}。`
                    : '运行位置只决定命令在哪里执行。该智能体使用 HappyClaw 管理的上下文与附加能力。'
                  : '工作区固定在 Docker 容器中运行，并使用 HappyClaw 管理的智能体上下文与附加能力。'}
              </p>
            </div>
          )}

          {/* Advanced options */}
          <div className="border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setAdvancedOpen(!advancedOpen)}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:bg-accent transition-colors cursor-pointer"
            >
              {advancedOpen ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
              高级选项
            </button>
            {advancedOpen && (
              <div className="px-3 pb-3 space-y-3 border-t">
                {/* Execution mode */}
                <div className="pt-3">
                  <label className="block text-sm font-medium mb-2">
                    运行位置
                  </label>
                  <div className="space-y-2">
                    {!adminHostOnlyMode && (
                      <label className="flex items-start gap-3 p-2 rounded-lg border cursor-pointer hover:bg-accent/50 transition-colors">
                        <input
                          type="radio"
                          name="execution_mode"
                          value="container"
                          checked={executionMode === 'container'}
                          onChange={() => {
                            setExecutionMode('container');
                            setCustomCwd('');
                            clearSubmissionErrors();
                          }}
                          className="mt-0.5 accent-primary"
                        />
                        <div>
                          <div className="flex items-center gap-1.5">
                            <Box className="w-4 h-4 text-muted-foreground" />
                            <span className="text-sm font-medium">
                              Docker 模式
                            </span>
                            <span className="text-xs text-primary font-medium">
                              推荐
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            在隔离的 Docker 环境中执行
                          </p>
                        </div>
                      </label>
                    )}
                    {canHostExec && (
                      <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-2 transition-colors hover:bg-accent/50">
                        <input
                          type="radio"
                          name="execution_mode"
                          value="host"
                          checked={executionMode === 'host'}
                          onChange={() => {
                            setExecutionMode('host');
                            setInitMode('empty');
                            setInitSourcePath('');
                            setInitGitUrl('');
                            setHostMounts([]);
                            clearSubmissionErrors();
                          }}
                          className="mt-0.5 accent-primary"
                        />
                        <div>
                          <div className="flex items-center gap-1.5">
                            <Monitor className="w-4 h-4 text-muted-foreground" />
                            <span className="text-sm font-medium">
                              宿主机模式
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            直接在服务器上执行
                          </p>
                        </div>
                      </label>
                    )}
                    {canHostExec && adminHostOnlyMode && (
                      <p className="rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-xs leading-5 text-warning">
                        管理员纯宿主机模式已开启，新工作区固定直接在服务器上运行。
                      </p>
                    )}
                  </div>
                </div>

                {/* Container mode: workspace source */}
                {executionMode === 'container' && (
                  <div className="space-y-4 pt-1">
                    <label className="block text-sm font-medium mb-2">
                      工作区来源
                    </label>
                    <div className="space-y-2">
                      <label className="flex items-start gap-3 p-2 rounded-lg border cursor-pointer hover:bg-accent/50 transition-colors">
                        <input
                          type="radio"
                          name="init_mode"
                          value="empty"
                          checked={initMode === 'empty'}
                          onChange={() => {
                            setInitMode('empty');
                            clearSubmissionErrors();
                          }}
                          className="mt-0.5 accent-primary"
                        />
                        <div>
                          <span className="text-sm font-medium">
                            空白工作区
                          </span>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            从空目录开始
                          </p>
                        </div>
                      </label>
                      {canHostExec && (
                        <label className="flex items-start gap-3 p-2 rounded-lg border cursor-pointer hover:bg-accent/50 transition-colors">
                          <input
                            type="radio"
                            name="init_mode"
                            value="local"
                            checked={initMode === 'local'}
                            onChange={() => {
                              setInitMode('local');
                              clearSubmissionErrors();
                            }}
                            className="mt-0.5 accent-primary"
                          />
                          <div className="flex-1">
                            <div className="flex items-center gap-1.5">
                              <FolderInput className="w-4 h-4 text-muted-foreground" />
                              <span className="text-sm font-medium">
                                复制本地目录
                              </span>
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              将宿主机目录复制到工作区（隔离副本）
                            </p>
                          </div>
                        </label>
                      )}
                      {initMode === 'local' && canHostExec && (
                        <div className="ml-6">
                          <DirectoryBrowser
                            value={initSourcePath}
                            onChange={(path) => {
                              setInitSourcePath(path);
                              clearSubmissionErrors();
                            }}
                            inputId="workspace-init-source"
                            label="要复制的服务器目录"
                            description="创建时复制一次，之后不会与宿主机源目录同步。"
                            placeholder="选择要复制的目录"
                          />
                        </div>
                      )}
                      {canHostExec && (
                        <>
                          <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-2 transition-colors hover:bg-accent/50">
                            <input
                              type="radio"
                              name="init_mode"
                              value="git"
                              checked={initMode === 'git'}
                              onChange={() => {
                                setInitMode('git');
                                clearSubmissionErrors();
                              }}
                              className="mt-0.5 accent-primary"
                            />
                            <div className="flex-1">
                              <div className="flex items-center gap-1.5">
                                <GitBranch className="h-4 w-4 text-muted-foreground" />
                                <span className="text-sm font-medium">
                                  克隆 Git 仓库
                                </span>
                              </div>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                从 GitHub 等平台克隆仓库到工作区
                              </p>
                            </div>
                          </label>
                          {initMode === 'git' && (
                            <div className="ml-6">
                              <label
                                htmlFor="workspace-init-git-url"
                                className="sr-only"
                              >
                                Git 仓库地址
                              </label>
                              <Input
                                id="workspace-init-git-url"
                                value={initGitUrl}
                                onChange={(e) => {
                                  setInitGitUrl(e.target.value);
                                  clearSubmissionErrors();
                                }}
                                placeholder="https://github.com/user/repo"
                              />
                            </div>
                          )}
                        </>
                      )}
                    </div>

                    {canHostExec && (
                      <div className="border-t border-border pt-4">
                        <HostDirectoryMountEditor
                          mounts={hostMounts}
                          onChange={(mounts) => {
                            setHostMounts(mounts);
                            clearSubmissionErrors();
                          }}
                          fieldErrors={fieldErrors}
                          disabled={loading}
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Host mode: custom cwd */}
                {executionMode === 'host' && (
                  <>
                    <DirectoryBrowser
                      value={customCwd}
                      onChange={(path) => {
                        setCustomCwd(path);
                        clearSubmissionErrors();
                      }}
                      inputId="workspace-custom-cwd"
                      label="宿主机工作目录（可选）"
                      description="智能体将直接在 HappyClaw 服务器上的这个目录中运行。"
                      placeholder="默认: data/groups/{folder}/"
                    />
                    <div className="flex items-start gap-2 p-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
                      <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-amber-700 dark:text-amber-300">
                        宿主机模式下智能体
                        可访问完整文件系统和工具链，请谨慎使用。
                      </p>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {submitError && (
            <div
              className="rounded-lg border border-error/30 bg-error-bg px-3 py-2 text-sm text-error"
              role="alert"
              aria-live="assertive"
            >
              {submitError}
            </div>
          )}
        </div>

        <DialogFooter className="flex-shrink-0">
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={loading}
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={
              workspaceCreationBlockReason({
                name,
                submitting: loading,
                profilesLoading,
                profilesError,
                selectedAgentProfileId,
              }) !== null
            }
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {loading && (initMode === 'local' || initMode === 'git')
              ? '正在初始化工作区...'
              : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
