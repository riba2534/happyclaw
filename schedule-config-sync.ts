#!/usr/bin/env tsx
/**
 * 配置同步定时任务 - 使用 Node-cron 定期执行配置同步
 */

import cron from 'node-cron';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// 配置
const PROJECT_DIR = '/Users/wktt/happyclaw';
const SYNC_SCRIPT_PATH = path.join(PROJECT_DIR, 'config-sync-intelligent.ts');
const LOG_FILE_PATH = path.join(PROJECT_DIR, 'logs', 'config-sync.log');

function log(msg: string, level: 'info' | 'warning' | 'error' | 'success' = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = `[${level.toUpperCase()}]`;
  const logLine = `${timestamp} ${prefix} ${msg}`;

  console.log(logLine);

  // 写入日志文件
  fs.appendFileSync(LOG_FILE_PATH, logLine + '\n');
}

function ensureLogDirectory() {
  const logDir = path.dirname(LOG_FILE_PATH);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

function runSync() {
  log('开始执行配置同步任务', 'info');

  try {
    // 执行同步脚本
    const output = execSync(`cd ${PROJECT_DIR} && npx tsx ${SYNC_SCRIPT_PATH} --verbose`, {
      encoding: 'utf-8'
    });

    log(`同步任务成功完成: ${output.trim()}`, 'success');
  } catch (error: any) {
    log(`同步任务失败: ${error.message}`, 'error');
    if (error.stdout) {
      log(`标准输出: ${error.stdout.trim()}`, 'error');
    }
    if (error.stderr) {
      log(`标准错误: ${error.stderr.trim()}`, 'error');
    }
  }
}

function startScheduler() {
  ensureLogDirectory();

  log('配置同步定时任务启动', 'info');

  // 每天凌晨 2 点执行一次同步
  // 可以根据需要调整 cron 表达式
  const cronExpression = '0 2 * * *';

  const job = cron.schedule(cronExpression, () => {
    log('定时任务触发', 'info');
    runSync();
  });

  log(`定时任务已安排: ${cronExpression}`, 'info');

  // 立即执行一次同步
  log('立即执行首次同步', 'info');
  runSync();

  return job;
}

function showHelp() {
  console.log(`
配置同步定时任务

用法:
  tsx schedule-config-sync.ts [命令]

命令:
  start      启动定时任务（默认）
  run        立即执行一次同步
  help       显示此帮助信息

示例:
  # 启动定时任务（每天凌晨 2 点执行）
  tsx schedule-config-sync.ts start

  # 立即执行一次同步
  tsx schedule-config-sync.ts run
`);
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === 'start') {
    startScheduler();
  } else if (args[0] === 'run') {
    ensureLogDirectory();
    runSync();
  } else if (args[0] === 'help') {
    showHelp();
  } else {
    console.log(`未知命令: ${args[0]}`);
    showHelp();
    process.exit(1);
  }
}

// 直接运行 main()，因为这是 ES 模块
main();

export { startScheduler, runSync };
