import fs from 'fs';
import path from 'path';
import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import {
  authMiddleware,
  usersManageMiddleware,
  inviteManageMiddleware,
  auditViewMiddleware,
} from '../middleware/auth.js';
import {
  AdminCreateUserSchema,
  AdminPatchUserSchema,
  InviteCreateSchema,
} from '../schemas.js';
import { isUsernameConflictError, toUserPublic, setSessionCookie } from './auth.js';
import type {
  AuthUser,
  Permission,
  PermissionTemplateKey,
  AuthEventType,
} from '../types.js';
import {
  lastActiveCache,
  invalidateUserSessions,
  getWebDeps,
} from '../web-context.js';
import { imManager } from '../im-manager.js';
import {
  listUsers,
  getUserById,
  getUserByUsername,
  createUser,
  updateUserFields,
  deleteUser,
  restoreUser,

  deleteUserSessionsByUserId,
  createUserSession,
  getActiveAdminCount,
  logAuthEvent,
  getAllInviteCodes,
  getInviteCode,
  createInviteCode as dbCreateInviteCode,
  deleteInviteCode,
  queryAuthAuditLogs,
} from '../db.js';
import {
  validateUsername,
  validatePassword,
  generateUserId,
  hashPassword,
  generateInviteCode,
  generateSessionToken,
  sessionExpiresAt,
} from '../auth.js';
import {
  normalizePermissions,
  ALL_PERMISSIONS,
  PERMISSION_TEMPLATES,
  resolveTemplate,
  hasPermission,
} from '../permissions.js';
import { getClientIp } from '../utils.js';
import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

const adminRoutes = new Hono<{ Variables: Variables }>();

// ISO 8601 日期格式验证正则（审计日志查询 from/to 参数）
const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * 防止特权升级：非 admin actor 不应能对持有自己未持有权限的目标做 destructive
 * 操作（改密码、改状态、删除/恢复、撤所有 session）。返回 null = 通过；返回
 * Response = 403 失败响应。
 *
 * Admin role 拥有 ALL_PERMISSIONS，自然不会触发；target 是 admin 的情况由各
 * handler 自己的 `target.role === 'admin'` 早 return 拦截。
 */
function denyEscalationToTarget(
  c: any,
  actor: AuthUser,
  target: { role: string; permissions?: readonly Permission[] },
  action: string,
): Response | null {
  if (actor.role === 'admin') return null;
  if (target.role === 'admin') return null;
  const actorPerms = new Set<Permission>(actor.permissions);
  const extra = (target.permissions ?? []).filter((p) => !actorPerms.has(p));
  if (extra.length === 0) return null;
  return c.json(
    {
      error: `Forbidden: cannot ${action} a user who holds permissions you don't [${extra.join(', ')}]`,
    },
    403,
  );
}

// --- User Management ---

// GET /api/admin/users - 获取用户列表
adminRoutes.get('/users', authMiddleware, usersManageMiddleware, (c) => {
  const query = c.req.query('q') || '';
  const roleRaw = c.req.query('role') || 'all';
  const statusRaw = c.req.query('status') || 'all';
  const page = parseInt(c.req.query('page') || '1', 10);
  const pageSize = parseInt(c.req.query('pageSize') || '50', 10);
  const role = roleRaw === 'admin' || roleRaw === 'member' ? roleRaw : 'all';
  const status =
    statusRaw === 'active' ||
    statusRaw === 'disabled' ||
    statusRaw === 'deleted'
      ? statusRaw
      : 'all';

  const result = listUsers({
    query,
    role,
    status,
    page: Number.isFinite(page) ? page : 1,
    pageSize: Number.isFinite(pageSize) ? pageSize : 50,
  });
  return c.json(result);
});

// GET /api/admin/permission-templates - 获取权限模板
adminRoutes.get('/permission-templates', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  if (
    !hasPermission(user, 'manage_users') &&
    !hasPermission(user, 'manage_invites')
  ) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  return c.json({
    permissions: ALL_PERMISSIONS,
    templates: Object.values(PERMISSION_TEMPLATES).map((item) => ({
      key: item.key,
      label: item.label,
      role: item.role,
      permissions: item.permissions,
    })),
  });
});

// POST /api/admin/users - 创建用户
adminRoutes.post('/users', authMiddleware, usersManageMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = AdminCreateUserSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request', details: validation.error.format() },
      400,
    );
  }

  const {
    username: rawUsername,
    password,
    display_name,
    role,
    permissions,
    must_change_password,
    notes,
  } = validation.data;
  const actor = c.get('user') as AuthUser;

  const usernameError = validateUsername(rawUsername);
  if (usernameError) return c.json({ error: usernameError }, 400);
  // Username 归一化（与 login / register / setup 一致）。
  const username = rawUsername.toLowerCase();

  if (getUserByUsername(username)) {
    return c.json({ error: 'Username already taken' }, 409);
  }

  const passwordError = validatePassword(password);
  if (passwordError) return c.json({ error: passwordError }, 400);

  const now = new Date().toISOString();
  const userId = generateUserId();
  const passwordHash = await hashPassword(password);

  const finalRole = role || 'member';
  const finalPermissions = normalizePermissions(
    permissions ?? (finalRole === 'admin' ? ALL_PERMISSIONS : []),
  );

  if (actor.role !== 'admin') {
    if (finalRole === 'admin') {
      return c.json(
        { error: 'Forbidden: only admin can create admin users' },
        403,
      );
    }
    const allowed = new Set(actor.permissions);
    const forbidden = finalPermissions.filter((perm) => !allowed.has(perm));
    if (forbidden.length > 0) {
      return c.json(
        {
          error: `Forbidden: cannot grant permissions [${forbidden.join(', ')}]`,
        },
        403,
      );
    }
  }

  try {
    createUser({
      id: userId,
      username,
      password_hash: passwordHash,
      display_name: display_name || username,
      role: finalRole,
      status: 'active',
      permissions: finalPermissions,
      must_change_password: must_change_password ?? true,
      notes: notes ?? null,
      created_at: now,
      updated_at: now,
    });
  } catch (err) {
    if (isUsernameConflictError(err)) {
      return c.json({ error: 'Username already taken' }, 409);
    }
    throw err;
  }

  logAuthEvent({
    event_type: 'user_created',
    username,
    actor_username: actor.username,
    ip_address: getClientIp(c),
    details: {
      role: finalRole,
      permissions: finalPermissions,
      must_change_password: must_change_password ?? true,
    },
  });

  const newUser = getUserById(userId)!;
  return c.json({ success: true, user: toUserPublic(newUser) }, 201);
});

// PATCH /api/admin/users/:id - 更新用户
adminRoutes.patch(
  '/users/:id',
  authMiddleware,
  usersManageMiddleware,
  async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const validation = AdminPatchUserSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request', details: validation.error.format() },
        400,
      );
    }

    const target = getUserById(id);
    if (!target) return c.json({ error: 'User not found' }, 404);

    const actor = c.get('user') as AuthUser;
    if (actor.role !== 'admin' && target.role === 'admin') {
      return c.json(
        { error: 'Forbidden: only admin can manage admin users' },
        403,
      );
    }
    // 防止特权升级：非 admin 不能对持有自己未持有权限的目标做 destructive 操作
    // （改密码、改状态、改/撤 session、删除 / 恢复、改权限）。否则一个仅持
    // `manage_users` 的账号可重置密码登录目标账号、继承目标的权限（典型路径：
    // user_admin → 持有 manage_system_config 的 member → 全套 provider 配置）。
    //
    // 注意 permissions 也必须纳入 trigger：否则两步绕过 (1) PATCH permissions=[]
    // 把 target 权限抹平 → (2) PATCH password=X 此时 target.permissions 已为空
    // → denyEscalationToTarget 通过 → 接管账号。
    const triggersPrivCheck =
      validation.data.password !== undefined ||
      validation.data.status !== undefined ||
      validation.data.permissions !== undefined;
    if (triggersPrivCheck) {
      const denial = denyEscalationToTarget(c, actor, target, 'modify');
      if (denial) return denial;
    }
    if (
      actor.role !== 'admin' &&
      validation.data.role !== undefined &&
      validation.data.role !== target.role
    ) {
      return c.json({ error: 'Forbidden: only admin can change roles' }, 403);
    }
    if (target.id === actor.id) {
      if (validation.data.role && validation.data.role !== 'admin') {
        return c.json({ error: 'Cannot remove your own admin role' }, 400);
      }
      if (
        validation.data.status === 'disabled' ||
        validation.data.status === 'deleted'
      ) {
        return c.json({ error: 'Cannot disable your own account' }, 400);
      }
    }

    const nextRole = validation.data.role ?? target.role;
    const nextStatus = validation.data.status ?? target.status;
    const targetIsActiveAdmin =
      target.role === 'admin' && target.status === 'active';
    const targetRemainsActiveAdmin =
      nextRole === 'admin' && nextStatus === 'active';
    if (
      targetIsActiveAdmin &&
      !targetRemainsActiveAdmin &&
      getActiveAdminCount() <= 1
    ) {
      return c.json({ error: 'Cannot remove the last active admin' }, 400);
    }

    const updates: Parameters<typeof updateUserFields>[1] = {};

    if (validation.data.role !== undefined) {
      updates.role = validation.data.role;
      if (
        validation.data.permissions === undefined &&
        validation.data.role !== target.role
      ) {
        updates.permissions =
          validation.data.role === 'admin' ? [...ALL_PERMISSIONS] : [];
      }
      if (validation.data.role !== target.role) {
        // 用户角色变更必须立即作废 session：authMiddleware 用 sessionCache
        // 缓存 30 秒（web-context.ts），不主动 invalidate 的话被降级用户在
        // 接下来 30s 内仍能用旧权限访问受限端点。
        invalidateUserSessions(id);
        logAuthEvent({
          event_type: 'role_changed',
          username: target.username,
          actor_username: actor.username,
          ip_address: getClientIp(c),
          details: { from: target.role, to: validation.data.role },
        });
        logAuthEvent({
          event_type: 'session_revoked',
          username: target.username,
          actor_username: actor.username,
          ip_address: getClientIp(c),
          details: { action: 'role_change' },
        });
      }
    }

    if (validation.data.permissions !== undefined) {
      const nextPermissions = normalizePermissions(validation.data.permissions);
      if (actor.role !== 'admin') {
        const allowed = new Set(actor.permissions);
        // 不能赋予 actor 自己没有的权限（grant 上限）。
        const forbidden = nextPermissions.filter((perm) => !allowed.has(perm));
        if (forbidden.length > 0) {
          return c.json(
            {
              error: `Forbidden: cannot assign permissions [${forbidden.join(', ')}]`,
            },
            403,
          );
        }
        // 也不能撤掉 actor 自己没有的权限（remove 对称约束）。否则可以
        // 二步走绕过 denyEscalationToTarget：先 PATCH permissions=[]
        // 把目标权限抹平，再 PATCH password=X 接管账号。
        const targetPerms = target.permissions ?? [];
        const removed = targetPerms.filter((p) => !nextPermissions.includes(p));
        const removedForbidden = removed.filter((p) => !allowed.has(p));
        if (removedForbidden.length > 0) {
          return c.json(
            {
              error: `Forbidden: cannot remove permissions [${removedForbidden.join(', ')}] you don't hold`,
            },
            403,
          );
        }
      }
      updates.permissions = nextPermissions;
      // 权限变更也走作废逻辑，与角色变更对齐。比较使用规范化后的 permissions
      // 排序+JSON 字符串比对，避免顺序差异误判为变更。
      const prevSorted = JSON.stringify(
        [...(target.permissions ?? [])].sort(),
      );
      const nextSorted = JSON.stringify([...nextPermissions].sort());
      if (prevSorted !== nextSorted) {
        invalidateUserSessions(id);
        logAuthEvent({
          event_type: 'session_revoked',
          username: target.username,
          actor_username: actor.username,
          ip_address: getClientIp(c),
          details: { action: 'permissions_change' },
        });
      }
    }

    if (validation.data.notes !== undefined) {
      updates.notes = validation.data.notes;
    }

    if (validation.data.status !== undefined) {
      if (validation.data.status === 'deleted') {
        deleteUser(id);
        // sessionCache 是 30s TTL（web-context.ts），不主动 invalidate
        // 的话被删用户在缓存中仍是 status='active'，可继续 HTTP / WS。
        invalidateUserSessions(id);
        // Tear down all IM connections so feishu/telegram/qq/wechat/etc bots
        // stop responding immediately. Without this the bots would keep firing
        // until the next service restart (loadState filters non-active users).
        void imManager
          .disconnectAllUserChannels(id)
          .catch(() => undefined);
        logAuthEvent({
          event_type: 'user_deleted',
          username: target.username,
          actor_username: actor.username,
          ip_address: getClientIp(c),
        });
        const deleted = getUserById(id)!;
        return c.json({ success: true, user: toUserPublic(deleted) });
      }

      updates.status = validation.data.status;
      if (validation.data.status === 'disabled') {
        // Revoke all sessions when disabling + clean caches
        invalidateUserSessions(id);
        deleteUserSessionsByUserId(id);
        // Tear down all IM connections — see note above on the 'deleted' branch.
        void imManager
          .disconnectAllUserChannels(id)
          .catch(() => undefined);
        updates.disable_reason =
          validation.data.disable_reason ?? 'disabled_by_admin';
        logAuthEvent({
          event_type: 'user_disabled',
          username: target.username,
          actor_username: actor.username,
          ip_address: getClientIp(c),
        });
      } else if (validation.data.status === 'active') {
        updates.disable_reason = null;
        if (target.status === 'disabled') {
          logAuthEvent({
            event_type: 'user_enabled',
            username: target.username,
            actor_username: actor.username,
            ip_address: getClientIp(c),
          });
        }
        if (target.status === 'deleted') {
          updates.deleted_at = null;
          logAuthEvent({
            event_type: 'user_restored',
            username: target.username,
            actor_username: actor.username,
            ip_address: getClientIp(c),
          });
        }
      }
    }
    if (validation.data.display_name !== undefined)
      updates.display_name = validation.data.display_name;
    if (
      validation.data.disable_reason !== undefined &&
      validation.data.status !== 'disabled'
    ) {
      updates.disable_reason = validation.data.disable_reason;
    }
    const isSelfPasswordReset =
      validation.data.password !== undefined && id === actor.id;
    if (validation.data.password !== undefined) {
      updates.password_hash = await hashPassword(validation.data.password);
      // Only force password change when resetting OTHER user's password
      // Admin resetting their own password should not trigger forced change
      if (id !== actor.id) {
        updates.must_change_password = true;
      }
      invalidateUserSessions(id);
      deleteUserSessionsByUserId(id);
      logAuthEvent({
        event_type: 'password_changed',
        username: target.username,
        actor_username: actor.username,
        ip_address: getClientIp(c),
        details: { admin_reset: true },
      });
      logAuthEvent({
        event_type: 'session_revoked',
        username: target.username,
        actor_username: actor.username,
        ip_address: getClientIp(c),
        details: { action: 'password_reset_revoke_all' },
      });
    }

    if (Object.keys(updates).length > 0) {
      logAuthEvent({
        event_type: 'user_updated',
        username: target.username,
        actor_username: actor.username,
        ip_address: getClientIp(c),
        details: { fields: Object.keys(updates) },
      });
    }

    updateUserFields(id, updates);
    const updated = getUserById(id)!;

    // Symmetric to the disconnect-on-disable/delete above: when a user is
    // re-enabled or restored (was disabled/deleted, now active), bring their
    // IM channels back without a service restart. Fire-and-forget; only
    // enabled channels with valid credentials actually reconnect.
    if (
      validation.data.status === 'active' &&
      (target.status === 'disabled' || target.status === 'deleted')
    ) {
      void getWebDeps()
        ?.reconnectUserIMChannels?.(id)
        .catch(() => undefined);
    }

    // When admin resets their own password, recreate session to avoid logout
    if (isSelfPasswordReset) {
      const now = new Date().toISOString();
      const ip = getClientIp(c);
      const ua = c.req.header('user-agent') || null;
      const newToken = generateSessionToken();
      createUserSession({
        id: newToken,
        user_id: actor.id,
        ip_address: ip,
        user_agent: ua,
        created_at: now,
        expires_at: sessionExpiresAt(),
        last_active_at: now,
      });
      return new Response(
        JSON.stringify({ success: true, user: toUserPublic(updated) }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': setSessionCookie(c, newToken),
          },
        },
      );
    }

    return c.json({ success: true, user: toUserPublic(updated) });
  },
);

// DELETE /api/admin/users/:id - 删除用户
adminRoutes.delete('/users/:id', authMiddleware, usersManageMiddleware, (c) => {
  const id = c.req.param('id');
  const target = getUserById(id);
  if (!target) return c.json({ error: 'User not found' }, 404);

  const actor = c.get('user') as AuthUser;
  if (actor.role !== 'admin' && target.role === 'admin') {
    return c.json(
      { error: 'Forbidden: only admin can delete admin users' },
      403,
    );
  }
  {
    const denial = denyEscalationToTarget(c, actor, target, 'delete');
    if (denial) return denial;
  }
  if (target.id === actor.id) {
    return c.json({ error: 'Cannot delete yourself' }, 400);
  }
  if (
    target.role === 'admin' &&
    target.status === 'active' &&
    getActiveAdminCount() <= 1
  ) {
    return c.json({ error: 'Cannot delete the last active admin' }, 400);
  }

  deleteUser(id);
  // 与 PATCH status='deleted' 路径对齐：清缓存 + 断 IM 连接，否则前端调
  // DELETE 之后 sessionCache 仍是 active 状态、IM bot 持续响应群消息直到重启。
  invalidateUserSessions(id);
  void imManager
    .disconnectAllUserChannels(id)
    .catch(() => undefined);

  // Cleanup avatar files for deleted user
  try {
    const avatarsDir = path.join(DATA_DIR, 'avatars');
    if (fs.existsSync(avatarsDir)) {
      const files = fs
        .readdirSync(avatarsDir)
        .filter((f) => f.startsWith(`${id}-`));
      for (const file of files) {
        fs.unlinkSync(path.join(avatarsDir, file));
      }
    }
  } catch (e) {
    // Avatar cleanup failure should not block user deletion
    logger.warn({ error: e, userId: id }, 'Failed to cleanup avatar files');
  }

  logAuthEvent({
    event_type: 'user_deleted',
    username: target.username,
    actor_username: actor.username,
    ip_address: getClientIp(c),
    details: { action: 'deleted' },
  });

  return c.json({ success: true });
});

// POST /api/admin/users/:id/restore - 恢复已删除用户
adminRoutes.post(
  '/users/:id/restore',
  authMiddleware,
  usersManageMiddleware,
  (c) => {
    const id = c.req.param('id');
    const target = getUserById(id);
    if (!target) return c.json({ error: 'User not found' }, 404);
    const actor = c.get('user') as AuthUser;
    if (actor.role !== 'admin' && target.role === 'admin') {
      return c.json(
        { error: 'Forbidden: only admin can restore admin users' },
        403,
      );
    }
    {
      const denial = denyEscalationToTarget(c, actor, target, 'restore');
      if (denial) return denial;
    }
    if (target.status !== 'deleted')
      return c.json({ error: 'User is not deleted' }, 400);

    restoreUser(id);
    logAuthEvent({
      event_type: 'user_restored',
      username: target.username,
      actor_username: actor.username,
      ip_address: getClientIp(c),
    });
    const restored = getUserById(id)!;
    return c.json({ success: true, user: toUserPublic(restored) });
  },
);

// DELETE /api/admin/users/:id/sessions - 撤销用户所有会话
adminRoutes.delete(
  '/users/:id/sessions',
  authMiddleware,
  usersManageMiddleware,
  (c) => {
    const id = c.req.param('id');
    const target = getUserById(id);
    if (!target) return c.json({ error: 'User not found' }, 404);
    const actor = c.get('user') as AuthUser;
    if (actor.role !== 'admin' && target.role === 'admin') {
      return c.json(
        { error: 'Forbidden: only admin can revoke admin sessions' },
        403,
      );
    }
    {
      const denial = denyEscalationToTarget(c, actor, target, 'revoke sessions for');
      if (denial) return denial;
    }

    invalidateUserSessions(id);
    deleteUserSessionsByUserId(id);
    logAuthEvent({
      event_type: 'session_revoked',
      username: target.username,
      actor_username: actor.username,
      ip_address: getClientIp(c),
      details: { action: 'revoke_all' },
    });

    return c.json({ success: true });
  },
);

// --- Invite Codes ---

// GET /api/admin/invites - 获取邀请码列表
adminRoutes.get('/invites', authMiddleware, inviteManageMiddleware, (c) => {
  return c.json({ invites: getAllInviteCodes() });
});

// POST /api/admin/invites - 创建邀请码
adminRoutes.post(
  '/invites',
  authMiddleware,
  inviteManageMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = InviteCreateSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request', details: validation.error.format() },
        400,
      );
    }

    const actor = c.get('user') as AuthUser;
    const template = resolveTemplate(validation.data.permission_template);
    if (
      template &&
      validation.data.role !== undefined &&
      validation.data.role !== template.role
    ) {
      return c.json({ error: 'role conflicts with permission_template' }, 400);
    }

    const role = template?.role || validation.data.role || 'member';
    const permissions = normalizePermissions(
      validation.data.permissions ??
        template?.permissions ??
        (role === 'admin' ? ALL_PERMISSIONS : []),
    );

    if (actor.role !== 'admin') {
      if (role === 'admin') {
        return c.json(
          { error: 'Forbidden: only admin can create admin invites' },
          403,
        );
      }
      const allowed = new Set(actor.permissions);
      const forbidden = permissions.filter((perm) => !allowed.has(perm));
      if (forbidden.length > 0) {
        return c.json(
          {
            error: `Forbidden: cannot grant permissions [${forbidden.join(', ')}]`,
          },
          403,
        );
      }
    }

    const code = generateInviteCode();
    const now = new Date().toISOString();
    const expiresAt = validation.data.expires_in_hours
      ? new Date(
          Date.now() + validation.data.expires_in_hours * 60 * 60 * 1000,
        ).toISOString()
      : null;

    dbCreateInviteCode({
      code,
      created_by: actor.id,
      role,
      permission_template:
        (validation.data.permission_template as
          | PermissionTemplateKey
          | undefined) ?? null,
      permissions,
      max_uses: validation.data.max_uses ?? 1,
      used_count: 0,
      expires_at: expiresAt,
      created_at: now,
    });

    logAuthEvent({
      event_type: 'invite_created',
      username: actor.username,
      ip_address: getClientIp(c),
      details: {
        code_prefix: code.slice(0, 8),
        role,
        permission_template: validation.data.permission_template || null,
        permissions,
      },
    });

    return c.json({ success: true, code }, 201);
  },
);

// DELETE /api/admin/invites/:code - 删除邀请码
adminRoutes.delete(
  '/invites/:code',
  authMiddleware,
  inviteManageMiddleware,
  (c) => {
    const code = c.req.param('code');
    const invite = getInviteCode(code);
    if (!invite) return c.json({ error: 'Invite not found' }, 404);

    deleteInviteCode(code);
    const actor = c.get('user') as AuthUser;
    logAuthEvent({
      event_type: 'invite_deleted',
      username: actor.username,
      actor_username: actor.username,
      ip_address: getClientIp(c),
      details: { code_prefix: code.slice(0, 8) },
    });
    return c.json({ success: true });
  },
);

// --- Audit Log ---

// GET /api/admin/audit-log - 获取审计日志
adminRoutes.get('/audit-log', authMiddleware, auditViewMiddleware, (c) => {
  const limit = parseInt(c.req.query('limit') || '100', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const event_type = c.req.query('event_type');
  const username = c.req.query('username');
  const actor_username = c.req.query('actor_username');
  const from = c.req.query('from');
  const to = c.req.query('to');

  if (from && !ISO_DATE_RE.test(from)) {
    return c.json(
      { error: 'Invalid "from" date format (expected ISO 8601)' },
      400,
    );
  }
  if (to && !ISO_DATE_RE.test(to)) {
    return c.json(
      { error: 'Invalid "to" date format (expected ISO 8601)' },
      400,
    );
  }

  const result = queryAuthAuditLogs({
    limit: Number.isFinite(limit) ? Math.min(limit, 500) : 100,
    offset: Number.isFinite(offset) ? offset : 0,
    event_type: (event_type || 'all') as AuthEventType | 'all',
    username: username || undefined,
    actor_username: actor_username || undefined,
    from: from || undefined,
    to: to || undefined,
  });
  return c.json(result);
});

// GET /api/admin/audit-log/export - 导出审计日志为 CSV
adminRoutes.get(
  '/audit-log/export',
  authMiddleware,
  auditViewMiddleware,
  (c) => {
    const limit = parseInt(c.req.query('limit') || '2000', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);
    const event_type = c.req.query('event_type');
    const username = c.req.query('username');
    const actor_username = c.req.query('actor_username');
    const from = c.req.query('from');
    const to = c.req.query('to');

    if (from && !ISO_DATE_RE.test(from)) {
      return c.json(
        { error: 'Invalid "from" date format (expected ISO 8601)' },
        400,
      );
    }
    if (to && !ISO_DATE_RE.test(to)) {
      return c.json(
        { error: 'Invalid "to" date format (expected ISO 8601)' },
        400,
      );
    }

    const result = queryAuthAuditLogs({
      limit: Number.isFinite(limit) ? Math.min(limit, 5000) : 2000,
      offset: Number.isFinite(offset) ? offset : 0,
      event_type: (event_type || 'all') as AuthEventType | 'all',
      username: username || undefined,
      actor_username: actor_username || undefined,
      from: from || undefined,
      to: to || undefined,
    });

    const escapeCsv = (value: unknown): string => {
      const text = value === null || value === undefined ? '' : String(value);
      if (text.includes(',') || text.includes('"') || text.includes('\n')) {
        return `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    };

    const rows = [
      [
        'id',
        'event_type',
        'username',
        'actor_username',
        'ip_address',
        'user_agent',
        'created_at',
        'details_json',
      ].join(','),
      ...result.logs.map((log) =>
        [
          log.id,
          log.event_type,
          log.username,
          log.actor_username ?? '',
          log.ip_address ?? '',
          log.user_agent ?? '',
          log.created_at,
          JSON.stringify(log.details ?? {}),
        ]
          .map(escapeCsv)
          .join(','),
      ),
    ];

    return new Response(rows.join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit-log-${Date.now()}.csv"`,
      },
    });
  },
);

export default adminRoutes;
