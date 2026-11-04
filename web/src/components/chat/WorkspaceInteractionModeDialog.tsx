import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/capabilities/capability-ui';
import type { InteractionMode, ProcessVisibility } from '../../types';
import { useAgentProfilesStore } from '../../stores/agent-profiles';
import {
  useWorkspaceAgentId,
  WorkspaceAgentField,
} from '../agents/WorkspaceAgentField';
import { getErrorMessage } from '../settings/types';
import { InteractionModeSelector } from './InteractionModeSelector';
import { ProcessVisibilitySelector } from './ProcessVisibilitySelector';
import { WorkModeSelector } from './WorkModeSelector';
import { useWorkItemsStore } from '../../stores/work-items';
import { isDelegated } from '../../lib/multitask';
import type { WorkMode } from '../../work-items';

interface WorkspaceInteractionModeDialogProps {
  open: boolean;
  /** The Workspace whose Agent can be changed here. */
  groupJid?: string;
  workspaceName: string;
  currentMode: InteractionMode;
  currentVisibility: ProcessVisibility;
  currentWorkMode: WorkMode;
  onClose: () => void;
  onSave: (mode: InteractionMode) => Promise<boolean>;
  onSaveVisibility: (visibility: ProcessVisibility) => Promise<boolean>;
  onSaveWorkMode: (mode: WorkMode) => Promise<boolean>;
}

export function WorkspaceInteractionModeDialog({
  open,
  groupJid,
  workspaceName,
  currentMode,
  currentVisibility,
  currentWorkMode,
  onClose,
  onSave,
  onSaveVisibility,
  onSaveWorkMode,
}: WorkspaceInteractionModeDialogProps) {
  const [draftMode, setDraftMode] = useState(currentMode);
  const [draftVisibility, setDraftVisibility] = useState(currentVisibility);
  const [draftWorkMode, setDraftWorkMode] = useState(currentWorkMode);
  // Only a Web Workspace belongs to an Agent and has a work mode.
  const workspaceJid = groupJid?.startsWith('web:') ? groupJid : undefined;
  // Tasks delegated and still running, for the notice on leaving multi-task.
  const watchDelegations =
    open && !!workspaceJid && currentWorkMode === 'multi';
  const ensureWorkspace = useWorkItemsStore((s) => s.ensureWorkspace);
  useEffect(() => {
    if (watchDelegations && workspaceJid) ensureWorkspace(workspaceJid);
  }, [watchDelegations, workspaceJid, ensureWorkspace]);
  const delegationsOpen = useWorkItemsStore(
    (s) =>
      watchDelegations &&
      Object.values(s.items).some(
        (item) =>
          item.workspaceJid === workspaceJid &&
          isDelegated(item) &&
          item.status === 'open',
      ),
  );
  const currentAgentId = useWorkspaceAgentId(workspaceJid);
  const [draftAgentId, setDraftAgentId] = useState(currentAgentId);
  const setWorkspaceAgentProfile = useAgentProfilesStore(
    (state) => state.setWorkspaceAgentProfile,
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraftMode(currentMode);
      setDraftVisibility(currentVisibility);
      setDraftWorkMode(currentWorkMode);
      setDraftAgentId(currentAgentId);
    }
  }, [currentAgentId, currentMode, currentVisibility, currentWorkMode, open]);

  // Only a proactive workspace has a process to show or hide: an Assistant
  // workspace always shows its whole process on the Web.
  const visibilityApplies = draftMode === 'proactive';

  const handleSave = async () => {
    const agentChanged =
      !!workspaceJid && !!draftAgentId && draftAgentId !== currentAgentId;
    const modeChanged = draftMode !== currentMode;
    const visibilityChanged =
      visibilityApplies && draftVisibility !== currentVisibility;
    const workModeChanged = !!workspaceJid && draftWorkMode !== currentWorkMode;
    if (
      !agentChanged &&
      !modeChanged &&
      !visibilityChanged &&
      !workModeChanged
    ) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      if (agentChanged) {
        try {
          await setWorkspaceAgentProfile(workspaceJid, draftAgentId);
        } catch (err) {
          toast.error(`更换智能体失败：${getErrorMessage(err, '请重试')}`);
          return;
        }
      }
      if (modeChanged) {
        const saved = await onSave(draftMode);
        if (!saved) {
          toast.error('回复模式保存失败，请重试');
          return;
        }
      }
      if (visibilityChanged) {
        const saved = await onSaveVisibility(draftVisibility);
        if (!saved) {
          toast.error('过程可见性保存失败，请重试');
          return;
        }
      }
      if (workModeChanged) {
        const saved = await onSaveWorkMode(draftWorkMode);
        if (!saved) {
          toast.error('工作方式保存失败，请重试');
          return;
        }
      }
      toast.success(
        modeChanged
          ? `已切换为${draftMode === 'proactive' ? '主动模式' : 'Assistant 模式'}`
          : workModeChanged
            ? `已切换为${draftWorkMode === 'multi' ? '多任务' : '单任务'}`
            : visibilityChanged
              ? '过程可见性已更新'
              : '已更换工作区智能体',
      );
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !saving) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>工作区设置</DialogTitle>
          <DialogDescription>
            设置“{workspaceName}
            ”的所属智能体、工作方式，以及由谁控制对用户发消息的时机和数量。
          </DialogDescription>
        </DialogHeader>

        {workspaceJid && (
          <WorkspaceAgentField
            groupJid={workspaceJid}
            value={draftAgentId}
            onChange={setDraftAgentId}
            disabled={saving}
          />
        )}

        {workspaceJid && (
          <WorkModeSelector
            value={draftWorkMode}
            onChange={setDraftWorkMode}
            name="workspace-work-mode"
            disabled={saving}
            description="切换不会中断正在进行的对话，从下一轮开始生效。"
            notice={
              draftWorkMode === 'single' &&
              delegationsOpen && (
                <Callout tone="warning" role="status" className="mt-2">
                  已派出的任务会继续完成并汇报，之后不再派新任务。
                </Callout>
              )
            }
          />
        )}

        <InteractionModeSelector
          value={draftMode}
          onChange={setDraftMode}
          name="workspace-interaction-mode"
          disabled={saving}
          description="同一模式会应用到该工作区的 Web、飞书和所有已绑定渠道；渠道只负责选择流式卡片、普通消息或消息气泡等具体呈现。"
        />

        <Callout>
          切换会安全重启该工作区的智能体运行时；身份、Skills、记忆与渠道绑定保持不变。正在运行的任务会先停止，后续消息按新模式处理。
        </Callout>

        {visibilityApplies && (
          <ProcessVisibilitySelector
            value={draftVisibility}
            onChange={setDraftVisibility}
            name="workspace-process-visibility"
            disabled={saving}
          />
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={saving}
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            aria-busy={saving}
          >
            {saving && (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            )}
            {saving ? '正在保存…' : '保存更改'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
