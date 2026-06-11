import { generateUserId, hashPassword } from './auth.js';
import {
  initDatabase,
  getUserByUsername,
  createUser,
  updateUserFields,
  deleteUserSessionsByUserId,
} from './db.js';

async function main(): Promise<void> {
  initDatabase();

  // 与 routes/auth.ts / routes/admin.ts 一致：username 小写存储，避免
  // mixed-case 创建出登录路径永远查不到的孤儿行（login 走 toLowerCase 后
  // 命中不到原 mixed-case 行）。
  const username = (process.argv[2] || 'admin').trim().toLowerCase();
  const nextPassword = process.argv[3];
  if (!nextPassword || nextPassword.trim().length < 8) {
    console.error('Usage: npm run reset:admin -- <username> <new_password>');
    console.error('new_password must be at least 8 characters');
    process.exit(1);
  }

  const now = new Date().toISOString();
  const passwordHash = await hashPassword(nextPassword);
  const existing = getUserByUsername(username);
  if (existing) {
    updateUserFields(existing.id, {
      role: 'admin',
      status: 'active',
      password_hash: passwordHash,
      must_change_password: false,
      disable_reason: null,
      deleted_at: null,
    });
    deleteUserSessionsByUserId(existing.id);
    console.log(`[OK] Reset admin account: ${username}`);
    return;
  }

  createUser({
    id: generateUserId(),
    username,
    password_hash: passwordHash,
    display_name: username,
    role: 'admin',
    status: 'active',
    must_change_password: false,
    created_at: now,
    updated_at: now,
    notes: 'Created by reset-admin script',
  });
  console.log(`[OK] Created admin account: ${username}`);
}

void main();
