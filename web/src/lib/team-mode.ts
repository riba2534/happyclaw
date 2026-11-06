import type { AgentInfo, AvailableImGroup } from '../types';
import { hasBindingPolicyMismatch } from '../utils/im-binding-policy';
import type {
  AdmissionOutcome,
  AdmissionTable,
  TeamAcceptMode,
  TeamSettings,
  WorkDecisionKind,
  WorkEventKind,
  WorkItemOrigin,
  WorkItemView,
  WorkReportState,
  WorkStage,
} from '../work-items';
export type {
  TeamMountView,
  WorkEvent,
  WorkEventKind,
  WorkItemDetail,
} from '../work-items';
export { TEAM_RULE_NAME_LIMIT } from '../work-items';
import { isWorkItemWritable } from '../work-items';
import { formatAutomationTime } from './automation';
import { isDelegated } from './multitask';

// Team mode (团队模式) on the Web: the REST shapes the shared file does not
// carry and the words people read for stages, mandates and decisions.

export type TeamSettingsDraft = Omit<TeamSettings, 'version'>;

/** Ended items and recorded decisions fetched per workspace and shown. */
export const WORK_RECENT_LIMIT = 20;

type BadgeVariant = 'info' | 'success' | 'warning' | 'error' | 'neutral';

const OUTCOME_LABELS = {
  completed: '已完成',
  dropped: '无需处理',
  stopped: '已停止',
  failed: '失败',
} as const;

/** What the stage words read: a team item, or a delegated task when known. */
type StageItem = Pick<WorkItemView, 'stage' | 'outcome'> &
  Partial<Pick<WorkItemView, 'origin'>>;

/**
 * A delegated task in five words. Its worker may edit from the start and
 * never reports `waiting`; a blocked report carries the question, so
 * blocked reads as waiting for an answer.
 */
function delegatedStageLabel(item: StageItem): string {
  switch (item.stage) {
    case 'answer':
    case 'blocked':
      return '等你回答';
    case 'failed':
      return '失败';
    case 'ended':
      return item.outcome === 'completed' || item.outcome === 'failed'
        ? OUTCOME_LABELS[item.outcome]
        : OUTCOME_LABELS.stopped;
    default:
      return '进行中';
  }
}

/** The stage in a few words: who it waits for and what for. */
export function workStageLabel(item: StageItem): string {
  if (isDelegated(item)) return delegatedStageLabel(item);
  switch (item.stage) {
    case 'answer':
      return '等你回答';
    case 'approval':
      return '等你批准修改';
    case 'blocked':
      return '受阻';
    case 'failed':
      return '失败';
    case 'working':
      return '工作中';
    case 'idle':
      return '等待新消息';
    case 'ended':
      return item.outcome ? OUTCOME_LABELS[item.outcome] : '已结束';
  }
}

/** The stage as a sentence, with the question when one waits. */
export function workStageText(
  item: StageItem & Pick<WorkItemView, 'attention'>,
): string {
  if (item.stage === 'answer' && item.attention)
    return `等你回答：${item.attention}`;
  return workStageLabel(item);
}

export function workStageVariant(item: StageItem): BadgeVariant {
  if (isDelegated(item) && item.stage !== 'ended')
    return item.stage === 'answer' || item.stage === 'blocked'
      ? 'warning'
      : item.stage === 'failed'
        ? 'error'
        : 'info';
  const variants: Record<Exclude<WorkStage, 'ended'>, BadgeVariant> = {
    answer: 'warning',
    approval: 'warning',
    blocked: 'error',
    failed: 'error',
    working: 'info',
    idle: 'neutral',
  };
  if (item.stage !== 'ended') return variants[item.stage];
  if (item.outcome === 'completed') return 'success';
  return item.outcome === 'failed' ? 'error' : 'neutral';
}

/** The words that differ between a team item and a delegated task. */
const WORK_ORIGIN_WORDS: Record<
  WorkItemOrigin,
  {
    /** The worker session's tag in the session tree. */
    noun: string;
    /** The session that does the work. */
    session: string;
    /** The heading over what started the item. */
    request: string;
    /** What stopping does, in the confirmation. */
    stop: string;
  }
> = {
  team: {
    noun: '工作项',
    session: '执行会话',
    request: '原始消息',
    stop: '执行会话会被中断，工作项记为已停止。之后群里的回复不会再恢复它。',
  },
  delegated: {
    noun: '后台任务',
    session: 'Worker 会话',
    request: '任务内容',
    stop: 'Worker 会被中断，任务记为已停止，Agent 会收到停止的通知。',
  },
};

export function workOriginWords(item: Pick<WorkItemView, 'origin'>) {
  return WORK_ORIGIN_WORDS[isDelegated(item) ? 'delegated' : 'team'];
}

/**
 * Where an item came from, after its workspace: a team item's group, a
 * delegated task's session (null once deleted).
 */
export function workItemSource(
  item: Pick<WorkItemView, 'origin' | 'channelName' | 'originSessionName'>,
): string | null {
  return isDelegated(item) ? item.originSessionName : item.channelName;
}

/** Whether edits are allowed, in words. */
export function workPermissionText(
  item: Pick<WorkItemView, 'mandate' | 'approvedAt'>,
): string {
  if (!isWorkItemWritable(item)) return '只读，批准后才能修改';
  return item.mandate.writable ? '可以修改' : '已批准修改';
}

export function workItemHref(id: string): string {
  return `/work/${encodeURIComponent(id)}`;
}

export function workItemTitle(item: Pick<WorkItemView, 'seq' | 'title'>) {
  return `#${item.seq} ${item.title}`;
}

export function formatWorkTime(iso: string): string {
  return formatAutomationTime(iso);
}

export const WORK_REPORT_LABELS: Record<WorkReportState, string> = {
  progress: '进展',
  waiting: '等待新消息',
  ready: '完成',
  blocked: '受阻',
  failed: '失败',
  dropped: '无需处理',
};

export const WORK_EVENT_LABELS: Record<WorkEventKind, string> = {
  report: '汇报',
  ack: '确认收到',
  reply: '群里回复',
  handback: '交回路由',
  input: '新消息',
  stop: '停止',
  approve: '批准修改',
  resume: '恢复',
};

export const WORK_DECISION_LABELS: Record<WorkDecisionKind, string> = {
  accept: '接单',
  attach: '并入工作项',
  stop: '停止',
  ignore: '忽略',
  would_accept: '本会接单',
};

/** A subscription key (`msg:<id>` / `thread:<id>`) in words. */
export function subscriptionLabel(subKey: string): string {
  const [kind, ...rest] = subKey.split(':');
  const id = rest.join(':');
  if (kind === 'thread') return `话题 ${id}`;
  if (kind === 'msg') return `消息 ${id} 的回复`;
  return subKey;
}

// ── Settings ───────────────────────────────────────────────────────────

export const ADMISSION_LABELS: Record<AdmissionOutcome, string> = {
  explicit: '算请求',
  inferred: '只作候选',
  ignore: '忽略',
};

export const ADMISSION_ROWS: {
  key: keyof AdmissionTable;
  label: string;
  options: AdmissionOutcome[];
}[] = [
  {
    key: 'listedUnaddressed',
    label: '名单内、没 @',
    options: ['inferred', 'ignore'],
  },
  {
    key: 'unlistedAddressed',
    label: '名单外、@ 了',
    options: ['explicit', 'inferred', 'ignore'],
  },
  {
    key: 'unlistedUnaddressed',
    label: '名单外、没 @',
    options: ['inferred', 'ignore'],
  },
];

export const ACCEPT_MODE_OPTIONS: {
  value: TeamAcceptMode;
  label: string;
  description: string;
}[] = [
  {
    value: 'off',
    label: '关闭',
    description: '只处理明确请求，候选一律忽略。',
  },
  {
    value: 'observe',
    label: '只记录',
    description: '候选命中规则时只记一条决策，不开工作项，供你复核。',
  },
  {
    value: 'auto',
    label: '自动',
    description: '候选命中规则时自动开一个只读工作项。',
  },
];

export function toSettingsDraft(settings: TeamSettings): TeamSettingsDraft {
  return {
    enabled: settings.enabled,
    admission: { ...settings.admission },
    acceptMode: settings.acceptMode,
    rules: settings.rules.map((rule) => ({ ...rule })),
    ...(settings.candidateIntake
      ? {
          candidateIntake: {
            ...settings.candidateIntake,
            keywords: [...settings.candidateIntake.keywords],
            prioritySenderIds: [...settings.candidateIntake.prioritySenderIds],
          },
        }
      : {}),
  };
}

/** First problem that keeps the draft from saving, or null. */
export function teamSettingsProblem(draft: TeamSettingsDraft): string | null {
  for (const [index, rule] of draft.rules.entries()) {
    if (!rule.name.trim()) return `第 ${index + 1} 条规则缺少名称`;
    if (!rule.instruction.trim()) return `规则「${rule.name}」缺少说明`;
  }
  return null;
}

/** Whether a chat could carry team mode: a Feishu ordinary group, bound cleanly. */
export function canCarryTeamMode(group: AvailableImGroup): boolean {
  return (
    group.channel_type === 'feishu' &&
    group.conversation_kind === 'group' &&
    !hasBindingPolicyMismatch(group)
  );
}

/**
 * The workspace a binding row can turn team mode on in: that of the session
 * a Feishu ordinary group is bound to (`workspaceOfSession` names it). The
 * server still decides eligibility.
 */
export function teamModeWorkspaceOf(
  group: AvailableImGroup,
  workspaceOfSession: (sessionId: string) => string | null | undefined,
): string | null {
  if (!canCarryTeamMode(group)) return null;
  const sessionId = group.bound_session_id ?? group.bound_agent_id;
  return (sessionId && workspaceOfSession(sessionId)) || null;
}

/** The router and worker sessions team mode opens. */
export function isTeamSession(session: Pick<AgentInfo, 'source_kind'>) {
  return (
    session.source_kind === 'team_router' || session.source_kind === 'work_item'
  );
}
