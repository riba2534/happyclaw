import fs from 'fs';
import path from 'path';

const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);

function isTruthyEnvValue(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    TRUTHY_ENV_VALUES.has(value.trim().toLowerCase())
  );
}

function settingsEnvValue(settingsFile: string, key: string): unknown {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as {
      env?: Record<string, unknown>;
    };
    return parsed?.env?.[key];
  } catch {
    return undefined;
  }
}

/**
 * Whether Claude Code will skip its turn-start attachment pass.
 *
 * With CLAUDE_CODE_DISABLE_ATTACHMENTS set (process env or the user settings
 * env block; project settings cannot set it), Claude Code 2.1.296 sends no
 * skill listing, nested CLAUDE.md or todo reminders, while getContextUsage()
 * still reports every discovered skill as included. The context audit uses
 * this to avoid claiming skills the model never sees.
 */
export function isClaudeAttachmentPassDisabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
  configDir: string = env.CLAUDE_CONFIG_DIR ||
    path.join(env.HOME || '/home/node', '.claude'),
): boolean {
  if (isTruthyEnvValue(env.CLAUDE_CODE_DISABLE_ATTACHMENTS)) return true;
  return isTruthyEnvValue(
    settingsEnvValue(
      path.join(configDir, 'settings.json'),
      'CLAUDE_CODE_DISABLE_ATTACHMENTS',
    ),
  );
}
