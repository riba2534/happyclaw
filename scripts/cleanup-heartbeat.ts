/**
 * 一次性清理脚本：删除 HEARTBEAT.md 退场遗留物。
 *
 * 删除范围：
 *   - data/groups/user-global/{userId}/HEARTBEAT.md
 *   - data/groups/user-global/{userId}/daily-summary/
 *
 * 用法：bun scripts/cleanup-heartbeat.ts
 *      或 npx tsx scripts/cleanup-heartbeat.ts
 *
 * 幂等：再跑一次什么都不发生（文件不存在就跳过）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const USER_GLOBAL_DIR = path.join(PROJECT_ROOT, 'data', 'groups', 'user-global');

function main(): void {
  if (!fs.existsSync(USER_GLOBAL_DIR)) {
    console.log(`No user-global directory at ${USER_GLOBAL_DIR}, nothing to clean.`);
    return;
  }

  const userIds = fs.readdirSync(USER_GLOBAL_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  let removedFiles = 0;
  let removedDirs = 0;

  for (const userId of userIds) {
    const heartbeatPath = path.join(USER_GLOBAL_DIR, userId, 'HEARTBEAT.md');
    if (fs.existsSync(heartbeatPath)) {
      fs.unlinkSync(heartbeatPath);
      removedFiles++;
      console.log(`Removed ${heartbeatPath}`);
    }

    const dailySummaryDir = path.join(USER_GLOBAL_DIR, userId, 'daily-summary');
    if (fs.existsSync(dailySummaryDir)) {
      fs.rmSync(dailySummaryDir, { recursive: true, force: true });
      removedDirs++;
      console.log(`Removed ${dailySummaryDir}`);
    }
  }

  console.log(`\nDone: ${removedFiles} HEARTBEAT.md file(s), ${removedDirs} daily-summary dir(s) removed.`);
}

main();
