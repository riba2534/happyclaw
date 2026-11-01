/**
 * Session file cleanup — shared between the Web UI reset-session route and the
 * IM `/clear` slash command. Removes everything under a session's
 * `data/sessions/{folder}/agents/{agentId}/.claude/` except `settings.json`,
 * which the container runner recreates anyway but is cheap to preserve.
 *
 * Errors on individual entries are logged and skipped so a single permission
 * problem (e.g. on a stale symlink) doesn't abort the whole reset.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

export function clearSessionFiles(folder: string, agentId: string): void {
  const claudeDir = path.join(
    DATA_DIR,
    'sessions',
    folder,
    'agents',
    agentId,
    '.claude',
  );
  if (!fs.existsSync(claudeDir)) return;

  const keep = new Set(['settings.json']);
  for (const entry of fs.readdirSync(claudeDir)) {
    if (keep.has(entry)) continue;
    try {
      fs.rmSync(path.join(claudeDir, entry), {
        recursive: true,
        force: true,
      });
    } catch (err) {
      logger.warn(
        { entry, folder, agentId, err },
        'Failed to remove session file, skipping',
      );
    }
  }
}
