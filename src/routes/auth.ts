// Authentication routes

import fs from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { getClientIp } from '../utils.js';
import { DATA_DIR } from '../config.js';
import {
  LoginSchema,
  RegisterSchema,
  ProfileUpdateSchema,
  ChangePasswordSchema,
} from '../schemas.js';
import {
  getUserByUsername,
  getUserById,
  createInitialAdminUser,
  createUserSession,
  deleteUserSession,
  deleteUserSessionsByUserId,
  updateUserFields,
  getUserSessions,
  getUserCount,
  registerUserWithInvite,
  registerUserWithoutInvite,
  logAuthEvent,
  ensureUserHomeGroup,
} from '../db.js';
import {
  getRegistrationConfig,
  getClaudeProviderConfig,
  getFeishuProviderConfigWithSource,
  getAppearanceConfig,
} from '../runtime-config.js';
import {
  verifyPassword,
  hashPassword,
  generateSessionToken,
  sessionExpiresAt,
  checkLoginRateLimit,
  recordLoginAttempt,
  clearLoginAttempts,
  validateUsername,
  validatePassword,
  generateUserId,
} from '../auth.js';
import type { AuthUser, User, UserPublic } from '../types.js';
import { logger } from '../logger.js';
import { lastActiveCache } from '../web-context.js';
import { MAX_LOGIN_ATTEMPTS, LOGIN_LOCKOUT_MINUTES, SESSION_COOKIE_NAME } from '../config.js';
import { IS_PRODUCTION } from '../environment.js';

const authRoutes = new Hono<{ Variables: Variables }>();

// --- Helper Functions ---

export function setSessionCookie(token: string): string {
  const secure = IS_PRODUCTION ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 60 * 60}${secure}`;
}

export function clearSessionCookie(): string {
  const secure = IS_PRODUCTION ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
}

export function isUsernameConflictError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes('UNIQUE constraint failed: users.username')
  );
}

export function toUserPublic(u: User): UserPublic {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    status: u.status,
    permissions: u.permissions,
    must_change_password: u.must_change_password,
    disable_reason: u.disable_reason,
    notes: u.notes,
    avatar_emoji: u.avatar_emoji ?? null,
    avatar_color: u.avatar_color ?? null,
    ai_name: u.ai_name ?? null,
    ai_avatar_emoji: u.ai_avatar_emoji ?? null,
    ai_avatar_color: u.ai_avatar_color ?? null,
    ai_avatar_url: u.ai_avatar_url ?? null,
    created_at: u.created_at,
    last_login_at: u.last_login_at,
    last_active_at: null,
    deleted_at: u.deleted_at,
  };
}

function buildSetupStatus() {
  const claudeConfig = getClaudeProviderConfig();
  const officialConfigured =
    !!claudeConfig.claudeCodeOauthToken?.trim() || !!claudeConfig.claudeOAuthCredentials;
  const thirdPartyConfigured = !!(
    claudeConfig.anthropicBaseUrl?.trim() && claudeConfig.anthropicAuthToken?.trim()
  );
  const claudeConfigured = officialConfigured || thirdPartyConfigured;
  const { source: feishuSource } = getFeishuProviderConfigWithSource();
  const feishuConfigured = feishuSource !== 'none';

  return {
    needsSetup: !claudeConfigured,
    claudeConfigured,
    feishuConfigured,
  };
}

// --- Routes ---

// Public: check if system is initialized (any user exists)
authRoutes.get('/status', (c) => {
  const initialized = getUserCount(true) > 0;
  return c.json({ initialized });
});

// Public: initial admin setup (only when no users exist)
authRoutes.post('/setup', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { username, password } = body as { username?: string; password?: string };

  if (!username || !password) {
    return c.json({ error: 'Username and password are required' }, 400);
  }

  const usernameError = validateUsername(username);
  if (usernameError) return c.json({ error: usernameError }, 400);

  const passwordError = validatePassword(password);
  if (passwordError) return c.json({ error: passwordError }, 400);

  const now = new Date().toISOString();
  const userId = generateUserId();
  const passwordHash = await hashPassword(password);
  const ip = getClientIp(c);
  const ua = c.req.header('user-agent') || null;

  const createResult = createInitialAdminUser({
    id: userId,
    username,
    password_hash: passwordHash,
    display_name: username,
    role: 'admin',
    status: 'active',
    must_change_password: false,
    notes: 'Initial admin (setup wizard)',
    created_at: now,
    updated_at: now,
  });
  if (!createResult.ok) {
    if (createResult.reason === 'already_initialized') {
      return c.json({ error: 'System already initialized' }, 403);
    }
    return c.json({ error: 'Username already taken' }, 400);
  }

  logAuthEvent({
    event_type: 'user_created',
    username,
    actor_username: 'system',
    ip_address: ip,
    user_agent: ua,
    details: { source: 'setup_wizard', role: 'admin' },
  });

  // Create admin home group (web:main, folder=main, host mode)
  try {
    ensureUserHomeGroup(userId, 'admin', username);
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to create admin home group during setup');
  }

  // Auto-login
  const token = generateSessionToken();
  createUserSession({
    id: token,
    user_id: userId,
    ip_address: ip,
    user_agent: ua,
    created_at: now,
    expires_at: sessionExpiresAt(),
    last_active_at: now,
  });

  const newUser = getUserById(userId)!;

  return new Response(
    JSON.stringify({
      success: true,
      user: toUserPublic(newUser),
      setupStatus: buildSetupStatus(),
    }),
    {
      status: 201,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': setSessionCookie(token),
      },
    },
  );
});

authRoutes.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = LoginSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const { username, password } = validation.data;
  const ip = getClientIp(c);
  const ua = c.req.header('user-agent') || null;

  // Rate limiting
  const rateCheck = checkLoginRateLimit(
    username,
    ip,
    MAX_LOGIN_ATTEMPTS,
    LOGIN_LOCKOUT_MINUTES,
  );
  if (!rateCheck.allowed) {
    logAuthEvent({
      event_type: 'login_failed',
      username,
      ip_address: ip,
      user_agent: ua,
      details: { reason: 'rate_limited' },
    });
    return c.json(
      {
        error: `Too many login attempts. Try again in ${rateCheck.retryAfterSeconds}s`,
      },
      429,
    );
  }

  const user = getUserByUsername(username);

  // Constant-time: always run bcrypt compare even if user doesn't exist (prevents timing attacks)
  // 使用运行时生成的合法 bcrypt hash，确保 bcrypt.compare 不会抛异常
  const DUMMY_HASH = '$2b$12$GBXvNon/zJbUI4jtleGnP.YX03zXP5eSXjppo7a3vyWEUK/2YwdP.';
  let passwordMatch: boolean;
  try {
    passwordMatch = await verifyPassword(
      password,
      user ? user.password_hash : DUMMY_HASH,
    );
  } catch {
    // 如果 hash 格式异常，视为不匹配，不泄漏内部错误
    passwordMatch = false;
  }

  if (!user || user.status !== 'active' || !passwordMatch) {
    recordLoginAttempt(username, ip);
    logAuthEvent({
      event_type: 'login_failed',
      username,
      ip_address: ip,
      user_agent: ua,
      details: {
        reason: !user
          ? 'user_not_found'
          : user.status !== 'active'
            ? 'account_inactive'
            : 'wrong_password',
      },
    });
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  // Success — create session
  const token = generateSessionToken();
  const now = new Date().toISOString();
  createUserSession({
    id: token,
    user_id: user.id,
    ip_address: ip,
    user_agent: ua,
    created_at: now,
    expires_at: sessionExpiresAt(),
    last_active_at: now,
  });

  clearLoginAttempts(username, ip);
  updateUserFields(user.id, { last_login_at: now });

  // Ensure user has a home group (backfill for existing users)
  try {
    ensureUserHomeGroup(user.id, user.role, user.username);
  } catch (err) {
    // Don't block login if home group creation fails
    logger.warn({ err, userId: user.id }, 'Failed to ensure home group during login');
  }

  logAuthEvent({
    event_type: 'login_success',
    username,
    ip_address: ip,
    user_agent: ua,
  });
  const updatedUser = getUserById(user.id) ?? user;
  const setupStatus =
    updatedUser.role === 'admin' ? buildSetupStatus() : undefined;

  return new Response(
    JSON.stringify({ success: true, user: toUserPublic(updatedUser), setupStatus }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': setSessionCookie(token),
      },
    },
  );
});

authRoutes.get('/register/status', (c) => {
  // Before initial admin setup, force users through /setup first.
  if (getUserCount(true) === 0) {
    return c.json({
      allowRegistration: false,
      requireInviteCode: true,
    });
  }

  const config = getRegistrationConfig();
  return c.json({
    allowRegistration: config.allowRegistration,
    requireInviteCode: config.requireInviteCode,
  });
});

authRoutes.post('/register', async (c) => {
  if (getUserCount(true) === 0) {
    return c.json({ error: '系统尚未初始化，请先完成管理员设置。' }, 403);
  }

  // Check registration switch
  const regConfig = getRegistrationConfig();
  if (!regConfig.allowRegistration) {
    return c.json({ error: '注册功能已关闭' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const validation = RegisterSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request', details: validation.error.format() },
      400,
    );
  }

  const { username, password, display_name, invite_code } = validation.data;

  // If invite code is required but not provided, reject
  if (regConfig.requireInviteCode && !invite_code) {
    return c.json({ error: '需要提供邀请码' }, 400);
  }

  const ip = getClientIp(c);
  const ua = c.req.header('user-agent') || null;

  // IP-based rate limiting for register endpoint
  const rateCheck = checkLoginRateLimit(
    `register:${ip}`,
    ip,
    MAX_LOGIN_ATTEMPTS,
    LOGIN_LOCKOUT_MINUTES,
  );
  if (!rateCheck.allowed) {
    return c.json(
      {
        error: `Too many registration attempts. Try again in ${rateCheck.retryAfterSeconds}s`,
      },
      429,
    );
  }

  // Validate username format
  const usernameError = validateUsername(username);
  if (usernameError) return c.json({ error: usernameError }, 400);

  const passwordError = validatePassword(password);
  if (passwordError) return c.json({ error: passwordError }, 400);

  const now = new Date().toISOString();
  const userId = generateUserId();
  const passwordHash = await hashPassword(password);

  // Branch: with invite code or without
  const withInvite = !!invite_code;
  const result = withInvite
    ? registerUserWithInvite({
        id: userId,
        username,
        password_hash: passwordHash,
        display_name: display_name || username,
        invite_code: invite_code!,
        created_at: now,
        updated_at: now,
      })
    : registerUserWithoutInvite({
        id: userId,
        username,
        password_hash: passwordHash,
        display_name: display_name || username,
        created_at: now,
        updated_at: now,
      });

  if (!result.ok) {
    recordLoginAttempt(`register:${ip}`, ip);
    if (result.reason === 'username_taken') {
      return c.json(
        { error: 'Registration failed. Username may already be taken.' },
        400,
      );
    }
    return c.json({ error: 'Invalid or expired invite code' }, 400);
  }

  if (withInvite) {
    logAuthEvent({
      event_type: 'invite_used',
      username,
      ip_address: ip,
      user_agent: ua,
      details: { invite_code: invite_code!.slice(0, 8) + '...' },
    });
  }
  logAuthEvent({
    event_type: 'register_success',
    username,
    ip_address: ip,
    user_agent: ua,
    details: { role: result.role, with_invite: withInvite },
  });

  // Create home group for new user
  try {
    ensureUserHomeGroup(userId, result.role, username);
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to create home group during registration');
  }

  // Auto-login
  const token = generateSessionToken();
  createUserSession({
    id: token,
    user_id: userId,
    ip_address: ip,
    user_agent: ua,
    created_at: now,
    expires_at: sessionExpiresAt(),
    last_active_at: now,
  });

  const newUser = getUserById(userId)!;
  return new Response(
    JSON.stringify({ success: true, user: toUserPublic(newUser) }),
    {
      status: 201,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': setSessionCookie(token),
      },
    },
  );
});

authRoutes.post('/logout', authMiddleware, (c) => {
  const sessionId = c.get('sessionId');
  deleteUserSession(sessionId);
  lastActiveCache.delete(sessionId);
  const user = c.get('user') as AuthUser;
  logAuthEvent({
    event_type: 'logout',
    username: user.username,
    ip_address: getClientIp(c),
  });

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearSessionCookie(),
    },
  });
});

authRoutes.get('/me', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const fullUser = getUserById(authUser.id);
  if (!fullUser) return c.json({ error: 'User not found' }, 404);

  const userPublic = toUserPublic(fullUser);
  const appearance = getAppearanceConfig();

  // Admin users get setup status for the onboarding wizard
  if (fullUser.role === 'admin') {
    return c.json({
      user: userPublic,
      appearance,
      setupStatus: buildSetupStatus(),
    });
  }

  return c.json({ user: userPublic, appearance });
});

authRoutes.put('/profile', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = ProfileUpdateSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request', details: validation.error.format() },
      400,
    );
  }

  const user = c.get('user') as AuthUser;
  const fullUser = getUserById(user.id);
  if (!fullUser) return c.json({ error: 'User not found' }, 404);

  const updates: Parameters<typeof updateUserFields>[1] = {};
  if (validation.data.username !== undefined) {
    const usernameError = validateUsername(validation.data.username);
    if (usernameError) return c.json({ error: usernameError }, 400);
    if (validation.data.username !== fullUser.username) {
      const existed = getUserByUsername(validation.data.username);
      if (existed && existed.id !== fullUser.id) {
        return c.json({ error: 'Username already taken' }, 409);
      }
    }
    updates.username = validation.data.username;
  }
  if (validation.data.display_name !== undefined) {
    updates.display_name = validation.data.display_name;
  }
  if (validation.data.avatar_emoji !== undefined) {
    updates.avatar_emoji = validation.data.avatar_emoji;
  }
  if (validation.data.avatar_color !== undefined) {
    updates.avatar_color = validation.data.avatar_color;
  }
  if (validation.data.ai_name !== undefined) {
    updates.ai_name = validation.data.ai_name;
  }
  if (validation.data.ai_avatar_emoji !== undefined) {
    updates.ai_avatar_emoji = validation.data.ai_avatar_emoji;
  }
  if (validation.data.ai_avatar_color !== undefined) {
    updates.ai_avatar_color = validation.data.ai_avatar_color;
  }
  if (validation.data.ai_avatar_url !== undefined) {
    updates.ai_avatar_url = validation.data.ai_avatar_url;
  }
  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  try {
    updateUserFields(user.id, updates);
  } catch (err) {
    if (isUsernameConflictError(err)) {
      return c.json({ error: 'Username already taken' }, 409);
    }
    throw err;
  }
  const updated = getUserById(user.id)!;
  logAuthEvent({
    event_type: 'profile_updated',
    username: updated.username,
    actor_username: fullUser.username,
    ip_address: getClientIp(c),
    details: { fields: Object.keys(updates) },
  });
  return c.json({ success: true, user: toUserPublic(updated) });
});

authRoutes.put('/password', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = ChangePasswordSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request', details: validation.error.format() },
      400,
    );
  }

  const user = c.get('user') as AuthUser;
  const fullUser = getUserById(user.id);
  if (!fullUser) return c.json({ error: 'User not found' }, 404);

  const match = await verifyPassword(
    validation.data.current_password,
    fullUser.password_hash,
  );
  if (!match) return c.json({ error: 'Current password is incorrect' }, 401);
  if (validation.data.current_password === validation.data.new_password) {
    return c.json(
      { error: 'New password must be different from current password' },
      400,
    );
  }

  const passwordError = validatePassword(validation.data.new_password);
  if (passwordError) return c.json({ error: passwordError }, 400);

  const newHash = await hashPassword(validation.data.new_password);
  updateUserFields(user.id, {
    password_hash: newHash,
    must_change_password: false,
  });

  // Revoke all existing sessions for this user
  deleteUserSessionsByUserId(user.id);

  // Create a fresh session for the current request
  const now = new Date().toISOString();
  const ip = getClientIp(c);
  const ua = c.req.header('user-agent') || null;
  const newToken = generateSessionToken();
  createUserSession({
    id: newToken,
    user_id: user.id,
    ip_address: ip,
    user_agent: ua,
    created_at: now,
    expires_at: sessionExpiresAt(),
    last_active_at: now,
  });

  logAuthEvent({
    event_type: 'password_changed',
    username: user.username,
    ip_address: ip,
    details: { cleared_force_change: true, sessions_revoked: true },
  });

  const updated = getUserById(user.id)!;
  return new Response(
    JSON.stringify({ success: true, user: toUserPublic(updated) }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': setSessionCookie(newToken),
      },
    },
  );
});

authRoutes.get('/sessions', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const currentSessionId = c.get('sessionId');
  const sessions = getUserSessions(user.id);
  return c.json({
    sessions: sessions.map((s) => ({
      shortId: s.id.slice(0, 8),
      ip_address: s.ip_address,
      user_agent: s.user_agent,
      created_at: s.created_at,
      last_active_at: s.last_active_at,
      is_current: s.id === currentSessionId,
    })),
  });
});

authRoutes.delete('/sessions/:id', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const targetId = c.req.param('id');
  const sessions = getUserSessions(user.id);
  // Support both full token and shortId (first 8 chars) for lookup
  const target = sessions.find(
    (s) => s.id === targetId || s.id.slice(0, 8) === targetId,
  );
  if (!target) return c.json({ error: 'Session not found' }, 404);

  deleteUserSession(target.id);
  lastActiveCache.delete(target.id);
  logAuthEvent({
    event_type: 'session_revoked',
    username: user.username,
    ip_address: getClientIp(c),
  });
  return c.json({ success: true });
});

// --- Avatar Upload ---

const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const ALLOWED_AVATAR_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2MB

authRoutes.post('/avatar', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const contentType = c.req.header('content-type') || '';

  if (!contentType.includes('multipart/form-data')) {
    return c.json({ error: 'Expected multipart/form-data' }, 400);
  }

  const formData = await c.req.formData();
  const file = formData.get('avatar');
  if (!file || !(file instanceof File)) {
    return c.json({ error: 'No avatar file provided' }, 400);
  }

  if (file.size > MAX_AVATAR_SIZE) {
    return c.json({ error: 'File too large (max 2MB)' }, 400);
  }

  const ext = ALLOWED_AVATAR_TYPES[file.type];
  if (!ext) {
    return c.json({ error: 'Unsupported image type. Use jpg, png, gif or webp' }, 400);
  }

  fs.mkdirSync(AVATARS_DIR, { recursive: true });

  // Delete old avatar files for this user
  try {
    const existing = fs.readdirSync(AVATARS_DIR).filter(f => f.startsWith(`${user.id}-`));
    for (const f of existing) {
      fs.unlinkSync(path.join(AVATARS_DIR, f));
    }
  } catch { /* ignore */ }

  const filename = `${user.id}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  const filePath = path.join(AVATARS_DIR, filename);
  const buffer = Buffer.from(await file.arrayBuffer());
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, buffer);
  fs.renameSync(tmpPath, filePath);

  const avatarUrl = `/api/auth/avatars/${filename}`;

  // Update user profile with new avatar URL
  updateUserFields(user.id, { ai_avatar_url: avatarUrl });

  const updated = getUserById(user.id)!;
  return c.json({ success: true, avatarUrl, user: toUserPublic(updated) });
});

// Serve avatar files (public, no auth required)
authRoutes.get('/avatars/:filename', async (c) => {
  const filename = c.req.param('filename');

  // Security: only allow simple filenames (no path traversal)
  if (!filename || /[/\\]/.test(filename) || filename.includes('..')) {
    return c.json({ error: 'Invalid filename' }, 400);
  }

  const filePath = path.join(AVATARS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return c.json({ error: 'Avatar not found' }, 404);
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  const data = await readFile(filePath);

  return new Response(data, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
});

export default authRoutes;
