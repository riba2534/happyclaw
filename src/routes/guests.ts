/**
 * /api/guests — an account's own read-only guest accounts.
 *
 * Any active admin or member may create guests attached to themselves and
 * grant each one read-only visibility into a subset of their OWN workspaces
 * (`web:*` records they created, Home included). Every route is scoped to the
 * caller's guests: another user's guest answers 404, as does a workspace JID
 * the caller does not own (existence is never revealed). Grant changes take
 * effect on the guest's next request; status, password and deletion changes
 * also drop the guest's sessions.
 */
import { Hono, type Context } from 'hono';

import type { Variables } from '../web-context.js';
import { invalidateUserSessions } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { GuestCreateSchema, GuestPatchSchema } from '../schemas.js';
import {
  createUser,
  deleteGuestUser,
  deleteUserSessionsByUserId,
  getAllRegisteredGroups,
  getRegisteredGroup,
  getUserById,
  getUserByUsername,
  listGuestWorkspaceGrants,
  listGuestsByOwner,
  logAuthEvent,
  replaceGuestWorkspaceGrants,
  updateUserFields,
} from '../db.js';
import {
  generateUserId,
  hashPassword,
  validatePassword,
  validateUsername,
} from '../auth.js';
import { isUsernameConflictError } from './auth.js';
import { onPasswordHashBusy } from '../password-hash-busy.js';
import { getClientIp } from '../utils.js';
import type { AuthUser, User } from '../types.js';

const guestRoutes = new Hono<{ Variables: Variables }>();
guestRoutes.onError(onPasswordHashBusy);

interface WorkspaceRef {
  jid: string;
  name: string;
  is_home: boolean;
}

/** The caller's own `web:*` workspaces, Home first then by name. */
function listGrantableWorkspaces(ownerId: string): WorkspaceRef[] {
  return Object.entries(getAllRegisteredGroups())
    .filter(
      ([jid, group]) =>
        jid.startsWith('web:') &&
        !jid.includes('#') &&
        group.created_by === ownerId,
    )
    .map(([jid, group]) => ({
      jid,
      name: group.name || jid,
      is_home: !!group.is_home,
    }))
    .sort(
      (a, b) =>
        Number(b.is_home) - Number(a.is_home) || a.name.localeCompare(b.name),
    );
}

/** Every JID must be a workspace the owner created; dedupes the set. */
function validateWorkspaceJids(
  ownerId: string,
  jids: readonly string[],
): string[] | null {
  const unique = [...new Set(jids)];
  for (const jid of unique) {
    const group = getRegisteredGroup(jid);
    if (!group || !jid.startsWith('web:') || group.created_by !== ownerId) {
      return null;
    }
  }
  return unique;
}

function serializeGuest(guest: User) {
  const workspaces: WorkspaceRef[] = [];
  for (const grant of listGuestWorkspaceGrants(guest.id)) {
    const group = getRegisteredGroup(grant.workspace_jid);
    // A grant whose workspace was deleted or changed hands is inert; do not
    // present it as access.
    if (!group || group.created_by !== guest.guest_owner_id) continue;
    workspaces.push({
      jid: grant.workspace_jid,
      name: group.name || grant.workspace_jid,
      is_home: !!group.is_home,
    });
  }
  return {
    id: guest.id,
    username: guest.username,
    display_name: guest.display_name,
    status: guest.status === 'active' ? 'active' : 'disabled',
    created_at: guest.created_at,
    last_login_at: guest.last_login_at,
    workspaces,
  };
}

/** Owner-scoped guest lookup; anything else is "not found". */
function findOwnGuest(owner: AuthUser, guestId: string): User | null {
  const guest = getUserById(guestId);
  if (
    !guest ||
    guest.role !== 'guest' ||
    guest.status === 'deleted' ||
    guest.guest_owner_id !== owner.id
  ) {
    return null;
  }
  return guest;
}

function revokeSessions(userId: string): void {
  invalidateUserSessions(userId);
  deleteUserSessionsByUserId(userId);
}

function requireOwner(c: Context<{ Variables: Variables }>): AuthUser | null {
  const user = c.get('user') as AuthUser;
  // Guests cannot own guests (the global guard already refuses them).
  return user.role === 'guest' ? null : user;
}

guestRoutes.get('/', authMiddleware, (c) => {
  const owner = requireOwner(c);
  if (!owner) return c.json({ error: 'Forbidden' }, 403);
  return c.json({
    guests: listGuestsByOwner(owner.id).map(serializeGuest),
    grantable_workspaces: listGrantableWorkspaces(owner.id),
  });
});

guestRoutes.post('/', authMiddleware, async (c) => {
  const owner = requireOwner(c);
  if (!owner) return c.json({ error: 'Forbidden' }, 403);
  const validation = GuestCreateSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request', details: validation.error.format() },
      400,
    );
  }
  const { username: rawUsername, password, display_name } = validation.data;

  const usernameError = validateUsername(rawUsername);
  if (usernameError) return c.json({ error: usernameError }, 400);
  const username = rawUsername.toLowerCase();
  const passwordError = validatePassword(password);
  if (passwordError) return c.json({ error: passwordError }, 400);

  const workspaceJids = validateWorkspaceJids(
    owner.id,
    validation.data.workspace_jids,
  );
  if (!workspaceJids) return c.json({ error: 'Workspace not found' }, 400);
  if (getUserByUsername(username)) {
    return c.json({ error: 'Username already taken' }, 409);
  }

  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();
  const guestId = generateUserId();
  try {
    createUser({
      id: guestId,
      username,
      password_hash: passwordHash,
      display_name: display_name || username,
      role: 'guest',
      status: 'active',
      permissions: [],
      must_change_password: false,
      guest_owner_id: owner.id,
      created_at: now,
      updated_at: now,
    });
  } catch (err) {
    if (isUsernameConflictError(err)) {
      return c.json({ error: 'Username already taken' }, 409);
    }
    throw err;
  }
  replaceGuestWorkspaceGrants(guestId, owner.id, workspaceJids);

  logAuthEvent({
    event_type: 'user_created',
    username,
    actor_username: owner.username,
    ip_address: getClientIp(c),
    details: { role: 'guest', workspace_count: workspaceJids.length },
  });
  return c.json({ guest: serializeGuest(getUserById(guestId)!) }, 201);
});

guestRoutes.patch('/:id', authMiddleware, async (c) => {
  const owner = requireOwner(c);
  if (!owner) return c.json({ error: 'Forbidden' }, 403);
  const guest = findOwnGuest(owner, c.req.param('id'));
  if (!guest) return c.json({ error: 'Guest not found' }, 404);

  const validation = GuestPatchSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request', details: validation.error.format() },
      400,
    );
  }
  const data = validation.data;

  let workspaceJids: string[] | null = null;
  if (data.workspace_jids !== undefined) {
    workspaceJids = validateWorkspaceJids(owner.id, data.workspace_jids);
    if (!workspaceJids) return c.json({ error: 'Workspace not found' }, 400);
  }
  if (data.password !== undefined) {
    const passwordError = validatePassword(data.password);
    if (passwordError) return c.json({ error: passwordError }, 400);
  }

  const updates: Parameters<typeof updateUserFields>[1] = {};
  if (data.display_name !== undefined) {
    updates.display_name = data.display_name || guest.username;
  }
  if (data.status !== undefined && data.status !== guest.status) {
    updates.status = data.status;
    updates.disable_reason =
      data.status === 'disabled' ? 'disabled_by_owner' : null;
  }
  if (data.password !== undefined) {
    updates.password_hash = await hashPassword(data.password);
  }
  if (Object.keys(updates).length > 0) updateUserFields(guest.id, updates);
  if (workspaceJids) {
    replaceGuestWorkspaceGrants(guest.id, owner.id, workspaceJids);
  }

  const ip = getClientIp(c);
  if (updates.status !== undefined || updates.password_hash !== undefined) {
    revokeSessions(guest.id);
    logAuthEvent({
      event_type: 'session_revoked',
      username: guest.username,
      actor_username: owner.username,
      ip_address: ip,
      details: { action: 'guest_update' },
    });
  }
  if (updates.status === 'disabled' || updates.status === 'active') {
    logAuthEvent({
      event_type:
        updates.status === 'disabled' ? 'user_disabled' : 'user_enabled',
      username: guest.username,
      actor_username: owner.username,
      ip_address: ip,
    });
  }
  if (updates.password_hash !== undefined) {
    logAuthEvent({
      event_type: 'password_changed',
      username: guest.username,
      actor_username: owner.username,
      ip_address: ip,
      details: { guest_owner_reset: true },
    });
  }
  logAuthEvent({
    event_type: 'user_updated',
    username: guest.username,
    actor_username: owner.username,
    ip_address: ip,
    details: {
      role: 'guest',
      fields: [
        ...Object.keys(updates).filter((key) => key !== 'password_hash'),
        ...(updates.password_hash !== undefined ? ['password'] : []),
        ...(workspaceJids ? ['workspace_jids'] : []),
      ],
    },
  });
  return c.json({ guest: serializeGuest(getUserById(guest.id)!) });
});

guestRoutes.delete('/:id', authMiddleware, (c) => {
  const owner = requireOwner(c);
  if (!owner) return c.json({ error: 'Forbidden' }, 403);
  const guest = findOwnGuest(owner, c.req.param('id'));
  if (!guest) return c.json({ error: 'Guest not found' }, 404);

  deleteGuestUser(guest.id);
  invalidateUserSessions(guest.id);
  logAuthEvent({
    event_type: 'user_deleted',
    username: guest.username,
    actor_username: owner.username,
    ip_address: getClientIp(c),
    details: { role: 'guest' },
  });
  return c.json({ success: true });
});

export default guestRoutes;
