/**
 * Contract between the automation core (store, scheduler, service:
 * automation-store.ts, automation-scheduler.ts, automation-service.ts) and
 * the conversation runtime that executes runs (index.ts and its helpers).
 *
 * The core never touches queues, runners or channels; the runtime never
 * touches the automation tables. Each side reaches the other only through
 * these interfaces.
 */
import type {
  Automation,
  AutomationDraft,
  AutomationIpcRequest,
  AutomationIpcResult,
  AutomationRun,
} from './automation.js';

// ─── Who is acting ──────────────────────────────────────────────────────

/**
 * - `web`: a signed-in Web user (REST).
 * - `owner_turn`: an agent turn whose whole input batch came from the
 *   workspace owner (same rule as install_skill).
 * - `delegate_turn`: an agent turn whose whole input batch came from the
 *   owner and/or the delegate the owner trusted on a direct-chat binding of
 *   this workspace (workspace-delegate-auth.ts). It may manage the automations
 *   of its own workspace like the owner, except host commands (scripts and
 *   pre-run checks) and Host workspaces; what it creates belongs to the owner.
 * - `automation_run`: an agent turn executing automation `automationId`,
 *   run `runId`. It may pause, complete, delete, notify or silence only its
 *   own automation.
 * - `other_turn`: any other agent turn (group members, mixed batches). It
 *   may only list.
 * - `viewer`: a read-only guest (REST). It may list and read the automations
 *   of the workspaces it is granted, nothing else.
 */
export type AutomationActor =
  | { kind: 'web'; userId: string; isAdmin: boolean }
  | {
      kind: 'owner_turn';
      userId: string;
      isAdmin: boolean;
      /** Workspace of the calling runner. */
      workspaceJid: string;
      /** Session the turn runs in: `web:<ws>` or `web:<ws>#agent:<id>`. */
      sessionJid: string;
      /** Full source route of the turn's input (IM incl. thread/root), or null for Web. */
      sourceRouteJid: string | null;
    }
  | {
      kind: 'delegate_turn';
      /** Workspace owner: created automations are theirs. */
      ownerUserId: string;
      /** Informational only; a delegate never gains host-command rights. */
      ownerIsAdmin: boolean;
      workspaceJid: string;
      sessionJid: string;
      sourceRouteJid: string | null;
    }
  | {
      kind: 'automation_run';
      workspaceJid: string;
      sessionJid: string;
      automationId: string;
      runId: string;
    }
  | { kind: 'other_turn'; workspaceJid: string; sessionJid: string }
  | { kind: 'viewer'; workspaceJids: readonly string[] };

export class AutomationError extends Error {
  constructor(
    /** HTTP-ish status for REST: 400 invalid, 403 forbidden, 404 hidden/missing, 409 revision. */
    readonly status: 400 | 403 | 404 | 409,
    /** Chinese, safe to show the user or the agent; never a raw JID. */
    message: string,
  ) {
    super(message);
    this.name = 'AutomationError';
  }
}

// ─── Runtime side, implemented in index.ts, used by the core ────────────

export interface InjectAutomationInputRequest {
  automation: Automation;
  run: AutomationRun;
  /** Session the turn runs in. */
  sessionJid: string;
  /** source_jid of the input; replies route here. Null = Web only. */
  deliveryRouteJid: string | null;
  /** What the transcript shows (the user's prompt). */
  displayContent: string;
  /** buildAutomationRunContext() output; appended for the agent only. */
  contextSuffix: string;
}

export interface AutomationRuntimeDeps {
  /**
   * Write the run's input into the session's durable queue as
   * source_kind='automation_prompt' with messages.automation_run_id = run.id,
   * then wake the session (queue behind any active turn; never steer; never
   * batch with inputs of another run or with user messages).
   */
  injectAutomationInput(
    req: InjectAutomationInputRequest,
  ): Promise<{ inputMessageId: string }>;
  /** Create a Runtime Session (agents row, source_kind='automation'). */
  createAutomationSession(req: {
    automation: Automation;
    title: string;
  }): Promise<{ sessionJid: string }>;
  /**
   * True if the run's input row exists and is still waiting or executing
   * (not consumed, cancelled or withdrawn). Startup recovery uses it to tell
   * a queued run that will replay from one whose input is gone.
   */
  isAutomationInputPending(req: {
    sessionJid: string;
    inputMessageId: string;
  }): boolean;
  /**
   * Where a run's replies and notices go, resolved at fire time so a later
   * unbind, rebind or target change can never send into a stale chat:
   * `preferredRouteJid` (the creating turn's source, e.g. a Feishu topic)
   * when it still routes to `sessionJid` (bound) or to a session of the
   * automation's workspace (fresh/persistent notices); otherwise the
   * session's only IM binding; otherwise null (Web only).
   */
  resolveDeliveryRoute(req: {
    automation: Automation;
    sessionJid: string | null;
    preferredRouteJid: string | null;
  }): string | null;
  /** True if the session JID resolves to a live Main or Runtime Session. */
  sessionExists(sessionJid: string): boolean;
  /**
   * Every run session created for the automation (agents.automation_id),
   * archived ones included, newest first. Retention and the delete dialog
   * use it instead of run rows, which are trimmed.
   */
  listAutomationSessions(automationId: string): Array<{
    sessionJid: string;
    archived: boolean;
  }>;
  /** Hide an old fresh-mode run session (status completed); keeps history. */
  archiveAutomationSession(sessionJid: string): Promise<void>;
  /** Delete a run session (delete dialog「删除会话」). */
  deleteAutomationSession(sessionJid: string): Promise<void>;
  /** Withdraw a queued input, or interrupt the turn running it. */
  cancelAutomationInput(req: {
    sessionJid: string;
    inputMessageId: string;
  }): Promise<void>;
  /**
   * Send a framework notice (result summary, failure, recovery) to an IM
   * route or, when routeJid is a `web:` session, into that session as a
   * bot message.
   */
  sendAutomationNotice(req: {
    automation: Automation;
    routeJid: string;
    text: string;
  }): Promise<void>;
  /** Post a script run's output into the target session. */
  postScriptOutput(req: {
    automation: Automation;
    sessionJid: string;
    text: string;
  }): Promise<void>;
  /** Billing gate for the workspace owner before a run fires. */
  checkBilling(ownerId: string): { ok: true } | { ok: false; reason: string };
  /** Host workspace owned by an admin (scripts and pre-run checks). */
  allowsHostCommands(workspaceJid: string): boolean;
  /** Working directory for pre-run checks and scripts. */
  resolveWorkdir(automation: Automation, sessionJid: string | null): string;
  broadcast(event: AutomationWsEvent): void;
}

export type AutomationWsEvent =
  | {
      type: 'automation_changed';
      automationId: string;
      workspaceJid: string;
      ownerId: string;
      deleted?: boolean;
    }
  | {
      type: 'automation_run_updated';
      automationId: string;
      workspaceJid: string;
      ownerId: string;
      run: AutomationRun;
    };

// ─── Core side, implemented by automation-service.ts, used by the runtime

export type AutomationRunOutcome =
  | { status: 'success'; resultText: string | null }
  | { status: 'failed'; error: string }
  | {
      status: 'cancelled';
      reason: 'break' | 'clear' | 'fresh' | 'withdrawn' | 'deleted';
    }
  | { status: 'interrupted'; error: string };

export interface AutomationRunSink {
  /** The run's input started executing in a turn. */
  onRunInputStarted(runId: string): void;
  /** The turn that consumed the run's input settled (once per run). */
  onRunInputSettled(runId: string, outcome: AutomationRunOutcome): void;
  /** Quiet run that has not escalated: hold IM delivery, Web only. */
  isRunSilenced(runId: string): boolean;
  /**
   * The run is still queued or running in the database. An input whose run
   * is not live (settled, cancelled, interrupted, deleted, unknown) is
   * history: the runtime consumes it instead of executing it, including
   * after a restart.
   */
  isRunLive(runId: string): boolean;
}

export interface AutomationCreateInput extends AutomationDraft {
  workspaceJid: string;
  /** bound mode from the Web: the chosen session. */
  targetSessionJid?: string | null;
}

export type AutomationPatch = Partial<
  Omit<AutomationDraft, 'sessionMode' | 'execution'>
> & {
  sessionMode?: AutomationDraft['sessionMode'];
  targetSessionJid?: string | null;
};

export type AutomationSessionDisposal = 'keep' | 'archive' | 'delete';

export interface AutomationService {
  list(
    actor: AutomationActor,
    filter?: { workspaceJid?: string },
  ): Automation[];
  get(actor: AutomationActor, id: string): Automation;
  listRuns(actor: AutomationActor, id: string, limit?: number): AutomationRun[];
  create(actor: AutomationActor, input: AutomationCreateInput): Automation;
  update(
    actor: AutomationActor,
    id: string,
    expectedRevision: number,
    patch: AutomationPatch,
  ): Automation;
  pause(actor: AutomationActor, id: string, reason?: string | null): Automation;
  resume(actor: AutomationActor, id: string): Automation;
  complete(actor: AutomationActor, id: string, reason: string): Automation;
  delete(
    actor: AutomationActor,
    id: string,
    sessions: AutomationSessionDisposal,
  ): Promise<void>;
  runNow(actor: AutomationActor, id: string): Promise<AutomationRun>;
  cancelRun(actor: AutomationActor, id: string, runId: string): Promise<void>;
  markRunsRead(actor: AutomationActor, id: string, runIds?: string[]): void;
  /** Agent tool calls; maps AutomationError to { success:false, error }. */
  handleIpc(
    actor: AutomationActor,
    request: AutomationIpcRequest,
  ): Promise<AutomationIpcResult>;
  /** A session was deleted: bound automations pause, persistent ones rebind next run. */
  onSessionDeleted(sessionJid: string): void;
  /** Workspace deleted: drop its automations and runs. */
  onWorkspaceDeleted(workspaceJid: string): void;
  /** Pause every automation of a workspace (rebuild), returning what to resume. */
  suspendWorkspace(workspaceJid: string): string[];
  restoreWorkspace(automationIds: string[]): void;
  /** Bound automations that target this session (chat header badge). */
  listForSession(sessionJid: string): Automation[];
  runSink: AutomationRunSink;
}

export interface AutomationScheduler {
  /** Start after startup recovery of IPC, pending messages and conversation agents. */
  start(): void;
  stop(): Promise<void>;
  /** Recompute the wake-up after a change. */
  poke(): void;
}
