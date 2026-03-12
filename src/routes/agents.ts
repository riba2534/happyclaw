import { Hono } from 'hono';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Variables } from '../web-context.js';
import { getWebDeps } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { canAccessGroup } from '../web-context.js';
import {
  getRegisteredGroup,
  getAllRegisteredGroups,
  listAgentsByJid,
  getAgent,
  deleteAgent,
  updateAgentStatus,
  createAgent,
  ensureChatExists,
  deleteMessagesForChatJid,
  deleteSession,
  getGroupsByTargetAgent,
  setRegisteredGroup,
  getJidsByFolder,
} from '../db.js';
import { DATA_DIR } from '../config.js';
import type { RegisteredGroup, SubAgent } from '../types.js';
import { logger } from '../logger.js';
import { getChannelType, extractChatId } from '../im-channel.js';

const router = new Hono<{ Variables: Variables }>();

// GET /api/groups/:jid/agents — list all agents for a group
router.get('/:jid/agents', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const agents = listAgentsByJid(jid);
  return c.json({
    agents: agents.map((a) => {
      const base = {
        id: a.id,
        name: a.name,
        prompt: a.prompt,
        status: a.status,
        kind: a.kind,
        created_at: a.created_at,
        completed_at: a.completed_at,
        result_summary: a.result_summary,
      };
      if (a.kind === 'conversation') {
        const linked = getGroupsByTargetAgent(a.id);
        return {
          ...base,
          linked_im_groups: linked.map((l) => ({
            jid: l.jid,
            name: l.group.name,
          })),
        };
      }
      return base;
    }),
  });
});

// POST /api/groups/:jid/agents — create a user conversation
router.post('/:jid/agents', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 40) {
    return c.json({ error: 'Name is required (max 40 chars)' }, 400);
  }
  const description =
    typeof body.description === 'string' ? body.description.trim() : '';

  const agentId = crypto.randomUUID();
  const now = new Date().toISOString();

  const agent: SubAgent = {
    id: agentId,
    group_folder: group.folder,
    chat_jid: jid,
    name,
    prompt: description,
    status: 'idle',
    kind: 'conversation',
    created_by: user.id,
    created_at: now,
    completed_at: null,
    result_summary: null,
  };

  createAgent(agent);

  // Create IPC directories for this conversation agent
  const agentIpcDir = path.join(
    DATA_DIR,
    'ipc',
    group.folder,
    'agents',
    agentId,
  );
  fs.mkdirSync(path.join(agentIpcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(agentIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(agentIpcDir, 'tasks'), { recursive: true });

  // Create session directory
  const agentSessionDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agents',
    agentId,
    '.claude',
  );
  fs.mkdirSync(agentSessionDir, { recursive: true });

  // Create virtual chat record for this agent's messages
  const virtualChatJid = `${jid}#agent:${agentId}`;
  ensureChatExists(virtualChatJid);

  // Broadcast agent_status (idle) via WebSocket
  // Import dynamically to avoid circular deps
  const { broadcastAgentStatus } = await import('../web.js');
  broadcastAgentStatus(jid, agentId, 'idle', name, description);

  logger.info(
    { agentId, jid, name, userId: user.id },
    'User conversation created',
  );

  return c.json({
    agent: {
      id: agent.id,
      name: agent.name,
      prompt: agent.prompt,
      status: agent.status,
      kind: agent.kind,
      created_at: agent.created_at,
    },
  });
});

// DELETE /api/groups/:jid/agents/:agentId — stop and delete an agent
router.delete('/:jid/agents/:agentId', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const agentId = c.req.param('agentId');
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const agent = getAgent(agentId);
  if (!agent || agent.chat_jid !== jid) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  // Block deletion if conversation agent has active IM bindings
  if (agent.kind === 'conversation') {
    const linkedImGroups = getGroupsByTargetAgent(agentId);
    if (linkedImGroups.length > 0) {
      return c.json(
        {
          error:
            'Agent has active IM bindings. Unbind all IM groups before deleting.',
          linked_im_groups: linkedImGroups.map(
            ({ jid: imJid, group: imGroup }) => ({
              jid: imJid,
              name: imGroup.name,
            }),
          ),
        },
        409,
      );
    }
  }

  // If the agent is still running or idle, stop the process
  if (agent.status === 'running' || agent.status === 'idle') {
    updateAgentStatus(agentId, 'error', '用户手动停止');
    // Stop running process via queue
    const deps = getWebDeps();
    if (deps) {
      const virtualJid = `${jid}#agent:${agentId}`;
      deps.queue.stopGroup(virtualJid);
    }
  }

  // Clean up IPC/session directories
  const agentIpcDir = path.join(
    DATA_DIR,
    'ipc',
    group.folder,
    'agents',
    agentId,
  );
  try {
    fs.rmSync(agentIpcDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const agentSessionDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agents',
    agentId,
  );
  try {
    fs.rmSync(agentSessionDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  // Delete virtual chat messages for conversation agents
  if (agent.kind === 'conversation') {
    const virtualChatJid = `${jid}#agent:${agentId}`;
    deleteMessagesForChatJid(virtualChatJid);

    // Note: IM bindings are checked above and block deletion if present.
    // No auto-clear here — user must unbind explicitly before deleting.
  }

  // Delete session records
  deleteSession(group.folder, agentId);

  deleteAgent(agentId);

  // Broadcast removal
  const { broadcastAgentStatus } = await import('../web.js');
  broadcastAgentStatus(
    jid,
    agentId,
    'error',
    agent.name,
    agent.prompt,
    '__removed__',
  );

  logger.info({ agentId, jid, userId: user.id }, 'Agent deleted by user');
  return c.json({ success: true });
});

// Helper: check if a Telegram JID is a private/P2P chat
function isTelegramPrivateChat(jid: string): boolean {
  if (!jid.startsWith('telegram:')) return false;
  const id = jid.slice('telegram:'.length);
  return !id.startsWith('-');
}

// GET /api/groups/:jid/im-groups — list available IM group chats for this folder
router.get('/:jid/im-groups', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Find all IM groups this user can access (across all folders).
  const allGroups = getAllRegisteredGroups();
  const imJids = Object.keys(allGroups)
    .filter((j) => {
      if (j.startsWith('web:')) return false;
      return canAccessGroup(user, { ...allGroups[j], jid: j });
    })
    .filter((j) => !isTelegramPrivateChat(j));

  // Build candidate list
  interface ImGroupCandidate {
    jid: string;
    name: string;
    bound_agent_id: string | null;
    bound_main_jid: string | null;
    reply_policy: 'source_only' | 'mirror';
    bound_target_name: string | null;
    bound_workspace_name: string | null;
    avatar?: string;
    member_count?: number;
    channel_type: string;
    chat_mode?: string; // 'p2p' | 'group' — from Feishu API (distinguishes P2P vs group chat)
  }

  const candidates: ImGroupCandidate[] = [];
  for (const j of imJids) {
    const g = allGroups[j];

    // Resolve bound target name for display
    let boundTargetName: string | null = null;
    let boundWorkspaceName: string | null = null;
    if (g.target_agent_id) {
      const boundAgent = getAgent(g.target_agent_id);
      if (boundAgent) {
        boundTargetName = boundAgent.name;
        const ownerGroup = getRegisteredGroup(boundAgent.chat_jid);
        if (ownerGroup) boundWorkspaceName = ownerGroup.name;
      }
    } else if (g.target_main_jid) {
      let boundGroup = getRegisteredGroup(g.target_main_jid);
      // Legacy fallback: old bindings stored web:${folder} instead of actual JID
      if (!boundGroup && g.target_main_jid.startsWith('web:')) {
        const folder = g.target_main_jid.slice(4);
        const jids = getJidsByFolder(folder);
        for (const fj of jids) {
          if (fj.startsWith('web:')) {
            boundGroup = getRegisteredGroup(fj);
            if (boundGroup) break;
          }
        }
      }
      if (boundGroup) boundTargetName = boundGroup.name;
    }

    candidates.push({
      jid: j,
      name: g.name,
      bound_agent_id: g.target_agent_id ?? null,
      bound_main_jid: g.target_main_jid ?? null,
      reply_policy: g.reply_policy === 'mirror' ? 'mirror' : 'source_only',
      bound_target_name: boundTargetName,
      bound_workspace_name: boundWorkspaceName,
      channel_type: getChannelType(j) ?? 'unknown',
    });
  }

  // Enrich Feishu groups with avatar, member count, and chat_mode
  const deps = getWebDeps();
  if (deps?.getFeishuChatInfo) {
    const feishuCandidates = candidates.filter(
      (g) => g.channel_type === 'feishu',
    );
    const chatInfoPromises = feishuCandidates.map(async (g) => {
      const chatId = extractChatId(g.jid);
      const info = await deps.getFeishuChatInfo!(user.id, chatId);
      if (info) {
        g.avatar = info.avatar;
        g.chat_mode = info.chat_mode;
        if (info.user_count != null) {
          const count = parseInt(info.user_count, 10);
          if (!isNaN(count)) g.member_count = count;
        }
        if (info.name && info.name !== g.name) g.name = info.name;
      }
    });
    await Promise.allSettled(chatInfoPromises);
  }

  // Feishu chat_mode: 'group' = group chat, 'p2p' = private chat
  // If chat_mode is available, use it directly. When API data is completely
  // missing (permissions not enabled), default to keeping the group rather
  // than filtering it out. Only filter when chat_mode is explicitly 'p2p'.
  const imGroups = candidates
    .filter((g) => {
      if (g.channel_type === 'feishu') {
        if (g.chat_mode === 'p2p') return false;
        // Exclude groups with only the bot (user_count=0 means no real users, just bot)
        if (g.member_count !== undefined && g.member_count < 1) return false;
        // chat_mode is 'group' or API data completely missing — keep the group
        return true;
      }
      return true;
    })
    .map(({ chat_mode: _, ...rest }) => rest);

  return c.json({ imGroups });
});

// PUT /api/groups/:jid/agents/:agentId/im-binding — bind an IM group to this agent
router.put('/:jid/agents/:agentId/im-binding', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const agentId = c.req.param('agentId');
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const agent = getAgent(agentId);
  if (!agent || agent.chat_jid !== jid) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  if (agent.kind !== 'conversation') {
    return c.json(
      { error: 'Only conversation agents can bind IM groups' },
      400,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const imJid = typeof body.im_jid === 'string' ? body.im_jid.trim() : '';
  if (!imJid) {
    return c.json({ error: 'im_jid is required' }, 400);
  }

  const imGroup = getRegisteredGroup(imJid);
  if (!imGroup) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...imGroup, jid: imJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const force = body.force === true;
  const replyPolicy = body.reply_policy === 'mirror' ? 'mirror' : 'source_only';
  const hasConflict =
    (imGroup.target_agent_id && imGroup.target_agent_id !== agentId) ||
    !!imGroup.target_main_jid;
  if (hasConflict && !force) {
    return c.json({ error: 'IM group is already bound elsewhere' }, 409);
  }

  // Update DB + in-memory cache — clear target_main_jid to avoid conflicts
  const updated: RegisteredGroup = {
    ...imGroup,
    target_agent_id: agentId,
    target_main_jid: undefined,
    reply_policy: replyPolicy,
  };
  setRegisteredGroup(imJid, updated);
  const deps = getWebDeps();
  if (deps) {
    const groups = deps.getRegisteredGroups();
    if (groups[imJid]) groups[imJid] = updated;
  }

  logger.info({ imJid, agentId, userId: user.id }, 'IM group bound to agent');
  return c.json({ success: true });
});

// DELETE /api/groups/:jid/agents/:agentId/im-binding/:imJid — unbind an IM group
router.delete(
  '/:jid/agents/:agentId/im-binding/:imJid',
  authMiddleware,
  async (c) => {
    const jid = decodeURIComponent(c.req.param('jid'));
    const agentId = c.req.param('agentId');
    const imJid = decodeURIComponent(c.req.param('imJid'));
    const user = c.get('user');

    const group = getRegisteredGroup(jid);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (!canAccessGroup(user, { ...group, jid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const agent = getAgent(agentId);
    if (!agent || agent.chat_jid !== jid) {
      return c.json({ error: 'Agent not found' }, 404);
    }

    const imGroup = getRegisteredGroup(imJid);
    if (!imGroup) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    if (!canAccessGroup(user, { ...imGroup, jid: imJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (imGroup.target_agent_id !== agentId) {
      return c.json({ error: 'IM group is not bound to this agent' }, 400);
    }

    // Update DB + in-memory cache
    const updated = { ...imGroup, target_agent_id: undefined };
    setRegisteredGroup(imJid, updated);
    const deps = getWebDeps();
    if (deps) {
      const groups = deps.getRegisteredGroups();
      if (groups[imJid]) groups[imJid] = updated;
    }

    logger.info(
      { imJid, agentId, userId: user.id },
      'IM group unbound from agent',
    );
    return c.json({ success: true });
  },
);

// PUT /api/groups/:jid/im-binding — bind an IM group to this workspace's main conversation
router.put('/:jid/im-binding', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (group.is_home) {
    return c.json(
      { error: 'Home workspace main conversation uses default IM routing' },
      400,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const imJid = typeof body.im_jid === 'string' ? body.im_jid.trim() : '';
  if (!imJid) {
    return c.json({ error: 'im_jid is required' }, 400);
  }

  const imGroup = getRegisteredGroup(imJid);
  if (!imGroup) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...imGroup, jid: imJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const targetMainJid = jid; // Use actual registered JID (not folder-based)
  const legacyMainJid = `web:${group.folder}`;
  const force = body.force === true;
  const replyPolicy = body.reply_policy === 'mirror' ? 'mirror' : 'source_only';
  const hasConflict =
    !!imGroup.target_agent_id ||
    (imGroup.target_main_jid &&
      imGroup.target_main_jid !== targetMainJid &&
      imGroup.target_main_jid !== legacyMainJid);
  if (hasConflict && !force) {
    return c.json({ error: 'IM group is already bound elsewhere' }, 409);
  }

  // Update DB + in-memory cache — clear target_agent_id to avoid conflicts
  const updated: RegisteredGroup = {
    ...imGroup,
    target_main_jid: targetMainJid,
    target_agent_id: undefined,
    reply_policy: replyPolicy,
  };
  setRegisteredGroup(imJid, updated);
  const deps = getWebDeps();
  if (deps) {
    const groups = deps.getRegisteredGroups();
    if (groups[imJid]) groups[imJid] = updated;
  }

  logger.info(
    { imJid, targetMainJid, userId: user.id },
    'IM group bound to workspace main conversation',
  );
  return c.json({ success: true });
});

// DELETE /api/groups/:jid/im-binding/:imJid — unbind an IM group from this workspace's main conversation
router.delete('/:jid/im-binding/:imJid', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const imJid = decodeURIComponent(c.req.param('imJid'));
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const imGroup = getRegisteredGroup(imJid);
  if (!imGroup) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...imGroup, jid: imJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const targetMainJid = jid; // Use actual registered JID (not folder-based)
  const legacyMainJid = `web:${group.folder}`;
  if (
    imGroup.target_main_jid !== targetMainJid &&
    imGroup.target_main_jid !== legacyMainJid
  ) {
    return c.json({ error: 'IM group is not bound to this workspace' }, 400);
  }

  // Update DB + in-memory cache
  const updated = { ...imGroup, target_main_jid: undefined };
  setRegisteredGroup(imJid, updated);
  const deps = getWebDeps();
  if (deps) {
    const groups = deps.getRegisteredGroups();
    if (groups[imJid]) groups[imJid] = updated;
  }

  logger.info(
    { imJid, targetMainJid, userId: user.id },
    'IM group unbound from workspace main conversation',
  );
  return c.json({ success: true });
});

export default router;
