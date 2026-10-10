import type { Context } from 'hono';

import { logger } from './logger.js';
import { PasswordHashBusyError } from './password-hash-worker.js';

export const PASSWORD_HASH_BUSY_MESSAGE = '服务繁忙，请稍后重试';

/**
 * The bcrypt pool refuses work beyond MAX_PENDING_HASH_TASKS. Such a request
 * did nothing yet, so it is safe to retry: answer 503 with Retry-After.
 */
export function passwordHashBusyResponse(c: Context): Response {
  c.header('Retry-After', '1');
  return c.json({ error: PASSWORD_HASH_BUSY_MESSAGE }, 503);
}

/**
 * Route-level error handler for every route that hashes or compares a
 * password (setup, register, change password, admin user create/update).
 * Other errors get Hono's default treatment, so mounting this changes
 * nothing else.
 */
export function onPasswordHashBusy(err: Error, c: Context): Response {
  if (err instanceof PasswordHashBusyError) return passwordHashBusyResponse(c);
  if ('getResponse' in err && typeof err.getResponse === 'function') {
    const res = err.getResponse() as Response;
    return c.newResponse(res.body, res);
  }
  logger.error({ err, path: c.req.path }, 'Unhandled route error');
  return c.text('Internal Server Error', 500);
}
