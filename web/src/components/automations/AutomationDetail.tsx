import { useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Loader2,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { IconButton } from '@/components/common/IconButton';
import {
  ResponsiveMenu,
  type MenuAction,
} from '@/components/common/ResponsiveMenu';
import {
  AUTOMATION_SESSION_MODE_LABELS,
  AUTOMATION_STATUS_LABELS,
  describeAutomationSchedule,
  formatAutomationTime,
  type Automation,
} from '../../lib/automation';
import {
  AUTOMATION_EXECUTION_LABELS,
  groupAutomationRuns,
} from '../../lib/automation-presentation';
import { sessionIdOf, workspaceJidOf } from '../../lib/session-jid';
import { openWorkspaceSession } from '../../lib/chat-navigation';
import { useAutomationsStore } from '../../stores/automations';
import { useIsGuest } from '../../stores/auth';
import { useChatStore } from '../../stores/chat';
import { extractErrorMessage } from '../../utils/error';
import {
  deleteAutomationWithConfirm,
  runAutomationNow,
  setAutomationEnabled,
} from './automation-actions';
import { AutomationRunGroup } from './AutomationRunCard';
import { PhonePageHeader, PhoneBarButton } from '../layout/PhonePageHeader';
import { useIsPhone } from '../layout/phone';

/** A session JID as the user knows it: its name. */
export function useSessionLabel(): (sessionJid: string) => string {
  const agents = useChatStore((s) => s.agents);
  return useCallback(
    (sessionJid: string) => {
      const sessionId = sessionIdOf(sessionJid);
      const workspaceJid = workspaceJidOf(sessionJid);
      return (
        (sessionId &&
          agents[workspaceJid]?.find((agent) => agent.id === sessionId)
            ?.name) ||
        '会话'
      );
    },
    [agents],
  );
}

function sessionDestination(
  automation: Automation,
  sessionLabel: (jid: string) => string,
): string {
  const mode = AUTOMATION_SESSION_MODE_LABELS[automation.sessionMode];
  if (automation.sessionMode === 'fresh' || !automation.targetSessionJid)
    return mode;
  return `${mode}「${sessionLabel(automation.targetSessionJid)}」`;
}

export function AutomationDetail({
  automation,
  onBack,
}: {
  automation: Automation;
  /** Phones: back to the list. */
  onBack?: () => void;
}) {
  const navigate = useNavigate();
  const isPhone = useIsPhone();
  const runs = useAutomationsStore((s) => s.runs[automation.id]);
  const busy = useAutomationsStore((s) => !!s.runBusy[automation.id]);
  const loadDetail = useAutomationsStore((s) => s.loadDetail);
  const markRead = useAutomationsStore((s) => s.markRead);
  const openEditForm = useAutomationsStore((s) => s.openEditForm);
  const cancelRun = useAutomationsStore((s) => s.cancelRun);
  const loadAgents = useChatStore((s) => s.loadAgents);
  const sessionLabel = useSessionLabel();
  // Read-only guests: no run, edit, pause, delete, cancel or read marks.
  const readOnly = useIsGuest();

  useEffect(() => {
    void loadDetail(automation.id).catch((err) =>
      toast.error(`加载运行记录失败：${extractErrorMessage(err)}`),
    );
    // Session names for the destination and the run groups.
    void loadAgents(automation.workspaceJid);
  }, [automation.id, automation.workspaceJid, loadDetail, loadAgents]);

  // Seeing the detail reads its runs, also those that finish while it is open.
  const unread = automation.unreadRuns ?? 0;
  useEffect(() => {
    if (unread > 0 && !readOnly) void markRead(automation.id);
  }, [automation.id, unread, readOnly, markRead]);

  const groups = useMemo(
    () => groupAutomationRuns(runs ?? [], automation.sessionMode),
    [runs, automation.sessionMode],
  );

  const openSession = (sessionJid: string) => {
    const sessionId = sessionIdOf(sessionJid);
    if (!sessionId) return;
    openWorkspaceSession(
      navigate,
      { jid: automation.workspaceJid, folder: automation.workspaceFolder },
      sessionId,
    );
  };
  const handleCancel = async (runId: string) => {
    try {
      await cancelRun(automation.id, runId);
    } catch (err) {
      toast.error(`终止失败：${extractErrorMessage(err)}`);
    }
  };

  const meta = [
    describeAutomationSchedule(automation.schedule),
    AUTOMATION_EXECUTION_LABELS[automation.execution],
    sessionDestination(automation, sessionLabel),
  ].join(' · ');
  const enabled = automation.status === 'active';
  const runNow = () => void runAutomationNow(automation.id);
  const deleteAction: MenuAction = {
    label: '删除自动化',
    icon: Trash2,
    destructive: true,
    onSelect: async () => {
      if (await deleteAutomationWithConfirm(automation)) onBack?.();
    },
  };
  // A phone's top bar keeps 立即运行 and puts the rest behind ⋯.
  const menuGroups: MenuAction[][] = [
    [
      {
        label: '编辑',
        icon: Pencil,
        onSelect: () => openEditForm(automation.id),
      },
      {
        label: enabled ? '暂停' : '启用',
        icon: enabled ? Pause : Play,
        onSelect: () => void setAutomationEnabled(automation.id, !enabled),
      },
    ],
    [deleteAction],
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PhonePageHeader
        title={automation.name}
        onBack={onBack}
        action={
          !readOnly && (
            <PhoneBarButton
              label="立即运行"
              icon={busy ? <Loader2 className="animate-spin" /> : <Play />}
              disabled={busy}
              onClick={runNow}
            />
          )
        }
        menu={
          readOnly ? undefined : { title: automation.name, groups: menuGroups }
        }
      />
      <header className="flex shrink-0 items-start gap-2 border-b border-surface-border px-5 py-4 phone:px-4 phone:pt-0 phone:pb-3">
        {onBack && !isPhone && (
          <IconButton
            label="返回自动化列表"
            icon={<ArrowLeft />}
            onClick={onBack}
            hideTooltip
            className="-ml-1.5 shrink-0"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {/* A phone shows the name in its top bar. */}
            <h1 className="truncate text-title text-foreground phone:sr-only">
              {automation.name}
            </h1>
            {automation.status !== 'active' && (
              <Badge variant="neutral">
                {AUTOMATION_STATUS_LABELS[automation.status]}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-caption text-muted-foreground">{meta}</p>
        </div>
        {!isPhone && !readOnly && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={runNow}
            >
              {busy ? <Loader2 className="animate-spin" /> : <Play />}
              立即运行
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openEditForm(automation.id)}
            >
              <Pencil />
              编辑
            </Button>
            <Switch
              aria-label={enabled ? '暂停自动化' : '启用自动化'}
              checked={enabled}
              onCheckedChange={(value) =>
                void setAutomationEnabled(automation.id, value)
              }
              className="mx-1.5"
            />
            <ResponsiveMenu
              title="更多操作"
              groups={[[deleteAction]]}
              trigger={
                <IconButton
                  label="更多操作"
                  icon={<MoreHorizontal />}
                  hideTooltip
                />
              }
            />
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 phone:px-4">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-body">
          {automation.statusReason && (
            <>
              <dt className="text-muted-foreground">状态</dt>
              <dd className="text-foreground">{automation.statusReason}</dd>
            </>
          )}
          {enabled && automation.nextFireAt && (
            <>
              <dt className="text-muted-foreground">下次运行</dt>
              <dd className="text-foreground tabular-nums">
                {formatAutomationTime(
                  automation.nextFireAt,
                  automation.schedule.timezone,
                )}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">停止条件</dt>
          <dd className="break-words text-foreground">
            {automation.stopWhen || (
              <span className="text-faint-foreground">未设置</span>
            )}
          </dd>
          <dt className="text-muted-foreground">结束时间</dt>
          <dd className="text-foreground tabular-nums">
            {automation.endAt ? (
              formatAutomationTime(automation.endAt)
            ) : (
              <span className="text-faint-foreground">未设置</span>
            )}
          </dd>
        </dl>

        <h2 className="mt-6 mb-2 text-label font-medium text-foreground">
          最近运行 · {runs?.length ?? 0}
        </h2>
        {runs === undefined ? (
          <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            正在加载运行记录…
          </p>
        ) : groups.length === 0 ? (
          <p className="text-caption text-muted-foreground">
            {readOnly
              ? '暂无运行记录。'
              : '暂无运行记录。点击立即运行，或等待下次触发。'}
          </p>
        ) : (
          <div className="space-y-2">
            {groups.map((group) => (
              <AutomationRunGroup
                key={group.kind === 'single' ? group.run.id : group.sessionJid}
                group={group}
                sessionLabel={sessionLabel}
                onOpenSession={openSession}
                onCancel={readOnly ? undefined : handleCancel}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
