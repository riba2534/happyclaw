/**
 * GET /api/groups/:jid/turn-traces/:turnId
 *
 * The thinking summary, execution trace and ordered steps of one finished
 * turn. The Web used to keep them in browser memory only; the host now stores
 * them when the turn settles (turn_traces) and the message list flags the
 * messages that have one (`has_trace`). Access follows the message list:
 * whoever can read a chat's history can read its traces, and a proactive
 * workspace shows what its *current* process visibility allows.
 */

import { Hono } from 'hono';

import { authMiddleware } from '../middleware/auth.js';
import { canViewGroup, canViewHostGroup } from '../guest-access.js';
import { getAgent, getRegisteredGroup, getTurnTrace } from '../db.js';
import { isHostExecutionGroup, type Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { presentTurnTrace, resolveTurnTraceExposure } from '../turn-trace.js';
import {
  resolveMessageExecutionGroup,
  resolveMessageQueryJids,
} from './groups.js';

const turnTraceRoutes = new Hono<{ Variables: Variables }>();

const AGENT_JID_MARKER = '#agent:';

turnTraceRoutes.get('/:jid/turn-traces/:turnId', authMiddleware, (c) => {
  // Per-user content, like the message list itself.
  c.header('Cache-Control', 'private, no-store');

  // A Runtime Session's chat is the virtual `{workspaceJid}#agent:{sessionId}`,
  // which is not a registered group: resolve its workspace first, exactly as
  // DELETE /:jid/messages/:messageId does.
  const chatJid = c.req.param('jid');
  const turnId = c.req.param('turnId');
  const agentSep = chatJid.indexOf(AGENT_JID_MARKER);
  const groupJid = agentSep >= 0 ? chatJid.slice(0, agentSep) : chatJid;
  const agentId =
    agentSep >= 0 ? chatJid.slice(agentSep + AGENT_JID_MARKER.length) : null;

  const physicalGroup = getRegisteredGroup(groupJid);
  if (!physicalGroup) return c.json({ error: 'Group not found' }, 404);
  const executionGroup = resolveMessageExecutionGroup(groupJid, physicalGroup);
  if (!executionGroup) return c.json({ error: 'Group not found' }, 404);

  const authUser = c.get('user') as AuthUser;
  const principal = { id: authUser.id, role: authUser.role };
  if (
    !canViewGroup(principal, physicalGroup) ||
    !canViewGroup(principal, executionGroup)
  ) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (
    isHostExecutionGroup(executionGroup) &&
    !canViewHostGroup(authUser, executionGroup)
  ) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  let agentKind: string | null = null;
  if (agentId) {
    const agent = getAgent(agentId);
    if (!agent || agent.chat_jid !== groupJid) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    agentKind = agent.kind;
  }

  const exposure = resolveTurnTraceExposure(executionGroup.folder, {
    agentKind,
  });
  if (!exposure.visible) return c.json({ error: 'Trace not found' }, 404);

  // A trace is stored under the chat its messages live in. The client names
  // that chat, but a home group's history also merges its IM chats, so look
  // there as well when it named the workspace itself.
  const candidates = agentId
    ? [chatJid]
    : [chatJid, ...resolveMessageQueryJids(chatJid, physicalGroup).slice(1)];
  for (const candidate of candidates) {
    const record = getTurnTrace(candidate, turnId);
    if (record) return c.json(presentTurnTrace(record, exposure));
  }
  return c.json({ error: 'Trace not found' }, 404);
});

export default turnTraceRoutes;
