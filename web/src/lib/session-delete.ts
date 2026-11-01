import type { ApiError } from '../api/client';
import type { WorktreeDirtyInfo } from './session-worktree';

/** What deleting a session affects besides its own history. */
export interface SessionDeleteImpact {
  /** Private chats and ordinary groups bound to it. */
  linkedImGroups: Array<{ jid: string; name: string }>;
  /** Channel topics it holds (a native topic session). */
  threadBindings: Array<{ jid: string; name: string; contextId: string }>;
  /** Automations whose runs go to it. */
  automations: Array<{ id: string; name: string }>;
}

export interface SessionDeleteOptions {
  /** The user confirmed the bindings the server listed. */
  confirmBindings?: boolean;
  /** Move the session's chats to this session of the workspace first. */
  rebindTo?: string | null;
  /** The user confirmed discarding the worktree's changes. */
  forceWorktree?: boolean;
}

export type SessionDeleteResult =
  | boolean
  | { worktreesDirty: WorktreeDirtyInfo[] }
  | { bindings: SessionDeleteImpact };

export const NO_SESSION_DELETE_IMPACT: SessionDeleteImpact = {
  linkedImGroups: [],
  threadBindings: [],
  automations: [],
};

export function sessionDeletePath(
  workspaceJid: string,
  sessionId: string,
  options: SessionDeleteOptions = {},
): string {
  const params = new URLSearchParams();
  if (options.confirmBindings) params.set('confirm_bindings', 'true');
  if (options.confirmBindings && options.rebindTo) {
    params.set('rebind_to', options.rebindTo);
  }
  if (options.forceWorktree) params.set('force_worktree', 'true');
  const query = params.toString();
  return `/api/groups/${encodeURIComponent(workspaceJid)}/sessions/${encodeURIComponent(sessionId)}${query ? `?${query}` : ''}`;
}

/** The bindings a refused delete (409 `session_has_bindings`) listed. */
export function sessionDeleteImpactFromError(
  err: unknown,
): SessionDeleteImpact | null {
  const error = err as Partial<ApiError> | null;
  const body = error?.body as Record<string, unknown> | undefined;
  if (error?.status !== 409 || body?.code !== 'session_has_bindings') {
    return null;
  }
  const list = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value)
      ? value.filter(
          (item): item is Record<string, unknown> =>
            !!item && typeof item === 'object',
        )
      : [];
  const text = (value: unknown, fallback = '') =>
    typeof value === 'string' && value ? value : fallback;
  return {
    linkedImGroups: list(body.linked_im_groups).map((item) => ({
      jid: text(item.jid),
      name: text(item.name, text(item.jid)),
    })),
    threadBindings: list(body.thread_bindings).map((item) => ({
      jid: text(item.jid),
      name: text(item.name, text(item.jid)),
      contextId: text(item.context_id),
    })),
    automations: list(body.automations).map((item) => ({
      id: text(item.id),
      name: text(item.name, text(item.id)),
    })),
  };
}

/**
 * The body of a session's delete confirmation: what it affects, then that
 * its history goes (and its worktree with it).
 */
export function sessionDeleteMessage(
  impact: SessionDeleteImpact,
  worktreeNote?: string,
): string {
  const list = (names: string[]) => names.map((name) => `· ${name}`);
  const sections: string[][] = [];
  if (impact.linkedImGroups.length > 0) {
    sections.push([
      '已连接的聊天：',
      ...list(impact.linkedImGroups.map((item) => item.name)),
      '删除后这些聊天将不再收到回复。',
    ]);
  }
  if (impact.threadBindings.length > 0) {
    sections.push(['删除后，该话题下次发言会开启新的上下文。']);
  }
  if (impact.automations.length > 0) {
    sections.push([
      '绑定此会话的自动化：',
      ...list(impact.automations.map((item) => item.name)),
      '绑定此会话的自动化会暂停。',
    ]);
  }
  sections.push([`删除后会话的聊天记录将无法恢复。${worktreeNote ?? ''}`]);
  return sections.map((lines) => lines.join('\n')).join('\n\n');
}

/** Whether the user was shown everything `actual` lists. */
function wasShown(
  shown: SessionDeleteImpact,
  actual: SessionDeleteImpact,
): boolean {
  const chats = new Set(shown.linkedImGroups.map((item) => item.jid));
  const automations = new Set(shown.automations.map((item) => item.id));
  return (
    actual.linkedImGroups.every((item) => chats.has(item.jid)) &&
    (actual.threadBindings.length === 0 || shown.threadBindings.length > 0) &&
    actual.automations.every((item) => automations.has(item.id))
  );
}

/** The user's answer to a delete confirmation; null cancels. */
export type SessionDeleteChoice = { rebindTo: string | null } | null;

/**
 * Delete a session the way its confirmation promised. The user first
 * confirms what this tab knows it affects (`known`); the server is then the
 * authority. A refusal listing bindings the user was shown is confirmed
 * (with the chosen rebind target); one listing more asks again with the
 * server's list. A refusal over the worktree asks about its changes.
 */
export async function runSessionDelete({
  known,
  ask,
  confirmWorktree,
  remove,
}: {
  known: SessionDeleteImpact;
  ask: (impact: SessionDeleteImpact) => Promise<SessionDeleteChoice>;
  confirmWorktree: (dirty: WorktreeDirtyInfo[]) => Promise<boolean>;
  remove: (options: SessionDeleteOptions) => Promise<SessionDeleteResult>;
}): Promise<'deleted' | 'cancelled' | 'failed'> {
  let shown = known;
  let choice = await ask(known);
  if (!choice) return 'cancelled';
  const options: SessionDeleteOptions = {};
  // Each refusal is answered once: bindings, then the worktree.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await remove({ ...options });
    if (result === true) return 'deleted';
    if (result === false) return 'failed';
    if ('bindings' in result) {
      if (options.confirmBindings && wasShown(shown, result.bindings)) {
        return 'failed';
      }
      if (!wasShown(shown, result.bindings)) {
        shown = result.bindings;
        choice = await ask(result.bindings);
        if (!choice) return 'cancelled';
      }
      options.confirmBindings = true;
      options.rebindTo =
        result.bindings.linkedImGroups.length > 0 ? choice.rebindTo : null;
      continue;
    }
    if (!(await confirmWorktree(result.worktreesDirty))) return 'cancelled';
    options.forceWorktree = true;
  }
  return 'failed';
}
