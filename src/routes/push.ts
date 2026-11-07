/**
 * /api/push — Web Push subscriptions of the signed-in account.
 *
 * Every route works on the caller's own subscriptions only. Guests have no
 * push (the guest guard denies the whole prefix, and each handler checks the
 * role as well). A subscription's endpoint must belong to a known push
 * service: the server posts to it, so it is never an arbitrary URL.
 */
import { Hono } from 'hono';
import { z } from 'zod';

import { authMiddleware } from '../middleware/auth.js';
import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import {
  deleteWebPushSubscription,
  listWebPushSubscriptions,
  upsertWebPushSubscription,
} from '../web-push-store.js';
import {
  PUSH_ENDPOINT_MAX_LENGTH,
  deliverToUser,
  endpointId,
  getVapidPublicKey,
  isAllowedPushEndpoint,
  normalizePushEndpoint,
  type WebPushPayload,
} from '../web-push.js';

/** Subscriptions kept per account; registering more drops the oldest. */
export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 20;

const base64Url = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_\-+/=]+$/);

export const PushSubscribeSchema = z.object({
  endpoint: z
    .string()
    .max(PUSH_ENDPOINT_MAX_LENGTH)
    .refine(isAllowedPushEndpoint, 'Unsupported push service endpoint'),
  keys: z.object({ p256dh: base64Url, auth: base64Url }),
});

export const PushUnsubscribeSchema = z.object({
  endpoint: z.string().min(1).max(PUSH_ENDPOINT_MAX_LENGTH),
});

const pushRoutes = new Hono<{ Variables: Variables }>();

pushRoutes.use('*', authMiddleware);
pushRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  if ((c.get('user') as AuthUser).role === 'guest') {
    return c.json(
      { error: 'Web Push is not available to guest accounts' },
      403,
    );
  }
  await next();
});

/** The VAPID public key a browser subscribes with. */
pushRoutes.get('/vapid-public-key', (c) => {
  const publicKey = getVapidPublicKey();
  if (!publicKey) return c.json({ error: 'Web Push is unavailable' }, 503);
  return c.json({ publicKey });
});

/** Whether push is available, and which devices of the account receive it. */
pushRoutes.get('/status', (c) => {
  const user = c.get('user') as AuthUser;
  const subscriptions = listWebPushSubscriptions(user.id).map((row) => ({
    id: endpointId(row.endpoint),
    user_agent: row.user_agent,
    created_at: row.created_at,
    last_success_at: row.last_success_at,
  }));
  return c.json({
    available: getVapidPublicKey() !== null,
    subscription_count: subscriptions.length,
    subscriptions,
  });
});

/** Register (or refresh) this browser's subscription. Idempotent. */
pushRoutes.post('/subscribe', async (c) => {
  const user = c.get('user') as AuthUser;
  if (!getVapidPublicKey()) {
    return c.json({ error: 'Web Push is unavailable' }, 503);
  }
  const body = await c.req.json().catch(() => null);
  const parsed = PushSubscribeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid push subscription', details: parsed.error.issues },
      400,
    );
  }
  const endpoint = normalizePushEndpoint(parsed.data.endpoint)!;
  const userAgent = c.req.header('user-agent')?.slice(0, 256) ?? null;
  upsertWebPushSubscription({
    endpoint,
    userId: user.id,
    p256dh: parsed.data.keys.p256dh,
    auth: parsed.data.keys.auth,
    userAgent,
  });
  // Keep the newest; the account never accumulates dead devices without bound.
  const own = listWebPushSubscriptions(user.id);
  for (const row of own.slice(
    0,
    Math.max(0, own.length - MAX_PUSH_SUBSCRIPTIONS_PER_USER),
  )) {
    deleteWebPushSubscription(row.endpoint, user.id);
  }
  return c.json({ success: true });
});

/** Remove this browser's subscription. Idempotent. */
pushRoutes.post('/unsubscribe', async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => null);
  const parsed = PushUnsubscribeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);
  deleteWebPushSubscription(
    normalizePushEndpoint(parsed.data.endpoint) ?? parsed.data.endpoint,
    user.id,
  );
  return c.json({ success: true });
});

/** Send a test notification to every device of the account. */
pushRoutes.post('/test', async (c) => {
  const user = c.get('user') as AuthUser;
  const payload: WebPushPayload = {
    title: 'HappyClaw',
    body: '推送通知已开启',
    tag: 'test',
    path: '/settings',
    kind: 'test',
  };
  const summary = await deliverToUser(user.id, payload);
  return c.json({ success: summary.delivered > 0, ...summary });
});

export default pushRoutes;
