#!/usr/bin/env tsx
/**
 * 配置同步脚本 - 定期同步用户级别 ~/.claude 配置到项目内部
 * 支持: CLAUDE.md、skills、plugins
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// 配置
const USER_CLAUDE_DIR = '/Users/wktt/.claude';
const PROJECT_DIR = '/Users/wktt/happyclaw';
const PROJECT_CONFIG_DIR = path.join(PROJECT_DIR, 'config');
const PROJECT_SKILLS_DIR = path.join(PROJECT_DIR, 'container', 'skills');

interface SyncConfig {
  claudeMd: boolean;
  skills: boolean;
  plugins: boolean;
  dryRun: boolean;
  verbose: boolean;
}

const DEFAULT_CONFIG: SyncConfig = {
  claudeMd: true,
  skills: true,
  plugins: true,
  dryRun: false,
  verbose: true,
};

function log(msg: string, level: 'info' | 'warning' | 'error' | 'success' = 'info') {
  const timestamp = new Date().toISOString().slice(0, -5);
  let prefix = '';
  let color = '';

  switch (level) {
    case 'info':
      prefix = '[INFO]';
      color = '\x1b[36m'; // cyan
      break;
    case 'warning':
      prefix = '[WARN]';
      color = '\x1b[33m'; // yellow
      break;
    case 'error':
      prefix = '[ERROR]';
      color = '\x1b[31m'; // red
      break;
    case 'success':
      prefix = '[OK]';
      color = '\x1b[32m'; // green
      break;
  }

  console.log(`${color}${timestamp} ${prefix} ${msg}\x1b[0m`);
}

function createDirectory(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyFile(src: string, dest: string, dryRun: boolean, verbose: boolean) {
  if (!fs.existsSync(src)) {
    log(`源文件不存在: ${src}`, 'warning');
    return;
  }

  createDirectory(path.dirname(dest));

  if (dryRun) {
    log(`[DRY] 复制: ${src} → ${dest}`, 'info');
  } else {
    fs.copyFileSync(src, dest);
    if (verbose) {
      log(`复制: ${src} → ${dest}`, 'success');
    }
  }
}

function copyDirectory(src: string, dest: string, dryRun: boolean, verbose: boolean) {
  if (!fs.existsSync(src)) {
    log(`源目录不存在: ${src}`, 'warning');
    return;
  }

  createDirectory(dest);

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      // 跳过某些目录
      if (['.git', 'node_modules', 'cache', 'debug'].includes(entry.name)) {
        if (verbose) {
          log(`跳过目录: ${srcPath}`, 'info');
        }
        continue;
      }

      copyDirectory(srcPath, destPath, dryRun, verbose);
    } else {
      // 跳过某些文件
      if (['.claude.json', 'settings.json', 'history.jsonl'].includes(entry.name)) {
        if (verbose) {
          log(`跳过文件: ${srcPath}`, 'info');
        }
        continue;
      }

      copyFile(srcPath, destPath, dryRun, verbose);
    }
  }
}

function syncClaudeMd(config: SyncConfig) {
  log('=== 同步 CLAUDE.md ===', 'info');

  const src = path.join(USER_CLAUDE_DIR, 'CLAUDE.md');
  const dest = path.join(PROJECT_CONFIG_DIR, 'user-claude-md.sync.md');

  if (config.claudeMd) {
    copyFile(src, dest, config.dryRun, config.verbose);
  } else {
    log('CLAUDE.md 同步已禁用', 'warning');
  }
}

function syncSkills(config: SyncConfig) {
  log('=== 同步 Skills ===', 'info');

  const src = path.join(USER_CLAUDE_DIR, 'skills');
  const dest = path.join(PROJECT_SKILLS_DIR, 'user-skills-sync');

  if (config.skills) {
    copyDirectory(src, dest, config.dryRun, config.verbose);
  } else {
    log('Skills 同步已禁用', 'warning');
  }
}

function syncPlugins(config: SyncConfig) {
  log('=== 同步 Plugins ===', 'info');

  const src = path.join(USER_CLAUDE_DIR, 'plugins');
  const dest = path.join(PROJECT_DIR, 'container', 'plugins-sync');

  if (config.plugins) {
    copyDirectory(src, dest, config.dryRun, config.verbose);
  } else {
    log('Plugins 同步已禁用', 'warning');
  }
}

function verifyDirectories() {
  const dirs = [
    USER_CLAUDE_DIR,
    PROJECT_CONFIG_DIR,
    PROJECT_SKILLS_DIR,
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      throw new Error(`目录不存在: ${dir}`);
    }
  }
}

function showStats() {
  console.log('\n=== 同步统计 ===');

  const userClaudeStats = {
    claudeMd: fs.existsSync(path.join(USER_CLAUDE_DIR, 'CLAUDE.md')),
    skills: fs.existsSync(path.join(USER_CLAUDE_DIR, 'skills')),
    plugins: fs.existsSync(path.join(USER_CLAUDE_DIR, 'plugins')),
  };

  const projectStats = {
    configDir: fs.existsSync(PROJECT_CONFIG_DIR),
    skillsDir: fs.existsSync(PROJECT_SKILLS_DIR),
  };

  console.log(`用户 CLAUDE.md: ${userClaudeStats.claudeMd ? '✅' : '❌'}`);
  console.log(`用户 Skills: ${userClaudeStats.skills ? '✅' : '❌'}`);
  console.log(`用户 Plugins: ${userClaudeStats.plugins ? '✅' : '❌'}`);
  console.log(`项目配置目录: ${projectStats.configDir ? '✅' : '❌'}`);
  console.log(`项目 Skills 目录: ${projectStats.skillsDir ? '✅' : '❌'}`);
}

function parseArgs(): SyncConfig {
  const config = { ...DEFAULT_CONFIG };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];

    switch (arg) {
      case '--no-claude-md':
      case '--no-claude-md':
        config.claudeMd = false;
        break;
      case '--no-skills':
        config.skills = false;
        break;
      case '--no-plugins':
        config.plugins = false;
        break;
      case '--dry-run':
      case '-d':
        config.dryRun = true;
        break;
      case '--verbose':
      case '-v':
        config.verbose = true;
        break;
      case '--quiet':
      case '-q':
        config.verbose = false;
        break;
      case '--help':
      case '-h':
        showHelp();
        process.exit(0);
      default:
        log(`未知参数: ${arg}`, 'error');
        showHelp();
        process.exit(1);
    }
  }

  return config;
}

function showHelp() {
  console.log(`
配置同步脚本 - 定期同步用户级别 ~/.claude 配置到项目内部

用法:
  tsx config-sync.ts [选项]

选项:
  --no-claude-md    禁用 CLAUDE.md 同步
  --no-skills       禁用 Skills 同步
  --no-plugins      禁用 Plugins 同步
  --dry-run, -d     模拟同步，不实际执行
  --verbose, -v     显示详细输出
  --quiet, -q       安静模式，只显示错误
  --help, -h        显示此帮助信息

示例:
  # 完全同步（默认）
  tsx config-sync.ts

  # 模拟同步（检查而不修改）
  tsx config-sync.ts --dry-run

  # 同步时显示详细信息
  tsx config-sync.ts --verbose

  # 仅同步 CLAUDE.md
  tsx config-sync.ts --no-skills --no-plugins

用途:
  确保 HappyClaw 的项目级 Agent 与主 Agent 保持一致的操作习惯
  - 同步 CLAUDE.md（工作风格指导）
  - 同步 Skills（自定义技能）
  - 同步 Plugins（插件）
`);
}

function main() {
  try {
    const config = parseArgs();

    if (config.verbose) {
      console.log('=== 配置同步 ===');
      console.log('源目录:', USER_CLAUDE_DIR);
      console.log('目标目录:', PROJECT_DIR);
      console.log('================');
      console.log();
    }

    verifyDirectories();
    showStats();

    if (!config.claudeMd && !config.skills && !config.plugins) {
      log('所有同步选项都已禁用', 'warning');
      process.exit(1);
    }

    if (config.dryRun) {
      console.log('\n=== 模拟同步开始 ===');
    } else {
      console.log('\n=== 开始同步 ===');
    }

    if (config.claudeMd) {
      syncClaudeMd(config);
    }

    if (config.skills) {
      syncSkills(config);
    }

    if (config.plugins) {
      syncPlugins(config);
    }

    if (config.verbose) {
      console.log();
      console.log('=== 同步完成 ===');
    }

  } catch (error) {
    log(`同步失败: ${error instanceof Error ? error.message : String(error)}`, 'error');
    process.exit(1);
  }
}

// 直接运行 main()，因为这是 ES 模块
main();

export default main;
