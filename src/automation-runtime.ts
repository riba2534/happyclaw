/**
 * The conversation-runtime side of automations (自动化): how a run's input
 * enters a real session, how its turn reports back to the automation core,
 * and how the agent's automation tools reach the service.
 *
 * The core (automation-service.ts) never touches queues, runners or
 * channels; this module never reads the automation tables. index.ts supplies
 * the queue/channel primitives through `AutomationRuntimeHooks`.
 *
 * An automation input is an ordinary message row:
 * - source_kind='automation_prompt', messages.automation_run_id = run id,
 *   sender 'automation', sender_name = the automation's name;
 * - content = the user's prompt, exactly what the transcript shows;
 * - the per-run context block (buildAutomationRunContext) is stored in the
 *   row's attachments JSON as one `automation_run_context` item, next to any
 *   images, the same way plugin expansions are stored. The agent receives
 *   `content + text` (withAutomationRunContext). Storing it, rather than
 *   rebuilding it, keeps a replay after a restart byte-identical even after
 *   the automation was edited. Image readers ignore non-image items; the Web
 *   message API strips the item and exposes `automation: {id, name, runId}`.
 */
import {
  AutomationError,
  type AutomationActor,
  type AutomationRuntimeDeps,
  type AutomationWsEvent,
  type InjectAutomationInputRequest,
} from './automation-contract.js';
import type {
  AutomationIpcRequest,
  AutomationIpcResult,
} from './automation.js';
import {
  isAutomationTurnInput,
  type AgentBuilderPersistedInput,
  type AgentBuilderTurnContext,
} from './agent-builder-turn-auth.js';
import {
  AUTOMATION_RUN_CONTEXT_ATTACHMENT_TYPE,
  getAutomationService,
  automationRunIdOf,
  readAutomationRunContext,
  rememberRunLane,
  type AutomationRunContextItem,
} from './automation-run-ledger.js';
import {
  checkBillingAccessFresh,
  formatBillingAccessDeniedMessage,
} from './billing.js';
import {
  ensureChatExists,
  getAgent,
  getUserById,
  listAgentsByAutomationId,
  storeMessageDirect,
} from './db.js';
import { resolveInputChannelReplySource } from './channel-reply-source.js';
import { canExecuteOnHost } from './host-execution-policy.js';
import { getChannelType } from './im-channel.js';
import { logger } from './logger.js';
import { resolveWorkspaceProjectRoot } from './session-worktree.js';
import {
  archiveConversationSession,
  createConversationSession,
  deleteConversationSession,
} from './session-factory.js';
import type { NewMessage, RegisteredGroup } from './types.js';
import { agentIdOfJid, stripVirtualJidSuffix } from './utils.js';

export * from './automation-run-ledger.js';

// ─── Who is calling an automation tool ─────────────────────────────────

/**
 * Derive the actor of an agent's automation tool call from the host-owned
 * turn executing in the calling runtime, never from the request.
 *
 * - The active batch holds an automation input → `automation_run` (one run;
 *   a batch mixing runs or runs and other inputs is `other_turn`).
 * - The executing turn is the owner's own (the install_skill rule) →
 *   `owner_turn`, bound to this session and the source route of its input.
 * - Every input is the owner's or the workspace delegate's (at least one
 *   delegate) → `delegate_turn`, bound like `owner_turn`.
 * - Anything else → `other_turn`.
 */
export function deriveAutomationActor(input: {
  workspaceJid: string;
  sessionJid: string;
  /** The workspace owner's account. */
  owner: { id: string; role: string; status: string } | undefined;
  /** The turns the runner holds up to the one making the call. */
  turns: AgentBuilderTurnContext[];
  loadInput: (
    chatJid: string,
    messageId: string,
  ) => (AgentBuilderPersistedInput & { attachments?: string | null }) | null;
  /** The install_skill owner-turn rule for this runtime. */
  isOwnerTurn: () => boolean;
  /** The workspace-delegate rule (workspaceTurnPrincipal) for this runtime. */
  isDelegateTurn?: () => boolean;
}): AutomationActor {
  const other: AutomationActor = {
    kind: 'other_turn',
    workspaceJid: input.workspaceJid,
    sessionJid: input.sessionJid,
  };
  const observed = input.turns.map((turn) => ({
    turn,
    input: input.loadInput(turn.chatJid, turn.messageId),
  }));
  const runs = observed.filter(
    ({ turn, input: persisted }) =>
      persisted && isAutomationTurnInput(turn, persisted),
  );
  if (runs.length > 0) {
    // A run never shares its turn: anything else in the batch means it is
    // not that run acting.
    const context =
      runs.length === observed.length
        ? readAutomationRunContext(runs[0].input!.attachments)
        : null;
    const runId = runs[0].input ? automationRunIdOf(runs[0].input) : null;
    if (
      !context ||
      !runId ||
      runs.some(
        ({ input: persisted }) => automationRunIdOf(persisted!) !== runId,
      )
    ) {
      return other;
    }
    return {
      kind: 'automation_run',
      workspaceJid: input.workspaceJid,
      sessionJid: input.sessionJid,
      automationId: context.automationId,
      runId,
    };
  }
  const owner = input.owner;
  if (!owner || owner.status !== 'active') return other;
  const sourceRouteJid = resolveInputChannelReplySource(
    observed[observed.length - 1]?.input?.source_jid,
  );
  if (input.isOwnerTurn()) {
    return {
      kind: 'owner_turn',
      userId: owner.id,
      isAdmin: owner.role === 'admin',
      workspaceJid: input.workspaceJid,
      sessionJid: input.sessionJid,
      sourceRouteJid,
    };
  }
  if (input.isDelegateTurn?.()) {
    return {
      kind: 'delegate_turn',
      ownerUserId: owner.id,
      ownerIsAdmin: owner.role === 'admin',
      workspaceJid: input.workspaceJid,
      sessionJid: input.sessionJid,
      sourceRouteJid,
    };
  }
  return other;
}

// ─── Agent tools over IPC ──────────────────────────────────────────────

/** Run one automation tool call; never throws. */
export async function handleAutomationIpc(
  request: AutomationIpcRequest,
  resolveActor: () => AutomationActor,
): Promise<AutomationIpcResult> {
  const requestId = request.requestId;
  const service = getAutomationService();
  if (!service) {
    return {
      requestId,
      success: false,
      error: '自动化服务尚未就绪，请稍后再试',
    };
  }
  try {
    return await service.handleIpc(resolveActor(), request);
  } catch (err) {
    if (err instanceof AutomationError) {
      return { requestId, success: false, error: err.message };
    }
    logger.error(
      { err, type: request.type },
      'Automation IPC request failed unexpectedly',
    );
    return { requestId, success: false, error: '处理自动化请求时出错' };
  }
}

// ─── AutomationRuntimeDeps ─────────────────────────────────────────────

export interface ResolvedAutomationSession {
  /** The `web:*` JID of the workspace. */
  workspaceJid: string;
  group: RegisteredGroup;
  /** Null for the Main Session. */
  agentId: string | null;
  /** Queue/message JID: the workspace JID or `<workspace>#agent:<id>`. */
  laneJid: string;
}

/** Queue and channel primitives index.ts provides. */
export interface AutomationRuntimeHooks {
  getGroup(jid: string): RegisteredGroup | undefined;
  /**
   * Admit a stored input like an inbound follow-up in `queue` mode: behind
   * an active turn it becomes a visible queued item.
   */
  admitInput(input: {
    laneJid: string;
    messageId: string;
    sourceJid: string;
  }): 'started' | 'queued';
  /** Start processing an idle Main or Runtime Session. */
  wake(session: ResolvedAutomationSession): void;
  broadcastNewMessage(laneJid: string, message: NewMessage): void;
  /**
   * The session an IM route currently delivers to (`web:<ws>` or
   * `web:<ws>#agent:<id>`), following topic bindings, or null.
   */
  routeSessionOf(routeJid: string): string | null;
  /** IM chats bound to the session as a whole (not per-topic routes). */
  listSessionImRoutes(sessionJid: string): string[];
  /** True while the input waits in the queue or has not been consumed. */
  isInputPending(laneJid: string, messageId: string): boolean;
  /** Withdraw a queued input or stop the turn running it. */
  cancelInput(laneJid: string, messageId: string): Promise<void>;
  /** Plain IM text to a route; resolves to whether the provider accepted it. */
  sendImText(routeJid: string, text: string): Promise<boolean>;
  /** A framework message into a session's Web transcript. */
  postSessionMessage(sessionJid: string, text: string): Promise<void>;
  broadcastAutomationEvent(event: AutomationWsEvent): void;
}

/** `web:<ws>` or `web:<ws>#agent:<id>` → the live session, or null. */
export function resolveAutomationSession(
  sessionJid: string,
  getGroup: (jid: string) => RegisteredGroup | undefined,
): ResolvedAutomationSession | null {
  const workspaceJid = stripVirtualJidSuffix(sessionJid);
  if (!workspaceJid.startsWith('web:') || workspaceJid.includes('#'))
    return null;
  const group = getGroup(workspaceJid);
  if (!group) return null;
  const agentId = agentIdOfJid(sessionJid);
  if (agentId === null && sessionJid === workspaceJid) {
    return { workspaceJid, group, agentId: null, laneJid: workspaceJid };
  }
  const agent = agentId ? getAgent(agentId) : undefined;
  // An archived (completed) session still resolves: an input revives it, as
  // a new message in an old topic does.
  if (
    !agent ||
    agent.kind !== 'conversation' ||
    agent.chat_jid !== workspaceJid
  ) {
    return null;
  }
  return {
    workspaceJid,
    group,
    agentId,
    laneJid: `${workspaceJid}#agent:${agentId}`,
  };
}

const AUTOMATION_SENDER = 'automation';
const INPUT_MESSAGE_ID_PREFIX = 'automation-run-';

/** The input row of a run has a fixed id, so a re-inject is idempotent. */
export function automationInputMessageId(runId: string): string {
  return `${INPUT_MESSAGE_ID_PREFIX}${runId}`;
}

function automationRunIdOfInputMessageId(messageId: string): string | null {
  return messageId.startsWith(INPUT_MESSAGE_ID_PREFIX)
    ? messageId.slice(INPUT_MESSAGE_ID_PREFIX.length) || null
    : null;
}

export function createAutomationRuntimeDeps(
  hooks: AutomationRuntimeHooks,
): AutomationRuntimeDeps {
  const requireSession = (sessionJid: string): ResolvedAutomationSession => {
    const session = resolveAutomationSession(sessionJid, hooks.getGroup);
    if (!session) throw new Error('自动化的目标会话不存在');
    return session;
  };

  return {
    async injectAutomationInput(req: InjectAutomationInputRequest) {
      const session = requireSession(req.sessionJid);
      const messageId = automationInputMessageId(req.run.id);
      const timestamp = new Date().toISOString();
      const sourceJid = req.deliveryRouteJid ?? session.laneJid;
      const context: AutomationRunContextItem = {
        type: AUTOMATION_RUN_CONTEXT_ATTACHMENT_TYPE,
        automationId: req.automation.id,
        automationName: req.automation.name,
        runId: req.run.id,
        text: req.contextSuffix,
      };
      const row = {
        id: messageId,
        chat_jid: session.laneJid,
        source_jid: sourceJid,
        sender: AUTOMATION_SENDER,
        sender_name: req.automation.name,
        content: req.displayContent,
        timestamp,
        attachments: JSON.stringify([context]),
        source_kind: 'automation_prompt',
        automation_run_id: req.run.id,
      } satisfies NewMessage;
      ensureChatExists(row.chat_jid);
      storeMessageDirect(
        row.id,
        row.chat_jid,
        row.sender,
        row.sender_name,
        row.content,
        row.timestamp,
        false,
        {
          attachments: row.attachments,
          sourceJid,
          meta: { sourceKind: row.source_kind, automationRunId: req.run.id },
        },
      );
      rememberRunLane(req.run.id, session.laneJid);
      const disposition = hooks.admitInput({
        laneJid: session.laneJid,
        messageId,
        sourceJid,
      });
      hooks.broadcastNewMessage(session.laneJid, {
        ...row,
        attachments: undefined,
        automation: {
          id: context.automationId,
          name: context.automationName,
          runId: context.runId,
        },
      });
      if (disposition === 'started') hooks.wake(session);
      return { inputMessageId: messageId };
    },

    async createAutomationSession({ automation, title }) {
      const group = hooks.getGroup(automation.workspaceJid);
      if (!group) throw new Error('自动化所在的工作区不存在');
      const session = await createConversationSession({
        workspaceJid: automation.workspaceJid,
        group,
        createdBy: automation.createdBy,
        name: title,
        sourceKind: 'automation',
        automationId: automation.id,
      });
      return { sessionJid: `${automation.workspaceJid}#agent:${session.id}` };
    },

    isAutomationInputPending({ sessionJid, inputMessageId }) {
      const session = resolveAutomationSession(sessionJid, hooks.getGroup);
      if (!session || !hooks.isInputPending(session.laneJid, inputMessageId)) {
        return false;
      }
      // Startup recovery asks for every queued run: remember its lane so a
      // later reset of the lane ends the run.
      const runId = automationRunIdOfInputMessageId(inputMessageId);
      if (runId) rememberRunLane(runId, session.laneJid);
      return true;
    },

    resolveDeliveryRoute({ automation, sessionJid, preferredRouteJid }) {
      // Resolved at fire time: after an unbind or rebind the old chat no
      // longer routes here and is never used again.
      if (preferredRouteJid && getChannelType(preferredRouteJid)) {
        const routed = hooks.routeSessionOf(preferredRouteJid);
        const stillRoutesHere = sessionJid
          ? routed === sessionJid
          : !!routed &&
            stripVirtualJidSuffix(routed) === automation.workspaceJid;
        if (stillRoutesHere) return preferredRouteJid;
      }
      if (!sessionJid) return null;
      const routes = hooks.listSessionImRoutes(sessionJid);
      return routes.length === 1 ? routes[0] : null;
    },

    sessionExists(sessionJid) {
      return resolveAutomationSession(sessionJid, hooks.getGroup) !== null;
    },

    listAutomationSessions(automationId) {
      return listAgentsByAutomationId(automationId).map((agent) => ({
        sessionJid: `${agent.chat_jid}#agent:${agent.id}`,
        archived: agent.status === 'completed',
      }));
    },

    async archiveAutomationSession(sessionJid) {
      const session = resolveAutomationSession(sessionJid, hooks.getGroup);
      const agent = session?.agentId ? getAgent(session.agentId) : undefined;
      if (!session || !agent) return;
      archiveConversationSession(session.workspaceJid, agent);
    },

    async deleteAutomationSession(sessionJid) {
      const session = resolveAutomationSession(sessionJid, hooks.getGroup);
      const agent = session?.agentId ? getAgent(session.agentId) : undefined;
      if (!session || !agent) return;
      await deleteConversationSession({
        workspaceJid: session.workspaceJid,
        group: session.group,
        session: agent,
      });
    },

    async cancelAutomationInput({ sessionJid, inputMessageId }) {
      const session = resolveAutomationSession(sessionJid, hooks.getGroup);
      if (!session) return;
      await hooks.cancelInput(session.laneJid, inputMessageId);
    },

    async sendAutomationNotice({ routeJid, text }) {
      if (getChannelType(routeJid)) {
        const accepted = await hooks.sendImText(routeJid, text);
        if (!accepted) throw new Error('渠道没有确认收到自动化通知');
        return;
      }
      requireSession(routeJid);
      await hooks.postSessionMessage(routeJid, text);
    },

    async postScriptOutput({ sessionJid, text }) {
      requireSession(sessionJid);
      await hooks.postSessionMessage(sessionJid, text);
    },

    checkBilling(ownerId) {
      const owner = getUserById(ownerId);
      if (!owner || owner.status !== 'active') {
        return { ok: false, reason: '工作区主人的账户不可用' };
      }
      if (owner.role === 'admin') return { ok: true };
      const access = checkBillingAccessFresh(owner.id, owner.role);
      return access.allowed
        ? { ok: true }
        : { ok: false, reason: formatBillingAccessDeniedMessage(access) };
    },

    allowsHostCommands(workspaceJid) {
      const group = hooks.getGroup(workspaceJid);
      if (!group || group.executionMode !== 'host' || !group.created_by) {
        return false;
      }
      return canExecuteOnHost(getUserById(group.created_by));
    },

    resolveWorkdir(automation, sessionJid) {
      const session = sessionJid
        ? resolveAutomationSession(sessionJid, hooks.getGroup)
        : null;
      const group = session?.group ?? hooks.getGroup(automation.workspaceJid);
      if (!group) throw new Error('自动化所在的工作区不存在');
      return resolveWorkspaceProjectRoot(group, {
        agentId: session?.agentId ?? null,
      });
    },

    broadcast(event) {
      hooks.broadcastAutomationEvent(event);
    },
  };
}
