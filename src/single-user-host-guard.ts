/**
 * Single-user host mode keeps exactly one active account. The routes that
 * would add one (create, invite, reactivate, promote, guests) refuse with
 * the 409 below; reading, disabling and deleting stay open so an install can
 * get down to one user before switching.
 */
import type { Context } from 'hono';

import { listUsers } from './db.js';
import type { UserRole } from './types.js';

export const SINGLE_USER_HOST_CODE = 'SINGLE_USER_HOST';

export function singleUserHostRefusal(
  c: Context,
  error = '单人宿主机模式只允许一个用户。',
) {
  return c.json({ error, code: SINGLE_USER_HOST_CODE }, 409);
}

export interface OtherActiveUser {
  id: string;
  username: string;
  role: UserRole;
}

/** Every active account except `userId`, guests included. */
export function listOtherActiveUsers(userId: string): OtherActiveUser[] {
  const others: OtherActiveUser[] = [];
  for (let page = 1; ; page++) {
    const result = listUsers({ status: 'active', page, pageSize: 200 });
    for (const user of result.users) {
      if (user.id !== userId) {
        others.push({ id: user.id, username: user.username, role: user.role });
      }
    }
    if (page * result.pageSize >= result.total) return others;
  }
}
