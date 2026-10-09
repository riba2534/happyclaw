import { useEffect, useState, type ReactNode } from 'react';
import {
  ChevronRight,
  Monitor,
  Box,
  FolderInput,
  GitBranch,
  Loader2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Callout } from '@/components/capabilities/capability-ui';
import { cn } from '@/lib/utils';
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
}

/** Radio option rendered as a choice card; the native input stays for a11y. */
function RadioCard({
  name,
  value,
  checked,
  onSelect,
  icon: Icon,
  title,
  badge,
  description,
}: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: () => void;
  icon?: LucideIcon;
  title: string;
  badge?: ReactNode;
  description: string;
}) {
  return (
    <label
      className={cn(
        'relative flex cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2.5 ring-1 transition-colors duration-100',
        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50',
        checked
          ? 'bg-surface-selected ring-foreground/25'
          : 'bg-transparent ring-surface-border hover:bg-surface-hover',
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onSelect}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full ring-1',
          checked ? 'ring-primary' : 'ring-border',
        )}
      >
        {checked && <span className="size-1.5 rounded-full bg-primary" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-label text-foreground">
          {Icon && (
            <Icon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          )}
          {title}
          {badge}
        </span>
        <span className="mt-0.5 block text-caption text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  );
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
  const [selectedAgentProfileId, setSelectedAgentProfileId] = useState('');
  const [interactionMode, setInteractionMode] =
    useState<InteractionMode>('assistant');
  const [hostMounts, setHostMounts] = useState<HostDirectoryMountDraft[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const createFlow = useChatStore((s) => s.createFlow);
  const adminHostOnlyMode = useChatStore((s) => s.adminHostOnlyMode);
  const canHostExec = useAuthStore((s) => s.user?.role === 'admin');
  const profiles = useAgentProfilesStore((s) => s.profiles);
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
    if (!open || selectedAgentProfileId || profiles.length === 0) return;
    const defaultProfile =
      profiles.find((profile) => profile.is_default) ?? profiles[0];
    setSelectedAgentProfileId(defaultProfile.id);
  }, [open, profiles, selectedAgentProfileId]);

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
        <DialogHeader className="shrink-0">
          <DialogTitle>为智能体新建工作区</DialogTitle>
          <DialogDescription>
            选择智能体，并确认工作区的回复模式、运行位置和上下文。
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-4 min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-1">
          <div>
            <Label htmlFor="workspace-agent-profile" className="mb-1.5">
              智能体
            </Label>
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
                        <span className="text-micro text-muted-foreground">
                          默认
                        </span>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {profilesError && (
              <Callout tone="error" className="mt-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0">
                    智能体列表加载失败：{profilesError}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="shrink-0"
                    onClick={() => void loadProfiles()}
                    disabled={profilesLoading}
                  >
                    重试
                  </Button>
                </div>
              </Callout>
            )}
            {!profilesLoading && !profilesError && profiles.length === 0 && (
              <p className="mt-1.5 text-caption text-warning">
                暂无可用智能体，请先到智能体页面创建。
              </p>
            )}
            {profiles.length > 0 && (
              <p className="mt-1.5 line-clamp-2 text-caption text-muted-foreground">
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
            <Label htmlFor="workspace-name" className="mb-1.5">
              工作区名称
            </Label>
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
            <div className="rounded-lg px-3 py-2.5 ring-1 ring-surface-border">
              <dl className="grid gap-3 sm:grid-cols-3">
                <div className="min-w-0">
                  <dt className="text-micro text-muted-foreground">运行位置</dt>
                  <dd className="mt-1 flex items-center gap-1.5 text-label text-foreground">
                    {executionMode === 'host' && canHostExec ? (
                      <Monitor className="size-3.5 text-muted-foreground" />
                    ) : (
                      <Box className="size-3.5 text-muted-foreground" />
                    )}
                    {executionMode === 'host' && canHostExec
                      ? '宿主机'
                      : 'Docker 容器'}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-micro text-muted-foreground">
                    智能体上下文
                  </dt>
                  <dd className="mt-1 text-label text-foreground">
                    {inheritsHostClaude ? '继承 ~/.claude' : 'HappyClaw 管理'}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-micro text-muted-foreground">回复模式</dt>
                  <dd className="mt-1 text-label text-foreground">
                    {interactionMode === 'proactive'
                      ? '主动模式'
                      : 'Assistant 模式'}
                  </dd>
                </div>
              </dl>
              <p className="mt-2.5 border-t border-surface-border pt-2 text-caption leading-5 text-muted-foreground">
                {canHostExec
                  ? inheritsHostClaude
                    ? `运行位置只决定命令在哪里执行。该智能体会将完整 ~/.claude 作为用户配置层叠加，工作区仍是 cwd；宿主机 Skills：${hostSkillsMode === 'inherit' ? '全部使用' : hostSkillsMode === 'custom' ? `选择 ${selectedProfile?.runtime_policy.skills.host?.ids.length ?? 0} 项` : '不使用'}。`
                    : '运行位置只决定命令在哪里执行。该智能体使用 HappyClaw 管理的上下文与附加能力。'
                  : '工作区固定在 Docker 容器中运行，并使用 HappyClaw 管理的智能体上下文与附加能力。'}
              </p>
            </div>
          )}

          {/* Advanced options */}
          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAdvancedOpen(!advancedOpen)}
              aria-expanded={advancedOpen}
              className="-ml-2 text-muted-foreground aria-expanded:text-foreground aria-expanded:not-hover:bg-transparent"
            >
              <ChevronRight
                className={cn(
                  'transition-transform duration-150',
                  advancedOpen && 'rotate-90',
                )}
              />
              高级选项
            </Button>
            {advancedOpen && (
              <div className="mt-3 space-y-5">
                {/* Execution mode */}
                <fieldset>
                  <legend className="text-body leading-none font-medium">
                    运行位置
                  </legend>
                  <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                    {!adminHostOnlyMode && (
                      <RadioCard
                        name="execution_mode"
                        value="container"
                        checked={executionMode === 'container'}
                        onSelect={() => {
                          setExecutionMode('container');
                          setCustomCwd('');
                          clearSubmissionErrors();
                        }}
                        icon={Box}
                        title="Docker 模式"
                        badge={<Badge variant="neutral">推荐</Badge>}
                        description="在隔离的 Docker 环境中执行"
                      />
                    )}
                    {canHostExec && (
                      <RadioCard
                        name="execution_mode"
                        value="host"
                        checked={executionMode === 'host'}
                        onSelect={() => {
                          setExecutionMode('host');
                          setInitMode('empty');
                          setInitSourcePath('');
                          setInitGitUrl('');
                          setHostMounts([]);
                          clearSubmissionErrors();
                        }}
                        icon={Monitor}
                        title="宿主机模式"
                        description="直接在服务器上执行"
                      />
                    )}
                  </div>
                  {canHostExec && adminHostOnlyMode && (
                    <Callout tone="warning" className="mt-2">
                      管理员纯宿主机模式已开启，新工作区固定直接在服务器上运行。
                    </Callout>
                  )}
                </fieldset>

                {/* Container mode: workspace source */}
                {executionMode === 'container' && (
                  <>
                    <fieldset>
                      <legend className="text-body leading-none font-medium">
                        工作区来源
                      </legend>
                      <div className="mt-1.5 space-y-2">
                        <RadioCard
                          name="init_mode"
                          value="empty"
                          checked={initMode === 'empty'}
                          onSelect={() => {
                            setInitMode('empty');
                            clearSubmissionErrors();
                          }}
                          title="空白工作区"
                          description="从空目录开始"
                        />
                        {canHostExec && (
                          <RadioCard
                            name="init_mode"
                            value="local"
                            checked={initMode === 'local'}
                            onSelect={() => {
                              setInitMode('local');
                              clearSubmissionErrors();
                            }}
                            icon={FolderInput}
                            title="复制本地目录"
                            description="将宿主机目录复制到工作区（隔离副本）"
                          />
                        )}
                        {initMode === 'local' && canHostExec && (
                          <div className="pl-6">
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
                            <RadioCard
                              name="init_mode"
                              value="git"
                              checked={initMode === 'git'}
                              onSelect={() => {
                                setInitMode('git');
                                clearSubmissionErrors();
                              }}
                              icon={GitBranch}
                              title="克隆 Git 仓库"
                              description="从 GitHub 等平台克隆仓库到工作区"
                            />
                            {initMode === 'git' && (
                              <div className="pl-6">
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
                                  className="font-mono"
                                />
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </fieldset>

                    {canHostExec && (
                      <div className="border-t border-surface-border pt-4">
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
                  </>
                )}

                {/* Host mode: custom cwd */}
                {executionMode === 'host' && (
                  <div className="space-y-3">
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
                    <Callout tone="warning">
                      宿主机模式下智能体可访问完整文件系统和工具链，请谨慎使用。
                    </Callout>
                  </div>
                )}
              </div>
            )}
          </div>

          {submitError && (
            <div
              className="rounded-lg bg-error/10 px-3 py-2 text-caption leading-5 text-error"
              role="alert"
              aria-live="assertive"
            >
              {submitError}
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0">
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
            {loading && <Loader2 className="animate-spin" />}
            {loading && (initMode === 'local' || initMode === 'git')
              ? '正在初始化工作区...'
              : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
