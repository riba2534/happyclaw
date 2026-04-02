import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

process.chdir(PROJECT_ROOT);

const [{ CronExpressionParser }, configMod, dbMod] = await Promise.all([
  import('cron-parser'),
  import('../src/config.js'),
  import('../src/db.js'),
]);

const { TIMEZONE, GROUPS_DIR } = configMod;
const {
  createTask,
  getTaskById,
  getUserHomeGroup,
  getRegisteredGroup,
  initDatabase,
  updateTask,
} = dbMod;

const TASK_ID = 'oms-bkboole-review-weekdays-noon';
const ADMIN_ID = 'c7d4a1ac-de4e-4171-980b-6a6c7308f5eb';
const TELEGRAM_JID = 'telegram:7145253799';

function buildScriptCommand(groupFolder: string): string {
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  const scriptPath = path.relative(groupDir, path.join(PROJECT_ROOT, 'scripts', 'oms-bkboole-review.mjs'));
  const configPath = path.relative(
    groupDir,
    path.join(PROJECT_ROOT, 'data', 'config', 'oms-bkboole-review.json'),
  );
  return `node ${JSON.stringify(scriptPath)} --config ${JSON.stringify(configPath)}`;
}

function computeNextRun(cronExpr: string): string {
  return CronExpressionParser.parse(cronExpr, { tz: TIMEZONE })
    .next()
    .toISOString();
}

function resolveTarget() {
  const telegramGroup = getRegisteredGroup(TELEGRAM_JID);
  if (telegramGroup) {
    return {
      groupFolder: telegramGroup.folder,
      chatJid: TELEGRAM_JID,
    };
  }
  const homeGroup = getUserHomeGroup(ADMIN_ID);
  if (!homeGroup) {
    throw new Error('Admin home group not found');
  }
  return {
    groupFolder: homeGroup.folder,
    chatJid: homeGroup.jid,
  };
}

initDatabase();

const cronExpr = '0 12 * * 1-5';
const { groupFolder, chatJid } = resolveTarget();
const scriptCommand = buildScriptCommand(groupFolder);
const nextRun = computeNextRun(cronExpr);
const prompt = '工作日中午自动执行 OMS 科技进展送审';
const existing = getTaskById(TASK_ID);

if (existing) {
  updateTask(TASK_ID, {
    prompt,
    schedule_type: 'cron',
    schedule_value: cronExpr,
    context_mode: 'isolated',
    execution_type: 'script',
    execution_mode: 'host',
    script_command: scriptCommand,
    next_run: nextRun,
    status: 'active',
  });
  console.log(
    JSON.stringify(
      {
        action: 'updated',
        taskId: TASK_ID,
        chatJid,
        groupFolder,
        nextRun,
        cronExpr,
        scriptCommand,
      },
      null,
      2,
    ),
  );
} else {
  createTask({
    id: TASK_ID,
    group_folder: groupFolder,
    chat_jid: chatJid,
    prompt,
    schedule_type: 'cron',
    schedule_value: cronExpr,
    context_mode: 'isolated',
    execution_type: 'script',
    script_command: scriptCommand,
    execution_mode: 'host',
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
    created_by: ADMIN_ID,
    notify_channels: null,
  });
  console.log(
    JSON.stringify(
      {
        action: 'created',
        taskId: TASK_ID,
        chatJid,
        groupFolder,
        nextRun,
        cronExpr,
        scriptCommand,
      },
      null,
      2,
    ),
  );
}
