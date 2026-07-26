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
import { getAgentContextSource } from '../../types';
import type { InteractionMode } from '../../types';
import { workspaceCreationBlockReason } from '../../utils/agent-product';
import { InteractionModeSelector } from './InteractionModeSelector';

interface CreateContainerDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (jid: string, folder: string) => void;
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

  const createFlow = useChatStore((s) => s.createFlow);
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

  const reset = () => {
    setName('');
    setAdvancedOpen(false);
    setExecutionMode('container');
    setCustomCwd('');
    setInitMode('empty');
    setInitSourcePath('');
    setInitGitUrl('');
    setSelectedAgentProfileId('');
    setInteractionMode('assistant');
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

    setLoading(true);
    try {
      const options: Record<string, string> = {};
      if (executionMode === 'host' && canHostExec) {
        options.execution_mode = 'host';
        if (customCwd.trim()) options.custom_cwd = customCwd.trim();
      } else {
        if (initMode === 'local' && initSourcePath.trim()) {
          options.init_source_path = initSourcePath.trim();
        } else if (initMode === 'git' && initGitUrl.trim()) {
          options.init_git_url = initGitUrl.trim();
        }
      }
      if (selectedAgentProfileId)
        options.agent_profile_id = selectedAgentProfileId;
      options.interaction_mode = interactionMode;
      const created = await createFlow(
        trimmed,
        Object.keys(options).length ? options : undefined,
      );
      if (created) {
        onCreated(created.jid, created.folder);
        handleClose();
      } else {
        toast.error('创建失败，请重试');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>为 Agent 新建工作区</DialogTitle>
          <DialogDescription>
            选择 Agent，并确认工作区的回复模式、运行位置和上下文。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">Agent</label>
            <Select
              value={selectedAgentProfileId}
              onValueChange={setSelectedAgentProfileId}
              disabled={profilesLoading || profiles.length === 0}
            >
              <SelectTrigger className="w-full">
                <SelectValue
                  placeholder={
                    profilesLoading ? '正在加载 Agent...' : '选择 Agent'
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
                  Agent 列表加载失败：{profilesError}
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
                暂无可用 Agent，请先到 Agent 页面创建。
              </p>
            )}
            {profiles.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                {selectedProfile?.identity_prompt ||
                  '使用默认 Agent 行为，不追加额外身份提示词。'}
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
            <label className="block text-sm font-medium mb-2">工作区名称</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirm();
              }}
              placeholder="输入这个 Agent 工作区的名称"
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
                    Agent 上下文
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
                    ? `运行位置只决定命令在哪里执行。该 Agent 会将完整 ~/.claude 作为用户配置层叠加，工作区仍是 cwd；宿主机 Skills：${hostSkillsMode === 'inherit' ? '全部使用' : hostSkillsMode === 'custom' ? `选择 ${selectedProfile?.runtime_policy.skills.host?.ids.length ?? 0} 项` : '不使用'}。`
                    : '运行位置只决定命令在哪里执行。该 Agent 使用 HappyClaw 管理的上下文与附加能力。'
                  : '工作区固定在 Docker 容器中运行，并使用 HappyClaw 管理的 Agent 上下文与附加能力。'}
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
                    <label className="flex items-start gap-3 p-2 rounded-lg border cursor-pointer hover:bg-accent/50 transition-colors">
                      <input
                        type="radio"
                        name="execution_mode"
                        value="container"
                        checked={executionMode === 'container'}
                        onChange={() => {
                          setExecutionMode('container');
                          setCustomCwd('');
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
                  </div>
                </div>

                {/* Container mode: workspace source */}
                {executionMode === 'container' && (
                  <div className="pt-1">
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
                          onChange={() => setInitMode('empty')}
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
                            onChange={() => setInitMode('local')}
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
                            onChange={setInitSourcePath}
                            placeholder="选择要复制的目录"
                          />
                        </div>
                      )}
                      <label className="flex items-start gap-3 p-2 rounded-lg border cursor-pointer hover:bg-accent/50 transition-colors">
                        <input
                          type="radio"
                          name="init_mode"
                          value="git"
                          checked={initMode === 'git'}
                          onChange={() => setInitMode('git')}
                          className="mt-0.5 accent-primary"
                        />
                        <div className="flex-1">
                          <div className="flex items-center gap-1.5">
                            <GitBranch className="w-4 h-4 text-muted-foreground" />
                            <span className="text-sm font-medium">
                              克隆 Git 仓库
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            从 GitHub 等平台克隆仓库到工作区
                          </p>
                        </div>
                      </label>
                      {initMode === 'git' && (
                        <div className="ml-6">
                          <Input
                            value={initGitUrl}
                            onChange={(e) => setInitGitUrl(e.target.value)}
                            placeholder="https://github.com/user/repo"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Host mode: custom cwd */}
                {executionMode === 'host' && (
                  <>
                    <DirectoryBrowser
                      value={customCwd}
                      onChange={setCustomCwd}
                      placeholder="默认: data/groups/{folder}/"
                    />
                    <div className="flex items-start gap-2 p-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
                      <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-amber-700 dark:text-amber-300">
                        宿主机模式下 Agent
                        可访问完整文件系统和工具链，请谨慎使用。
                      </p>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={loading}>
            取消
          </Button>
          <Button
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
