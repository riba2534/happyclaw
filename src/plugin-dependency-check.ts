/**
 * plugin-dependency-check.ts
 *
 * Claude Code plugin 依赖预检模块（best-effort，非阻塞）。
 * 纯静态分析，不执行任何 shell 命令。
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

// -----------------------------------------------------------------------
// 常量
// -----------------------------------------------------------------------

/** 容器/宿主机 PATH 中已知存在的可执行文件 */
const CONTAINER_KNOWN_BINARIES: ReadonlySet<string> = new Set([
  'node',
  'npm',
  'bash',
  'git',
  'chromium',
  'claude',
  'sh',
  'cat',
  'ls',
  'echo',
  'which',
]);

// -----------------------------------------------------------------------
// 类型
// -----------------------------------------------------------------------

interface PluginDepsOverrideEntry {
  requires: string[];
  note: string;
}

type PluginDepsOverride = Record<string, PluginDepsOverrideEntry>;

export interface PluginDepsResult {
  missing: string[];
  note: string;
}

// -----------------------------------------------------------------------
// 内部工具函数
// -----------------------------------------------------------------------

/**
 * 从 Markdown 文件内容中提取 YAML frontmatter 字符串。
 * 仅识别文件开头 `---\n...\n---` 格式。
 */
function extractFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : '';
}

/**
 * 从 frontmatter YAML 字符串中提取指定字段的值（支持单行）。
 * 例如：`allowed-tools: Bash(node:*), Bash(npm:*)` → `'Bash(node:*), Bash(npm:*)'`
 */
function extractFrontmatterField(frontmatter: string, field: string): string {
  // 匹配 `field: value`（单行，value 可含任意字符直到行尾）
  const pattern = new RegExp(`^${field}\\s*:\\s*(.+)$`, 'm');
  const match = frontmatter.match(pattern);
  return match ? match[1].trim() : '';
}

/**
 * 从 `allowed-tools` 字段值中提取所有 `Bash(xxx:*)` 里的 `xxx`。
 *
 * 支持格式：
 *   - `Bash(node:*)`
 *   - `Bash(node:*), Bash(git:*), Read`
 *   - `Bash(python3:*)` 等
 */
function extractBashToolNames(allowedToolsValue: string): string[] {
  const results: string[] = [];
  // 匹配 Bash(xxx:...) 或 Bash(xxx)
  const pattern = /Bash\(\s*([^:),\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(allowedToolsValue)) !== null) {
    const name = m[1].trim();
    if (name) {
      results.push(name);
    }
  }
  return results;
}

/**
 * 从 command 字符串中提取第一个可执行文件名。
 *
 * 策略：
 * 1. 跳过开头的 `KEY=VALUE` 形式的 shell 环境变量赋值。
 * 2. 取第一个 token（空白分隔），去掉引号后返回 basename。
 *
 * 示例：
 *   `node "scripts/foo.mjs"`  → `node`
 *   `python3 -m foo`          → `python3`
 *   `FOO=bar codex run`       → `codex`
 */
function extractCommandBinary(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  // 按空白分割，逐 token 处理
  const tokens = trimmed.split(/\s+/);

  for (const token of tokens) {
    // 跳过 KEY=VALUE 形式的环境变量赋值
    if (/^[A-Z_][A-Z0-9_]*=/.test(token)) {
      continue;
    }
    // 去掉可能的引号
    const clean = token.replace(/^["']|["']$/g, '');
    if (!clean) continue;
    // 取 basename（路径中最后一段），去掉扩展名也不必要（保留原始名用于匹配）
    return path.basename(clean);
  }

  return null;
}

/**
 * 递归收集 hooks.json 里所有 hook 条目的 command 字段。
 * hooks.json 结构示例：
 * {
 *   "hooks": {
 *     "EventName": [
 *       { "hooks": [{ "type": "command", "command": "node ..." }] }
 *     ]
 *   }
 * }
 */
function collectHookCommands(obj: unknown): string[] {
  const commands: string[] = [];

  if (Array.isArray(obj)) {
    for (const item of obj) {
      commands.push(...collectHookCommands(item));
    }
  } else if (obj !== null && typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    if (typeof record['command'] === 'string') {
      commands.push(record['command']);
    }
    for (const value of Object.values(record)) {
      if (typeof value === 'object' && value !== null) {
        commands.push(...collectHookCommands(value));
      }
    }
  }

  return commands;
}

// -----------------------------------------------------------------------
// 扫描逻辑
// -----------------------------------------------------------------------

/**
 * 扫描 commands/*.md 文件，提取 `allowed-tools` frontmatter 字段中的
 * `Bash(xxx:*)` 工具名。
 */
function scanCommandDeps(pluginDir: string): string[] {
  const commandsDir = path.join(pluginDir, 'commands');
  if (!fs.existsSync(commandsDir)) return [];

  const binaries: string[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(commandsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const filePath = path.join(commandsDir, entry);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const frontmatter = extractFrontmatter(content);
    const allowedTools = extractFrontmatterField(frontmatter, 'allowed-tools');
    if (allowedTools) {
      binaries.push(...extractBashToolNames(allowedTools));
    }
  }

  return binaries;
}

/**
 * 扫描 hooks/hooks.json 文件，提取每个 hook command 的第一个可执行文件名。
 */
function scanHookDeps(pluginDir: string): string[] {
  const hooksFile = path.join(pluginDir, 'hooks', 'hooks.json');
  if (!fs.existsSync(hooksFile)) return [];

  let raw: string;
  try {
    raw = fs.readFileSync(hooksFile, 'utf-8');
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const commands = collectHookCommands(parsed);
  const binaries: string[] = [];
  for (const cmd of commands) {
    const bin = extractCommandBinary(cmd);
    if (bin) binaries.push(bin);
  }
  return binaries;
}

// -----------------------------------------------------------------------
// 主导出函数
// -----------------------------------------------------------------------

/**
 * 检查 Claude Code plugin 所需的外部二进制依赖（best-effort，非阻塞）。
/**
 * Check whether a binary exists on the current host's PATH.
 * Only called in host-runtime mode (never for Docker, whose PATH is fixed by
 * the image rather than by the process environment). Returns false on any
 * `which` failure so the caller degrades to "treat as missing".
 */
function hostHasBinary(binary: string): boolean {
  try {
    const out = execFileSync('which', [binary], {
      timeout: 2_000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

/**
 *
 * @param pluginDir     plugin 目录的绝对路径（含 commands/、hooks/ 子目录）
 * @param pluginFullId  plugin 的完整标识符，格式通常为 `name@namespace`
 * @param opts.runtime  运行时环境：
 *                      - 'docker'：按容器硬编码 binary 清单过滤（默认、保守）
 *                      - 'host' ：跑 `which` 实际探测，binary 已装则不报 missing
 *                      省略时按 'docker' 语义（向后兼容，best-effort 更严格警告）
 * @returns             { missing, note }
 */
export function checkPluginDependencies(
  pluginDir: string,
  pluginFullId: string,
  opts: { runtime?: 'docker' | 'host' } = {},
): PluginDepsResult {
  const runtime = opts.runtime ?? 'docker';

  // 过滤器：host 模式下跑 which 实际探测，docker 模式按容器已知 binary 表判断
  const isBinaryMissing = (bin: string): boolean => {
    if (runtime === 'host') return !hostHasBinary(bin);
    return !CONTAINER_KNOWN_BINARIES.has(bin);
  };

  // 1. 尝试读取覆盖表
  const overridePath = path.resolve('config/plugin-deps-override.json');
  let override: PluginDepsOverride = {};
  if (fs.existsSync(overridePath)) {
    try {
      const raw = fs.readFileSync(overridePath, 'utf-8');
      override = JSON.parse(raw) as PluginDepsOverride;
    } catch {
      // 覆盖表损坏时忽略，继续静态扫描
    }
  }

  // 2. 覆盖表命中时，仍按 runtime 过滤——host 已装 codex 就不该报 missing
  if (Object.prototype.hasOwnProperty.call(override, pluginFullId)) {
    const entry = override[pluginFullId];
    const required = entry.requires ?? [];
    const missing = required.filter(isBinaryMissing);
    return { missing, note: entry.note ?? '' };
  }

  // 3. 静态扫描 + runtime 过滤
  const allBinaries = [
    ...scanCommandDeps(pluginDir),
    ...scanHookDeps(pluginDir),
  ];

  const seen = new Set<string>();
  const missing: string[] = [];
  for (const bin of allBinaries) {
    if (seen.has(bin)) continue;
    seen.add(bin);
    if (isBinaryMissing(bin)) {
      missing.push(bin);
    }
  }

  return { missing, note: '' };
}
