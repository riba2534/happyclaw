import { useMemo } from 'react';
import { Pause, PanelRight, Play, Timer, Trash2 } from 'lucide-react';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { InfoTip } from '@/components/common/InfoTip';
import { cn } from '@/lib/utils';
import type { Automation } from '../../lib/automation';
import {
  automationUnreadTone,
  automationsForSession,
  boundAutomationsOf,
  isAutomationRunning,
  nextRunText,
} from '../../lib/automation-presentation';
import type { AutomationSessionGroup } from '../../lib/session-presentation';
import { sessionJidOf } from '../../lib/session-jid';
import { useAutomationsStore } from '../../stores/automations';
import { useIsGuest } from '../../stores/auth';
import { useShellStore } from '../../stores/shell';
import type { AgentInfo } from '../../types';
import type { NavigateToPath } from '../../lib/chat-navigation';
import {
  automationHref,
  deleteAutomationWithConfirm,
  runAutomationNow,
  setAutomationEnabled,
} from './automation-actions';

// Pieces of the automations list, the session tree and the chat header.

/** The red or green dot of unread runs. */
export function UnreadDot({
  automation,
  className,
}: {
  automation: Automation;
  className?: string;
}) {
  const tone = automationUnreadTone(automation);
  if (!tone) return null;
  return (
    <span
      role="img"
      aria-label={
        tone === 'error'
          ? `${automation.unreadRuns} 次未读运行，最近一次失败`
          : `${automation.unreadRuns} 次未读运行`
      }
      data-tone={tone}
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        tone === 'error' ? 'bg-error' : 'bg-success',
        className,
      )}
    />
  );
}

/** Automations whose runs come to a session, for the chat header. */
export function useSessionAutomations(
  sessionJid: string,
  generatedBy?: string | null,
): Automation[] {
  const automations = useAutomationsStore((s) => s.automations);
  return useMemo(
    () => automationsForSession(automations, sessionJid, generatedBy),
    [automations, sessionJid, generatedBy],
  );
}

/** The timer mark's automations for each session row of a workspace. */
export function useBoundAutomations(
  workspaceJid: string,
): (session: AgentInfo) => Automation[] {
  const automations = useAutomationsStore((s) => s.automations);
  return useMemo(
    () => (session) =>
      boundAutomationsOf(
        automations,
        sessionJidOf(workspaceJid, session.id),
        session.automation_id,
      ),
    [automations, workspaceJid],
  );
}

/** What an automation's group row in the session tree shows and toggles. */
export function useAutomationGroup(group: AutomationSessionGroup) {
  const automation = useAutomationsStore((s) =>
    s.automations.find((item) => item.id === group.automationId),
  );
  const expanded = useShellStore(
    (s) => !!s.expandedAutomationGroups[group.automationId],
  );
  const setExpanded = useShellStore((s) => s.setAutomationGroupExpanded);
  return {
    automation,
    name: automation?.name ?? group.name,
    running:
      (!!automation && isAutomationRunning(automation)) ||
      group.sessions.some((session) => session.status === 'running'),
    expanded,
    toggle: () => setExpanded(group.automationId, !expanded),
  };
}

function markText(automation: Automation): string {
  if (automation.status !== 'active') return '已暂停';
  return nextRunText(automation) ?? '没有计划中的运行';
}

/** The timer mark on a session row bound to automations. */
export function BoundAutomationMark({
  automations,
  className,
}: {
  automations: Automation[];
  className?: string;
}) {
  if (automations.length === 0) return null;
  const label = `绑定了自动化：${automations.map((item) => item.name).join('、')}`;
  // Touch has no hover: there a tap on the mark opens the list, so it sits
  // above a row's stretched link and takes a finger-sized area around it.
  return (
    <InfoTip
      content={
        <ul className="space-y-0.5">
          {automations.map((automation) => (
            <li key={automation.id}>
              {automation.name} · {markText(automation)}
            </li>
          ))}
        </ul>
      }
    >
      <span
        role="img"
        aria-label={label}
        className={cn(
          'inline-flex shrink-0 text-faint-foreground pointer-coarse:relative pointer-coarse:z-10 pointer-coarse:before:absolute pointer-coarse:before:-inset-2.5',
          className,
        )}
      >
        <Timer className="size-3" />
      </span>
    </InfoTip>
  );
}

/** ⋯ items of an automation group in the session tree. */
export function AutomationMenuItems({
  automation,
  navigate,
}: {
  automation: Automation;
  navigate: NavigateToPath;
}) {
  const isGuest = useIsGuest();
  const enabled = automation.status === 'active';
  const details = (
    <DropdownMenuItem onClick={() => navigate(automationHref(automation.id))}>
      <PanelRight />
      查看详情
    </DropdownMenuItem>
  );
  // Read-only guests only look.
  if (isGuest) return details;
  return (
    <>
      {details}
      <DropdownMenuItem onClick={() => void runAutomationNow(automation.id)}>
        <Play />
        立即运行
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => void setAutomationEnabled(automation.id, !enabled)}
      >
        {enabled ? <Pause /> : <Play />}
        {enabled ? '暂停' : '启用'}
      </DropdownMenuItem>
      <DropdownMenuItem
        variant="destructive"
        onClick={() => void deleteAutomationWithConfirm(automation)}
      >
        <Trash2 />
        删除自动化
      </DropdownMenuItem>
    </>
  );
}
