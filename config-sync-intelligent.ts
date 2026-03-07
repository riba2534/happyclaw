#!/usr/bin/env tsx
/**
 * 智能配置同步脚本 - 基于 Agent 理解的用户操作习惯 Summary 追加写
 * 不是简单的文件同步，而是智能分析和追加更新
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// 配置
const USER_CLAUDE_DIR = '/Users/wktt/.claude';
const PROJECT_DIR = '/Users/wktt/happyclaw';
const PROJECT_CONFIG_DIR = path.join(PROJECT_DIR, 'config');
const GLOBAL_CLAUDE_MD = path.join(PROJECT_CONFIG_DIR, 'global-claude-md.template.md');

// 日志功能
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

// 读取文件内容
function readFile(filePath: string): string | null {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  } catch (error) {
    log(`无法读取文件: ${filePath} - ${(error as Error).message}`, 'error');
  }
  return null;
}

// 智能分析用户操作习惯
function analyzeUserHabits(userClaudeMd: string): {
  workStyle: string[];
  preferences: string[];
  keyPoints: string[];
} {
  const habits = {
    workStyle: [],
    preferences: [],
    keyPoints: [],
  };

  // 分析工作风格
  const workStyleMatch = userClaudeMd.match(/## Work Style\s*([\s\S]*?)(?=##|$)/);
  if (workStyleMatch) {
    const workStyleContent = workStyleMatch[1];
    // 提取要点（通常是数字列表）
    const workStylePoints = workStyleContent.match(/\d+\.\s*([^\n]+)/g);
    if (workStylePoints) {
      habits.workStyle = workStylePoints.map(point =>
        point.replace(/^\d+\.\s*/, '').trim()
      );
    }
  }

  // 分析 Git 工作流程
  const gitWorkflowMatch = userClaudeMd.match(/## Git Workflow\s*([\s\S]*?)(?=##|$)/);
  if (gitWorkflowMatch) {
    habits.keyPoints.push('Git 工作流程: ' + gitWorkflowMatch[1].trim().substring(0, 100) + '...');
  }

  // 分析飞书文档操作提醒
  const feishuReminderMatch = userClaudeMd.match(/## 飞书文档操作提醒\s*([\s\S]*?)(?=##|$)/);
  if (feishuReminderMatch) {
    habits.keyPoints.push('飞书文档操作提醒: ' + feishuReminderMatch[1].trim().substring(0, 100) + '...');
  }

  // 分析其他重要配置
  if (userClaudeMd.includes('严谨的工程师')) {
    habits.preferences.push('沟通风格: 严谨的工程师');
  }

  if (userClaudeMd.includes('No unvalidated features/requirements')) {
    habits.workStyle.push('不实现未验证的功能/需求');
  }

  if (userClaudeMd.includes('Clarify before execution')) {
    habits.workStyle.push('执行前先澄清需求');
  }

  if (userClaudeMd.includes('Evidence-based assertions')) {
    habits.workStyle.push('基于证据的断言');
  }

  if (userClaudeMd.includes('Risk awareness')) {
    habits.workStyle.push('风险意识');
  }

  return habits;
}

// 生成用户操作习惯 Summary
function generateHabitsSummary(habits: ReturnType<typeof analyzeUserHabits>): string {
  const sections: string[] = [];

  if (habits.workStyle.length > 0) {
    sections.push('## 用户操作习惯 Summary');
    sections.push('');
    sections.push('### 工作风格');
    sections.push('');
    habits.workStyle.forEach(habit => {
      sections.push(`- ${habit}`);
    });
    sections.push('');
  }

  if (habits.preferences.length > 0) {
    sections.push('### 沟通偏好');
    sections.push('');
    habits.preferences.forEach(pref => {
      sections.push(`- ${pref}`);
    });
    sections.push('');
  }

  if (habits.keyPoints.length > 0) {
    sections.push('### 关键要点');
    sections.push('');
    habits.keyPoints.forEach(point => {
      sections.push(`- ${point}`);
    });
    sections.push('');
  }

  return sections.join('\n');
}

// 检查是否需要更新 Summary
function needsSummaryUpdate(existingContent: string, newSummary: string): boolean {
  // 检查是否已包含相同的 Summary
  const workStyleMatch = newSummary.match(/### 工作风格([\s\S]*?)(?=###|$)/);
  if (workStyleMatch) {
    const workStyleText = workStyleMatch[1];
    if (existingContent.includes(workStyleText.trim())) {
      log('用户操作习惯 Summary 未发生变化，无需更新', 'info');
      return false;
    }
  }

  return true;
}

// 追加用户操作习惯 Summary 到全局 CLAUDE.md 模板
function appendHabitsSummary(summary: string) {
  const existingContent = readFile(GLOBAL_CLAUDE_MD);
  if (!existingContent) {
    log('无法读取全局 CLAUDE.md 模板', 'error');
    return false;
  }

  // 检查是否已包含 Summary 部分
  const summaryPattern = /## 用户操作习惯 Summary[\s\S]*?(?=## 工作区与记忆|$)/;
  const hasExistingSummary = summaryPattern.test(existingContent);

  let updatedContent = '';

  if (hasExistingSummary) {
    // 更新现有的 Summary 部分
    updatedContent = existingContent.replace(summaryPattern, summary);
  } else {
    // 在适当位置追加 Summary（在 "配置同步机制" 之后）
    const insertPosition = existingContent.indexOf('## 工作区与记忆');
    if (insertPosition !== -1) {
      updatedContent = existingContent.slice(0, insertPosition) +
        summary +
        existingContent.slice(insertPosition);
    } else {
      // 如果没有找到特定位置，则追加到文件末尾
      updatedContent = existingContent + '\n' + summary;
    }
  }

  try {
    fs.writeFileSync(GLOBAL_CLAUDE_MD, updatedContent, 'utf-8');
    log('全局 CLAUDE.md 模板已更新', 'success');
    return true;
  } catch (error) {
    log(`无法写入文件: ${GLOBAL_CLAUDE_MD} - ${(error as Error).message}`, 'error');
    return false;
  }
}

// 同步 Skills - 调用项目中已有的 sync-host 功能
async function syncSkills() {
  log('=== 同步 Skills（调用项目 API）===', 'info');

  try {
    // 调用项目中已有的 sync-host 路由
    const response = await fetch('http://localhost:3000/api/skills/sync-host', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include', // 包含 cookies 用于认证
    });

    if (response.ok) {
      const result = await response.json();
      log(`Skills 同步成功: 新增 ${result.stats.added}, 更新 ${result.stats.updated}, 删除 ${result.stats.deleted}, 跳过 ${result.stats.skipped}`, 'success');
    } else {
      log(`Skills 同步失败: ${response.status} - ${response.statusText}`, 'error');
    }
  } catch (error) {
    log(`Skills 同步失败: ${(error as Error).message}`, 'error');
    log('提示: 确保项目服务器正在运行（npm run dev）', 'warning');
  }
}

// 同步 Plugins - 安装用户级 plugins
function syncPlugins() {
  log('=== 同步 Plugins（自动安装）===', 'info');

  const userPluginsDir = path.join(USER_CLAUDE_DIR, 'plugins');
  if (!fs.existsSync(userPluginsDir)) {
    log('用户 Plugins 目录不存在', 'warning');
    return;
  }

  // 扫描用户 plugins 目录
  const plugins = fs.readdirSync(userPluginsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() || entry.isFile())
    .map(entry => entry.name);

  if (plugins.length === 0) {
    log('未发现用户 Plugins', 'info');
    return;
  }

  log(`发现 ${plugins.length} 个用户 Plugins`, 'info');

  // 对于每个 plugin，尝试自动安装
  for (const pluginName of plugins) {
    log(`处理 Plugin: ${pluginName}`, 'info');
    // 目前 HappyClaw 没有明确的 Plugin 安装机制，这里只做信息记录
    // 实际的 Plugin 安装可能需要根据项目架构进行实现
  }

  log('Plugins 同步信息记录完成', 'success');
}

// 主同步函数
async function main() {
  console.log('=== 智能配置同步 ===');
  console.log('源目录:', USER_CLAUDE_DIR);
  console.log('目标目录:', PROJECT_DIR);
  console.log('================');
  console.log();

  // 检查必要的目录
  const dirsToCheck = [USER_CLAUDE_DIR, PROJECT_CONFIG_DIR];
  for (const dir of dirsToCheck) {
    if (!fs.existsSync(dir)) {
      log(`目录不存在: ${dir}`, 'error');
      process.exit(1);
    }
  }

  // 同步 CLAUDE.md（智能追加写）
  log('=== 同步 CLAUDE.md（智能 Summary 追加）===', 'info');
  const userClaudeMd = readFile(path.join(USER_CLAUDE_DIR, 'CLAUDE.md'));
  if (userClaudeMd) {
    const habits = analyzeUserHabits(userClaudeMd);
    const newSummary = generateHabitsSummary(habits);

    log('分析到的用户操作习惯:', 'info');
    console.log();
    console.log(newSummary);
    console.log();

    if (needsSummaryUpdate(readFile(GLOBAL_CLAUDE_MD) || '', newSummary)) {
      appendHabitsSummary(newSummary);
    }
  } else {
    log('无法读取用户 CLAUDE.md', 'warning');
  }

  // 同步 Skills
  await syncSkills();

  // 同步 Plugins
  syncPlugins();

  console.log();
  log('=== 智能配置同步完成 ===', 'success');
}

main().catch(error => {
  log(`同步过程中发生错误: ${error.message}`, 'error');
  process.exit(1);
});
