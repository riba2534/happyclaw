/**
 * The v88 plan, worked out without writing: which workspaces carry
 * main-session state, which chats' history joins them and in what order,
 * which inputs are still pending and whether they can be replayed, and what
 * happens to each `target_main_jid` binding. The migration applies it;
 * `--preflight` prints it for a live database opened read-only. Loads
 * nothing that writes on import.
 *
 * The v87 lookups are copied rather than imported: the runtime ones are being
 * rewritten without the main session.
 */
import fs from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { resolveChannelConversationKind } from './channel-conversation-kind.js';
import { getChannelFromJid } from './channel-prefixes.js';
import { CHANNEL_RELIABILITY_TERMINAL_STATUSES } from './channel-reliability-store.js';
import { isThreadMapCapableChat } from './im-channel-capabilities.js';
import {
  exists,
  FOLDER_AGENT_ROWS,
  OWNER_KEY_PREFIX,
  prep,
  routerState,
} from './legacy-main-session-checks.js';
import { isValidWorkspaceFolderName } from './workspace-folder.js';

type Db = Database.Database;

export type BindingEntry = { channelJid: string; previousTarget: string };

export interface WorkspaceRow {
  jid: string;
  name: string;
  folder: string;
  added_at: string;
  created_by: string | null;
  is_home: number | null;
}

interface ChatRow {
  jid: string;
  created_by: string | null;
  target_agent_id: string | null;
  target_main_jid: string | null;
  feishu_chat_mode: string | null;
  feishu_group_message_type: string | null;
  native_context_type: string | null;
}

const CHAT_COLUMNS = `jid, created_by, target_agent_id, target_main_jid,
  feishu_chat_mode, feishu_group_message_type, native_context_type`;

function isWorkspaceJid(jid: string): boolean {
  return jid.startsWith('web:');
}

/** Registered workspaces, Homes first, in a stable order. */
export function listWorkspaces(db: Db): WorkspaceRow[] {
  return prep(
    db,
    `SELECT jid, name, folder, added_at, created_by, is_home
     FROM registered_groups WHERE jid LIKE 'web:%'
     ORDER BY is_home DESC, added_at ASC, jid ASC`,
  ).all() as WorkspaceRow[];
}

/** The workspace that owns a folder's folder-keyed rows (as getWorkspaceJidForFolder). */
export function folderOwnerJid(db: Db, folder: string): string | null {
  const row = prep(
    db,
    "SELECT jid FROM registered_groups WHERE folder = ? AND jid LIKE 'web:%' ORDER BY is_home DESC, added_at ASC LIMIT 1",
  ).get(folder) as { jid: string } | undefined;
  return row?.jid ?? null;
}

function isRegistered(db: Db, jid: string): boolean {
  return exists(db, 'SELECT 1 FROM registered_groups WHERE jid = ?', jid);
}

/** v87 resolveWorkspaceJidForMount: the workspace a `target_main_jid` routed to. */
function resolveMainTarget(db: Db, target: string): string | null {
  if (isRegistered(db, target)) return target;
  if (!isWorkspaceJid(target)) return null;
  return folderOwnerJid(db, target.slice(4));
}

/**
 * The router's isNativeContextContainer (channel-mount-service.ts) over the
 * stored row: a chat whose binding is a workspace and whose topics are
 * sessions. Rows carry no `thread_capable`, and an unknown prefix maps to
 * 'web', which no capability supports, where the router has null.
 */
export function isTopicContainerRow(
  row: Pick<
    ChatRow,
    | 'jid'
    | 'feishu_chat_mode'
    | 'feishu_group_message_type'
    | 'native_context_type'
  >,
): boolean {
  const channelType = getChannelFromJid(row.jid);
  const chat_mode = row.feishu_chat_mode ?? undefined;
  const group_message_type = row.feishu_group_message_type ?? undefined;
  if (channelType === 'feishu') {
    return (
      resolveChannelConversationKind(row.jid, {
        chat_mode,
        group_message_type,
      }) === 'topic'
    );
  }
  return isThreadMapCapableChat({
    channel_type: channelType,
    chat_mode,
    group_message_type,
    native_context_type:
      row.native_context_type === 'thread' ? 'thread' : 'none',
  });
}

/**
 * v87 resolveBoundWorkspaceJid (null when unbound or stale) and whether the
 * chat declares any binding, as the Home history merge used them.
 */
function boundWorkspaceOf(
  db: Db,
  chat: ChatRow,
): { workspaceJid: string | null; hasReference: boolean } {
  const agentChatJid = (id: string) =>
    (
      prep(db, 'SELECT chat_jid FROM agents WHERE id = ?').get(id) as
        | { chat_jid: string }
        | undefined
    )?.chat_jid ?? null;
  const mount = prep(
    db,
    'SELECT workspace_jid, session_id FROM channel_mounts WHERE channel_jid = ?',
  ).get(chat.jid) as
    | { workspace_jid: string; session_id: string | null }
    | undefined;
  if (mount) {
    const jid = mount.session_id
      ? agentChatJid(mount.session_id)
      : mount.workspace_jid;
    return {
      workspaceJid: jid && isRegistered(db, jid) ? jid : null,
      hasReference: true,
    };
  }
  if (chat.target_agent_id) {
    return {
      workspaceJid: agentChatJid(chat.target_agent_id),
      hasReference: true,
    };
  }
  if (!chat.target_main_jid) return { workspaceJid: null, hasReference: false };
  // foldLegacyWorkspaceJid: first web: JID of the folder in row order.
  let workspaceJid: string | null = null;
  if (isRegistered(db, chat.target_main_jid)) {
    workspaceJid = chat.target_main_jid;
  } else if (isWorkspaceJid(chat.target_main_jid)) {
    const sameFolder = prep(
      db,
      'SELECT jid FROM registered_groups WHERE folder = ?',
    ).all(chat.target_main_jid.slice(4)) as Array<{ jid: string }>;
    workspaceJid =
      sameFolder.find((row) => isWorkspaceJid(row.jid))?.jid ?? null;
  }
  return { workspaceJid, hasReference: true };
}

/**
 * The chats whose history becomes the workspace's session: its own address
 * plus, for a Home, the IM chats with messages its main view merged (v87
 * resolveMessageQueryJids: same folder and owner, unbound or bound to it).
 */
export function workspaceSourceJids(db: Db, workspace: WorkspaceRow): string[] {
  if (!workspace.is_home || !workspace.created_by) return [workspace.jid];
  const siblings = prep(
    db,
    `SELECT ${CHAT_COLUMNS} FROM registered_groups
     WHERE folder = ? AND jid <> ? ORDER BY jid`,
  ).all(workspace.folder, workspace.jid) as ChatRow[];
  const merged = siblings.filter((sibling) => {
    if (isWorkspaceJid(sibling.jid)) return false;
    if (sibling.created_by !== workspace.created_by) return false;
    const bound = boundWorkspaceOf(db, sibling);
    if (bound.workspaceJid) return bound.workspaceJid === workspace.jid;
    return !bound.hasReference;
  });
  return [
    workspace.jid,
    ...merged
      .map((sibling) => sibling.jid)
      .filter((jid) =>
        exists(db, 'SELECT 1 FROM messages WHERE chat_jid = ? LIMIT 1', jid),
      ),
  ];
}

interface MainTargetPlan {
  /** Direct and group chats per workspace: they move onto its session. */
  byWorkspace: Map<string, BindingEntry[]>;
  /** Topic containers: their binding is the workspace, recorded as thread_map. */
  topicContainers: Array<BindingEntry & { workspaceJid: string }>;
  /** Resolved to no workspace (never routed); cleared. */
  stale: BindingEntry[];
  /** Beside a `target_agent_id`, which always won; cleared. */
  redundant: BindingEntry[];
  /** Names a registered non-web chat; left as is. */
  unresolved: BindingEntry[];
}

export function planMainTargets(db: Db): MainTargetPlan {
  const plan: MainTargetPlan = {
    byWorkspace: new Map(),
    topicContainers: [],
    stale: [],
    redundant: [],
    unresolved: [],
  };
  const rows = prep(
    db,
    `SELECT ${CHAT_COLUMNS} FROM registered_groups
     WHERE jid NOT LIKE 'web:%'
       AND target_main_jid IS NOT NULL AND target_main_jid <> ''
       AND COALESCE(binding_mode, '') <> 'thread_map'
     ORDER BY jid`,
  ).all() as ChatRow[];
  for (const row of rows) {
    const entry = { channelJid: row.jid, previousTarget: row.target_main_jid! };
    if (row.target_agent_id) {
      plan.redundant.push(entry);
      continue;
    }
    const workspaceJid = resolveMainTarget(db, row.target_main_jid!);
    if (!workspaceJid) {
      plan.stale.push(entry);
    } else if (!isWorkspaceJid(workspaceJid)) {
      plan.unresolved.push(entry);
    } else if (isTopicContainerRow(row)) {
      plan.topicContainers.push({ ...entry, workspaceJid });
    } else {
      const list = plan.byWorkspace.get(workspaceJid) ?? [];
      list.push(entry);
      plan.byWorkspace.set(workspaceJid, list);
    }
  }
  return plan;
}

/** Whether the workspace has anything of a main session to migrate. */
export function hasMainState(
  db: Db,
  workspace: WorkspaceRow,
  sourceJids: readonly string[],
  ownsFolderState: boolean,
  bindings: readonly BindingEntry[],
): boolean {
  const keyed = (table: string, column: string) =>
    exists(
      db,
      `SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`,
      workspace.jid,
    );
  return (
    bindings.length > 0 ||
    exists(
      db,
      'SELECT 1 FROM messages WHERE chat_jid IN (SELECT value FROM json_each(?)) LIMIT 1',
      JSON.stringify(sourceJids),
    ) ||
    (ownsFolderState &&
      (FOLDER_AGENT_ROWS.some(([, table, column]) =>
        exists(
          db,
          `SELECT 1 FROM ${table} WHERE group_folder = ? AND ${column} = '' LIMIT 1`,
          workspace.folder,
        ),
      ) ||
        routerState(db, `${OWNER_KEY_PREFIX}${workspace.folder}:main`) !==
          undefined)) ||
    keyed('automations', 'target_session_jid') ||
    keyed('usage_limit_waits', 'scope_key') ||
    keyed('subagent_checkpoints', 'chat_jid') ||
    keyed('router_cursors', 'chat_jid')
  );
}

/** v87 normalizeCursor + resolveMessageCursorSequence: a lost anchor is zero. */
function parseCursorSequence(db: Db, chatJid: string, raw: string): number {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!value || typeof value !== 'object') return 0;
  const { sequence, id } = value as { sequence?: unknown; id?: unknown };
  if (
    typeof sequence === 'number' &&
    Number.isSafeInteger(sequence) &&
    sequence >= 0
  ) {
    return sequence;
  }
  if (typeof id !== 'string' || !id) return 0;
  const row = prep(
    db,
    'SELECT sequence FROM message_ingest_sequences WHERE chat_jid = ? AND message_id = ?',
  ).get(chatJid, id) as { sequence: number } | undefined;
  return row?.sequence ?? 0;
}

/** The chat's committed ingest position; null when it never committed. */
function committedSequence(db: Db, chatJid: string): number | null {
  const row = prep(
    db,
    "SELECT cursor FROM router_cursors WHERE kind = 'committed' AND chat_jid = ?",
  ).get(chatJid) as { cursor: string } | undefined;
  return row ? parseCursorSequence(db, chatJid, row.cursor) : null;
}

/** Inputs the durable queue still holds, whatever the cursor says. */
const QUEUED_STATUSES = new Set(['queued', 'promoting', 'awaiting_companion']);
/** Inputs the runtime never runs. */
const WITHDRAWN_STATUSES = new Set(['cancelled', 'subsumed']);

interface PlannedMessage {
  /** The source chat and the id the row has there. */
  chatJid: string;
  sourceId: string;
  /** Its id in the session: the source id unless another source holds it. */
  id: string;
  timestamp: string | null;
  oldSequence: number | null;
  inbound: boolean;
  pending: boolean;
}

export interface LegacyMainSessionSourcePlan {
  chatJid: string;
  kind: 'workspace' | 'home_im';
  /** Rows found under this address. */
  messages: number;
  moved: number;
  /** Dropped: an earlier source holds the same id, sender, time and text. */
  duplicates: number;
  /** Kept under a new id: an earlier source holds the id with other content. */
  renamed: number;
  /** Its committed cursor; null when it never committed. */
  committedSequence: number | null;
}

export interface WorkspaceMessagePlan {
  sources: LegacyMainSessionSourcePlan[];
  /** The session's history in its new order. */
  order: PlannedMessage[];
  duplicates: Array<{ chatJid: string; id: string }>;
  renamed: Array<{ chatJid: string; from: string; to: string }>;
  /** Index in `order` both cursors sit after (-1: before the first); null without messages. */
  cursorAfter: number | null;
  /** Pending inputs the session will pick up. */
  pendingReplayed: string[];
  /**
   * Pending inputs left behind the cursor: replaying them would replay a
   * processed input that sorts after them.
   */
  pendingNotReplayed: string[];
  nullTimestampInbound: string[];
}

/** Provider time (missing first), then old arrival position, then id. */
function compareHistory(a: PlannedMessage, b: PlannedMessage): number {
  if (a.timestamp !== b.timestamp) {
    if (a.timestamp === null) return -1;
    if (b.timestamp === null) return 1;
    return a.timestamp < b.timestamp ? -1 : 1;
  }
  if (a.oldSequence !== b.oldSequence) {
    if (a.oldSequence === null) return 1;
    if (b.oldSequence === null) return -1;
    return a.oldSequence - b.oldSequence;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Merge the sources' rows into one history and place the cursors so that no
 * processed input is ever replayed. An input is pending when the queue still
 * holds it, or when its chat committed and it arrived after that cursor; a
 * chat that never committed has nothing else pending. Pending inputs replay
 * only when all of them sort after every processed input.
 */
export function planWorkspaceMessages(
  db: Db,
  workspaceJid: string,
  sourceJids: readonly string[],
): WorkspaceMessagePlan {
  const plan: WorkspaceMessagePlan = {
    sources: [],
    order: [],
    duplicates: [],
    renamed: [],
    cursorAfter: null,
    pendingReplayed: [],
    pendingNotReplayed: [],
    nullTimestampInbound: [],
  };
  const kept = new Map<string, PlannedMessage>();
  /** Same sender and text: read only when two chats hold one id. */
  const sameAuthorAndText = (a: PlannedMessage, b: PlannedMessage) => {
    const read = prep(
      db,
      'SELECT sender, content FROM messages WHERE chat_jid = ? AND id = ?',
    );
    const x = read.get(a.chatJid, a.sourceId) as Record<string, unknown>;
    const y = read.get(b.chatJid, b.sourceId) as Record<string, unknown>;
    return x.sender === y.sender && x.content === y.content;
  };
  for (const chatJid of sourceJids) {
    const committed = committedSequence(db, chatJid);
    const rows = prep(
      db,
      `SELECT m.id, m.timestamp, m.is_from_me AS fromMe,
              m.delivery_status AS status, seq.sequence
       FROM messages m
       LEFT JOIN message_ingest_sequences seq
         ON seq.chat_jid = m.chat_jid AND seq.message_id = m.id
       WHERE m.chat_jid = ?`,
    ).all(chatJid) as Array<{
      id: string;
      timestamp: string | null;
      fromMe: number | null;
      status: string | null;
      sequence: number | null;
    }>;
    const source: LegacyMainSessionSourcePlan = {
      chatJid,
      kind: chatJid === workspaceJid ? 'workspace' : 'home_im',
      messages: rows.length,
      moved: 0,
      duplicates: 0,
      renamed: 0,
      committedSequence: committed,
    };
    for (const row of rows) {
      const status = row.status ?? '';
      const inbound = !row.fromMe && !WITHDRAWN_STATUSES.has(status);
      const message: PlannedMessage = {
        chatJid,
        sourceId: row.id,
        id: row.id,
        timestamp: row.timestamp,
        oldSequence: row.sequence,
        inbound,
        pending:
          inbound &&
          (QUEUED_STATUSES.has(status) ||
            (committed !== null &&
              row.sequence !== null &&
              row.sequence > committed)),
      };
      const holder = kept.get(row.id);
      if (holder) {
        if (
          holder.timestamp === message.timestamp &&
          sameAuthorAndText(holder, message)
        ) {
          plan.duplicates.push({ chatJid, id: row.id });
          source.duplicates += 1;
          continue;
        }
        let id = `${row.id}@${chatJid}`;
        for (let n = 2; kept.has(id); n++) id = `${row.id}@${chatJid}#${n}`;
        message.id = id;
        plan.renamed.push({ chatJid, from: row.id, to: id });
        source.renamed += 1;
      }
      kept.set(message.id, message);
      source.moved += 1;
    }
    plan.sources.push(source);
  }

  plan.order = [...kept.values()].sort(compareHistory);
  if (plan.order.length === 0) return plan;
  const pendingIds: string[] = [];
  let firstPending = -1;
  let lastProcessed = -1;
  plan.order.forEach((m, index) => {
    if (m.inbound && m.timestamp === null) plan.nullTimestampInbound.push(m.id);
    if (m.pending) {
      pendingIds.push(m.id);
      if (firstPending === -1) firstPending = index;
    } else if (m.inbound) {
      lastProcessed = index;
    }
  });
  if (firstPending !== -1 && lastProcessed < firstPending) {
    plan.cursorAfter = firstPending - 1;
    plan.pendingReplayed = pendingIds;
  } else {
    plan.cursorAfter = plan.order.length - 1;
    plan.pendingNotReplayed = pendingIds;
  }
  return plan;
}

/** Main-lane channel turns that would carry on after the restart. */
function nonTerminalMainTurnRuns(
  db: Db,
  sourceJids: readonly string[],
): string[] {
  return (
    prep(
      db,
      `SELECT id FROM turn_runs
       WHERE (agent_id IS NULL OR agent_id = '')
         AND status NOT IN (SELECT value FROM json_each(?))
         AND correlation_id IN (
           SELECT id FROM messages
           WHERE chat_jid IN (SELECT value FROM json_each(?)))
       ORDER BY id`,
    ).all(
      JSON.stringify(CHANNEL_RELIABILITY_TERMINAL_STATUSES.turns),
      JSON.stringify(sourceJids),
    ) as Array<{ id: string }>
  ).map((row) => row.id);
}

export function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

type DirectoryKind = 'dir' | 'symlink' | 'missing' | 'other';

/** What sits at sessions/<folder>/.claude; lstat only, never the contents. */
function sessionDirectoryKind(dataDir: string, folder: string): DirectoryKind {
  if (!isValidWorkspaceFolderName(folder)) return 'other';
  const stat = lstatOrNull(path.join(dataDir, 'sessions', folder, '.claude'));
  if (!stat) return 'missing';
  if (stat.isSymbolicLink()) return 'symlink';
  return stat.isDirectory() ? 'dir' : 'other';
}

/** Everything the migration decides for one workspace. */
export function planWorkspace(
  db: Db,
  workspace: WorkspaceRow,
  targets: MainTargetPlan,
) {
  const ownsFolderState =
    folderOwnerJid(db, workspace.folder) === workspace.jid;
  const sourceJids = workspaceSourceJids(db, workspace);
  const bindings = targets.byWorkspace.get(workspace.jid) ?? [];
  return {
    ownsFolderState,
    sourceJids,
    bindings,
    migrates: hasMainState(
      db,
      workspace,
      sourceJids,
      ownsFolderState,
      bindings,
    ),
    messages: planWorkspaceMessages(db, workspace.jid, sourceJids),
  };
}

/**
 * What the migration would do to this (v87) database: per workspace and in
 * total, everything the review asked to confirm. Ids and counts only.
 */
export function previewLegacyMainSessions(
  db: Db,
  options: { dataDir: string },
) {
  const targets = planMainTargets(db);
  const workspaces = listWorkspaces(db).map((workspace) => {
    const { ownsFolderState, sourceJids, bindings, migrates, messages } =
      planWorkspace(db, workspace, targets);
    return {
      workspaceJid: workspace.jid,
      folder: workspace.folder,
      isHome: !!workspace.is_home,
      migrates,
      ownsFolderState,
      sources: messages.sources,
      bindings: bindings.map((b) => b.channelJid),
      pendingReplayed: messages.pendingReplayed,
      pendingNotReplayed: messages.pendingNotReplayed,
      nullTimestampInbound: messages.nullTimestampInbound,
      duplicateIds: [
        ...messages.duplicates.map((d) => ({ ...d, contentMatches: true })),
        ...messages.renamed.map((r) => ({
          chatJid: r.chatJid,
          id: r.from,
          contentMatches: false,
        })),
      ],
      nonTerminalTurnRuns: nonTerminalMainTurnRuns(db, sourceJids),
      sessionDirectory:
        migrates && ownsFolderState
          ? sessionDirectoryKind(options.dataDir, workspace.folder)
          : null,
    };
  });
  const totals = {
    workspaces: workspaces.length,
    migrating: 0,
    pendingReplayed: 0,
    pendingNotReplayed: 0,
    nonTerminalTurnRuns: 0,
    topicContainers: targets.topicContainers.length,
    duplicateIdsMatching: 0,
    duplicateIdsDiffering: 0,
    nullTimestampInbound: 0,
    sessionDirectories: { dir: 0, symlink: 0, missing: 0, other: 0 },
  };
  for (const w of workspaces) {
    totals.migrating += w.migrates ? 1 : 0;
    totals.pendingReplayed += w.pendingReplayed.length;
    totals.pendingNotReplayed += w.pendingNotReplayed.length;
    totals.nonTerminalTurnRuns += w.nonTerminalTurnRuns.length;
    for (const d of w.duplicateIds) {
      if (d.contentMatches) totals.duplicateIdsMatching += 1;
      else totals.duplicateIdsDiffering += 1;
    }
    totals.nullTimestampInbound += w.nullTimestampInbound.length;
    if (w.sessionDirectory) totals.sessionDirectories[w.sessionDirectory] += 1;
  }
  // The review's new code paths; all zero means the migration takes none.
  const attention = [
    ...(
      [
        'pendingReplayed',
        'pendingNotReplayed',
        'nonTerminalTurnRuns',
        'topicContainers',
        'duplicateIdsDiffering',
        'nullTimestampInbound',
      ] as const
    ).filter((key) => totals[key] > 0),
    ...(totals.sessionDirectories.symlink > 0
      ? ['symlinkSessionDirectories']
      : []),
    ...(totals.sessionDirectories.other > 0 ? ['otherSessionDirectories'] : []),
  ];
  return {
    clean: attention.length === 0,
    attention,
    totals,
    topicContainers: targets.topicContainers,
    staleBindings: targets.stale,
    redundantMainTargets: targets.redundant,
    unresolvedBindings: targets.unresolved,
    workspaces,
  };
}
