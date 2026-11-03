/**
 * Team mode (团队模式): the shapes the host, the Runner and the Web share.
 *
 * A group mount with team mode on answers through its workspace's main
 * session (the router) and runs each piece of authorized work as a work item
 * in a Runtime Session of its own (the worker). Messages on a thread a work
 * item subscribes to go straight to its worker; everything else passes the
 * admission table first. Only the router speaks in the group, through
 * `work_reply`; a worker confirms a request once with `work_ack` and reports
 * to the router with `work_report`.
 *
 * Multi-task mode (多任务模式) reuses the same work items outside any group:
 * in a workspace whose work mode is `multi`, a session delegates a sizeable
 * task with `work_delegate`, ends its turn and takes the next input; the
 * task runs as a delegated work item in a worker session of its own, whose
 * `work_report` comes back to the delegating session as an input.
 *
 * Canonical file: shared/work-items.ts, copied by `make sync-types`.
 */

// ── Mount settings ─────────────────────────────────────────────────────

/** What one admission cell turns a message into. */
export type AdmissionOutcome = 'explicit' | 'inferred' | 'ignore';

/**
 * How a message that reaches no work item is admitted, by whether its sender
 * is listed (the workspace owner or the group allowlist) and whether it
 * addresses the bot (a structural @ or a direct reply to the bot). A listed
 * sender who addresses the bot always makes an explicit request.
 */
export interface AdmissionTable {
  listedUnaddressed: 'inferred' | 'ignore';
  unlistedAddressed: AdmissionOutcome;
  unlistedUnaddressed: 'inferred' | 'ignore';
}

/**
 * `off`: nothing inferred reaches the router. `observe`: inferred candidates
 * are judged and a positive judgement is only recorded. `auto`: a positive
 * judgement opens a read-only work item.
 */
export type TeamAcceptMode = 'off' | 'observe' | 'auto';

/** Proactive work the team allows, in the team's own words. */
export interface TeamRule {
  id: string;
  name: string;
  instruction: string;
  enabled: boolean;
}

export interface TeamSettings {
  enabled: boolean;
  admission: AdmissionTable;
  acceptMode: TeamAcceptMode;
  rules: TeamRule[];
  /** Bumped on every save; recorded on each work item's mandate. */
  version: number;
}

export const DEFAULT_ADMISSION: AdmissionTable = {
  listedUnaddressed: 'ignore',
  unlistedAddressed: 'ignore',
  unlistedUnaddressed: 'ignore',
};

export const DEFAULT_TEAM_SETTINGS: TeamSettings = {
  enabled: false,
  admission: DEFAULT_ADMISSION,
  acceptMode: 'observe',
  rules: [],
  version: 0,
};

export const TEAM_RULE_LIMIT = 20;
export const TEAM_RULE_NAME_LIMIT = 60;
export const TEAM_RULE_TEXT_LIMIT = 2000;

const OUTCOMES = new Set<AdmissionOutcome>(['explicit', 'inferred', 'ignore']);

function unaddressed(value: unknown): 'inferred' | 'ignore' {
  return value === 'inferred' ? 'inferred' : 'ignore';
}

/** Stored JSON → settings; anything malformed reads as team mode off. */
export function parseTeamSettings(
  raw: string | null | undefined,
): TeamSettings {
  if (!raw) return DEFAULT_TEAM_SETTINGS;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return DEFAULT_TEAM_SETTINGS;
  }
  if (!value || typeof value !== 'object') return DEFAULT_TEAM_SETTINGS;
  const admission = (value.admission ?? {}) as Record<string, unknown>;
  const unlistedAddressed = OUTCOMES.has(
    admission.unlistedAddressed as AdmissionOutcome,
  )
    ? (admission.unlistedAddressed as AdmissionOutcome)
    : 'ignore';
  const acceptMode: TeamAcceptMode =
    value.acceptMode === 'off' || value.acceptMode === 'auto'
      ? value.acceptMode
      : 'observe';
  const rules = Array.isArray(value.rules)
    ? (value.rules as unknown[])
        .filter(
          (rule): rule is TeamRule =>
            !!rule &&
            typeof (rule as TeamRule).id === 'string' &&
            typeof (rule as TeamRule).name === 'string' &&
            typeof (rule as TeamRule).instruction === 'string',
        )
        .slice(0, TEAM_RULE_LIMIT)
        .map((rule) => ({
          id: rule.id,
          name: rule.name,
          instruction: rule.instruction,
          enabled: rule.enabled !== false,
        }))
    : [];
  return {
    enabled: value.enabled === true,
    admission: {
      listedUnaddressed: unaddressed(admission.listedUnaddressed),
      unlistedAddressed,
      unlistedUnaddressed: unaddressed(admission.unlistedUnaddressed),
    },
    acceptMode,
    rules,
    version: Number.isInteger(value.version) ? (value.version as number) : 0,
  };
}

/** Whether inferred candidates can exist at all under these settings. */
export function acceptsInferred(settings: TeamSettings): boolean {
  return (
    settings.acceptMode !== 'off' && settings.rules.some((rule) => rule.enabled)
  );
}

/**
 * The gate (program layer): a message that reached no work item becomes an
 * explicit request, an inferred candidate, or nothing. Bots never make
 * explicit requests and are not admitted at all in this version.
 */
export function admitMessage(
  settings: TeamSettings,
  message: { listed: boolean; addressed: boolean; fromBot: boolean },
): AdmissionOutcome {
  if (message.fromBot) return 'ignore';
  let outcome: AdmissionOutcome;
  if (message.listed) {
    outcome = message.addressed
      ? 'explicit'
      : settings.admission.listedUnaddressed;
  } else {
    outcome = message.addressed
      ? settings.admission.unlistedAddressed
      : settings.admission.unlistedUnaddressed;
  }
  if (outcome === 'inferred' && !acceptsInferred(settings)) return 'ignore';
  return outcome;
}

// ── Work items ─────────────────────────────────────────────────────────

export type WorkStrength = 'explicit' | 'inferred';

/**
 * Why a work item may be done: who asked, where, how strongly, under which
 * rules and settings version. Immutable once the item exists. `writable` is
 * false for inferred items and for requests from unlisted senders: their
 * worker may investigate and reproduce, but not edit, commit or push, until
 * the owner approves the item.
 */
export interface WorkMandate {
  strength: WorkStrength;
  requesterImId: string | null;
  requesterName: string | null;
  requesterListed: boolean;
  requesterIsOwner: boolean;
  matchedRules: { id: string; name: string; instruction: string }[];
  settingsVersion: number;
  writable: boolean;
}

export type WorkReportState =
  | 'progress'
  | 'waiting'
  | 'ready'
  | 'blocked'
  | 'failed'
  | 'dropped';

/** Every report state, in the order tools list them. */
export const WORK_REPORT_STATES = [
  'progress',
  'waiting',
  'ready',
  'blocked',
  'failed',
  'dropped',
] as const satisfies readonly WorkReportState[];

export type WorkItemStatus = 'open' | 'ended';

/** A work item's title, in characters. */
export const WORK_TITLE_CHAR_LIMIT = 60;
/** A routing note, in `countImWords` words. */
export const WORK_NOTE_WORD_LIMIT = 30;

/** How an ended item ended. */
export type WorkItemOutcome =
  | 'completed'
  | 'dropped'
  | 'failed'
  | 'stopped'
  | null;

/**
 * Where a work item came from: a team-mode group, or a session of a
 * multi-task workspace that delegated it.
 */
export type WorkItemOrigin = 'team' | 'delegated';

export interface WorkItem {
  id: string;
  /** `#<seq>` per workspace, for people. */
  seq: number;
  workspaceJid: string;
  workspaceFolder: string;
  /**
   * team: the Feishu group (route jid without suffixes) the item came from.
   * delegated: the delegating session's lane, `<workspaceJid>#agent:<id>`.
   */
  channelJid: string;
  /** The Runtime Session (agents.id) that does the work. */
  agentId: string;
  title: string;
  /**
   * team: the message that started the item, as the provider identifies it.
   * delegated: `delegate:<uuid>`, one per delegation (a turn may delegate
   * several tasks).
   */
  sourceMessageId: string;
  /**
   * team: the route its replies go to (the group's IM jid).
   * delegated: the source route of the input that delegated it, which the
   * report input keeps so the delegating session answers where it was asked.
   */
  sourceRouteJid: string;
  origin: WorkItemOrigin;
  /** delegated: the session (agents.id) that delegated it and gets its reports. */
  originAgentId: string | null;
  /** delegated: the input message the delegating turn was answering. */
  originInputId: string | null;
  mandate: WorkMandate;
  status: WorkItemStatus;
  outcome: WorkItemOutcome;
  lastReport: WorkReportState | null;
  lastSummary: string | null;
  /** A question waiting for a person, set by `work_report.human_action`. */
  attention: string | null;
  /** The message that raised the question, when one did. */
  attentionMessageId: string | null;
  /** The owner approved edits on an item that started read-only. */
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

/** Whether the item's worker may change files: its mandate, or an approval. */
export function isWorkItemWritable(
  item: Pick<WorkItem, 'mandate' | 'approvedAt'>,
): boolean {
  return item.mandate.writable || item.approvedAt !== null;
}

/**
 * The stage a person reads, derived and never stored. First match wins:
 * a question waits for an answer; a blocked or failed report waits for a
 * person; an item that cannot edit yet waits for approval; otherwise it is
 * working, or idle once its worker reported `waiting`.
 */
export type WorkStage =
  | 'answer'
  | 'blocked'
  | 'failed'
  | 'approval'
  | 'working'
  | 'idle'
  | 'ended';

export function deriveWorkStage(
  item: Pick<
    WorkItem,
    'status' | 'attention' | 'lastReport' | 'mandate' | 'approvedAt'
  >,
): WorkStage {
  if (item.status === 'ended') return 'ended';
  if (item.attention) return 'answer';
  if (item.lastReport === 'blocked') return 'blocked';
  if (item.lastReport === 'failed') return 'failed';
  if (!item.mandate.writable && !item.approvedAt && item.lastReport === 'ready')
    return 'approval';
  if (item.lastReport === 'waiting') return 'idle';
  return 'working';
}

/** Stages that wait for a person; the Web lists these first. */
export function stageNeedsPerson(stage: WorkStage): boolean {
  return (
    stage === 'answer' ||
    stage === 'blocked' ||
    stage === 'failed' ||
    stage === 'approval'
  );
}

/**
 * A subscription key: one provider message id or native thread id within a
 * chat. A message reaches the work items subscribed to its own id's parent,
 * root or thread. Keys are `msg:<id>` or `thread:<id>`.
 */
export function subscriptionKey(kind: 'msg' | 'thread', id: string): string {
  return `${kind}:${id}`;
}

export type WorkDecisionKind =
  | 'accept'
  | 'attach'
  | 'stop'
  | 'ignore'
  | 'would_accept';

/** One routing decision, kept for the Web's decision log. */
export interface WorkDecision {
  id: string;
  workspaceJid: string;
  channelJid: string;
  triggerMessageId: string;
  strength: WorkStrength;
  kind: WorkDecisionKind;
  workItemId: string | null;
  reason: string;
  matchedRuleIds: string[];
  createdAt: string;
}

// ── Messages to people ─────────────────────────────────────────────────

/** Hard ceiling for any team-mode message to an IM chat. */
export const TEAM_IM_WORD_LIMIT = 100;

/**
 * Words as a reader counts them: each CJK character is a word, a run of
 * Latin letters or digits is one, Markdown link targets count too.
 */
export function countImWords(text: string): number {
  const segmenter =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? new Intl.Segmenter('zh', { granularity: 'word' })
      : null;
  if (!segmenter) return text.split(/\s+/).filter(Boolean).length;
  let count = 0;
  for (const part of segmenter.segment(text)) {
    if (!part.isWordLike) continue;
    // A CJK run segmented as one word still reads as one word per character
    // when Intl lacks a dictionary; count characters so the limit holds.
    const cjk = part.segment.match(/[㐀-鿿豈-﫿]/g);
    count += cjk && cjk.length === part.segment.length ? cjk.length : 1;
  }
  return count;
}

/**
 * Characters as a second ceiling: a long URL or a run of symbols counts as
 * few words but still floods a chat.
 */
export const TEAM_IM_CHAR_LIMIT = 600;

/** Why a team message may not go to a chat, or null when it may. */
export function imTextLimitError(text: string): string | null {
  if (!text.trim()) return 'Message text is empty.';
  if (text.length > TEAM_IM_CHAR_LIMIT)
    return `Message is ${text.length} characters; the limit is ${TEAM_IM_CHAR_LIMIT}. Rewrite it shorter.`;
  const words = countImWords(text);
  if (words > TEAM_IM_WORD_LIMIT)
    return `Message is ${words} words; the limit is ${TEAM_IM_WORD_LIMIT}. Rewrite it shorter.`;
  return null;
}

export type WorkReplyPurpose = 'ack' | 'result' | 'attention' | 'answer';

// ── Runner ↔ host (IPC) ────────────────────────────────────────────────

/**
 * How the Runner knows a session's role in team mode, or that it is the
 * worker of a delegated item (`origin: 'delegated'`), which reports to the
 * session that delegated it instead of a group's router.
 */
export type TeamRole =
  | { role: 'router' }
  | {
      role: 'worker';
      workItemId: string;
      writable: boolean;
      origin?: WorkItemOrigin;
    };

export interface WorkRouteItem {
  kind: 'accept' | 'attach' | 'stop' | 'ignore';
  /** The candidate's trigger (provider message id). */
  triggerMessageId: string;
  /** accept: a short title; attach/stop: the work item. */
  title?: string;
  workItemId?: string;
  /** accept: the one-line acknowledgement posted under the request. */
  acknowledgement?: string;
  /** accept/attach: routing background, at most 30 words; never a plan. */
  note?: string;
  reason?: string;
  /** Inferred candidates: one entry per enabled rule. */
  ruleAssessments?: { ruleId: string; matched: boolean; reason: string }[];
}

export interface WorkRouteResultItem {
  triggerMessageId: string;
  ok: boolean;
  error?: string;
  workItemId?: string;
  decision?: WorkDecisionKind;
}

/**
 * What a team session may not do, one list for both sides: the Runner does
 * not register these tools and the host refuses their IPC requests. A team
 * session reaches people only through its work tools.
 */
export const TEAM_LANE_POLICY = {
  withheldTools: [
    'send_message',
    'send_image',
    'send_file',
    'feishu_send_card',
    'feishu_api_request',
    'schedule_task',
    'install_skill',
    'uninstall_skill',
  ],
  withheldToolPrefixes: ['automation_'],
  /** `feishu_capability` operations a team session may still run. */
  feishuReadOperations: ['get_chat', 'list_members', 'get_user', 'get_history'],
} as const;

export function teamLaneWithholdsTool(name: string): boolean {
  return (
    (TEAM_LANE_POLICY.withheldTools as readonly string[]).includes(name) ||
    TEAM_LANE_POLICY.withheldToolPrefixes.some((prefix) =>
      name.startsWith(prefix),
    )
  );
}

export const WORK_IPC_TYPES = [
  'work_route',
  'work_reply',
  'work_list',
  'work_report',
  'work_ack',
  'work_handback',
  'work_delegate',
  'work_delegations',
  'work_stop',
  'work_followup',
] as const;
export type WorkIpcType = (typeof WORK_IPC_TYPES)[number];

// ── Multi-task mode (多任务模式) ────────────────────────────────────────

/**
 * How a workspace's sessions take on work. `single` (the default) keeps one
 * input at a time, long work running in the session itself. `multi` lets a
 * session hand a sizeable task to a worker with `work_delegate` and take the
 * next input at once.
 */
export type WorkMode = 'single' | 'multi';
export const DEFAULT_WORK_MODE: WorkMode = 'single';

export function parseWorkMode(value: unknown): WorkMode | null {
  return value === 'single' || value === 'multi' ? value : null;
}

/** Open delegated items one session may have at a time. */
export const DELEGATED_OPEN_PER_SESSION = 3;
/** Open delegated items one workspace may have at a time. */
export const DELEGATED_OPEN_PER_WORKSPACE = 5;
/** `work_delegate.task`, in characters. */
export const DELEGATE_TASK_CHAR_LIMIT = 8000;
/** `work_delegate.context`, in characters. */
export const DELEGATE_CONTEXT_CHAR_LIMIT = 8000;
/** `work_delegate.files`: paths relative to the working directory. */
export const DELEGATE_FILES_LIMIT = 50;
/** `work_followup.message`, in characters. */
export const DELEGATE_FOLLOWUP_CHAR_LIMIT = 4000;

/** `work_delegate`: a session of a multi-task workspace hands a task over. */
export interface WorkDelegateRequest {
  /** A short title, at most WORK_TITLE_CHAR_LIMIT characters. */
  title: string;
  /** What to do and what result to return, self-contained. */
  task: string;
  /** Background the worker needs from this conversation (optional). */
  context?: string;
  /** Files the worker should read or may change (optional). */
  files?: string[];
}

export interface WorkDelegateResult {
  workItemId: string;
  seq: number;
}

/**
 * `work_stop` and `work_followup` name an item by id or by `#seq`. A session
 * reaches only the items it delegated.
 */
export interface WorkStopRequest {
  item: string;
}

export interface WorkFollowupRequest {
  item: string;
  /** Passed to the worker as its next input (an answer, a correction). */
  message: string;
}

/** `work_delegations`: the open items this session delegated, newest first. */
export interface DelegatedWorkSummary {
  workItemId: string;
  seq: number;
  title: string;
  stage: WorkStage;
  lastReport: WorkReportState | null;
  lastSummary: string | null;
  createdAt: string;
}

// ── Web ────────────────────────────────────────────────────────────────

export interface WorkItemView extends WorkItem {
  stage: WorkStage;
  workspaceName: string;
  channelName: string | null;
  /** delegated: the delegating session's name, while it exists. */
  originSessionName: string | null;
}

export type WorkEventKind =
  | 'report'
  | 'ack'
  | 'reply'
  | 'handback'
  | 'input'
  | 'stop'
  | 'approve'
  | 'resume';

/** One entry of a work item's timeline. */
export interface WorkEvent {
  id: number;
  workItemId: string;
  kind: WorkEventKind;
  state: string | null;
  text: string;
  triggerMessageId: string | null;
  createdAt: string;
}

/** GET /api/workspaces/:jid/team-mounts. */
export interface TeamMountView {
  channelJid: string;
  channelName: string | null;
  /** False when the mount cannot run team mode, with the reason. */
  eligible: boolean;
  ineligibleReason: string | null;
  settings: TeamSettings;
  routerAgentId: string | null;
}

/** GET /api/work-items/:id. */
export interface WorkItemDetail {
  item: WorkItemView;
  events: WorkEvent[];
  subscriptions: { channelJid: string; subKey: string }[];
}

/** WebSocket: a work item changed; the Web refetches or merges it. */
export interface WorkItemWsEvent {
  type: 'work_item_updated';
  workspaceJid: string;
  item: WorkItemView;
}
