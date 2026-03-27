// System-level backup management routes

import fs from 'fs';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { Variables } from '../web-context.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

const execFileAsync = promisify(execFile);

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_SYSTEM_BACKUPS = 5;

export interface SystemBackupInfo {
  filename: string;
  timestamp: string;
  size: number;
  sizeHuman: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validateBackupFilename(filename: string): boolean {
  return /^happyclaw-backup-\d{8}-\d{6}\.tar\.gz$/.test(filename) &&
    !filename.includes('/') && !filename.includes('..');
}

const backupRoutes = new Hono<{ Variables: Variables }>();

// List all system backups
backupRoutes.get('/', authMiddleware, systemConfigMiddleware, (c) => {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('happyclaw-backup-') && f.endsWith('.tar.gz'))
      .sort()
      .reverse();

    const backups: SystemBackupInfo[] = files.map((filename) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, filename));
      // Extract timestamp from filename: happyclaw-backup-YYYYMMDD-HHMMSS.tar.gz
      const m = filename.match(/^happyclaw-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.tar\.gz$/);
      const timestamp = m
        ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`
        : '';
      return { filename, timestamp, size: stat.size, sizeHuman: formatSize(stat.size) };
    });

    return c.json(backups);
  } catch (err) {
    logger.error({ err }, 'Failed to list system backups');
    return c.json({ error: '列出备份失败' }, 500);
  }
});

// Create a new system backup
backupRoutes.post('/', authMiddleware, systemConfigMiddleware, async (c) => {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filename = `happyclaw-backup-${dateStr}.tar.gz`;
    const backupPath = path.join(BACKUP_DIR, filename);

    // Build tar args matching Makefile logic
    const tarArgs = [
      '-czf', backupPath,
      '--exclude=data/ipc',
      '--exclude=data/env',
      '--exclude=data/backups',
      '--exclude=data/happyclaw.log',
      '--exclude=data/db/messages.db-shm',
      '--exclude=data/db/messages.db-wal',
      '--exclude=data/groups/*/logs',
      '--exclude=data/streaming-buffer',
    ];

    // Add directories that exist
    const dirs = ['data/db', 'data/config', 'data/groups', 'data/sessions'];
    if (fs.existsSync(path.join(path.dirname(DATA_DIR), 'data/skills'))) {
      dirs.push('data/skills');
    }
    tarArgs.push(...dirs);

    // Run tar from project root (parent of data/)
    const cwd = path.dirname(DATA_DIR);
    await execFileAsync('tar', tarArgs, { cwd, maxBuffer: 10 * 1024 * 1024 });

    // Rotate: keep only MAX_SYSTEM_BACKUPS
    const existing = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('happyclaw-backup-') && f.endsWith('.tar.gz'))
      .sort();
    while (existing.length > MAX_SYSTEM_BACKUPS) {
      const oldest = existing.shift()!;
      fs.unlinkSync(path.join(BACKUP_DIR, oldest));
    }

    const stat = fs.statSync(backupPath);
    const info: SystemBackupInfo = {
      filename,
      timestamp: now.toISOString(),
      size: stat.size,
      sizeHuman: formatSize(stat.size),
    };

    logger.info({ filename, size: info.sizeHuman }, 'System backup created');
    return c.json(info);
  } catch (err) {
    logger.error({ err }, 'Failed to create system backup');
    const message = err instanceof Error ? err.message : '创建备份失败';
    return c.json({ error: message }, 500);
  }
});

// Download a backup file
backupRoutes.get('/download/:filename', authMiddleware, systemConfigMiddleware, (c) => {
  const filename = c.req.param('filename');
  if (!validateBackupFilename(filename)) {
    return c.json({ error: '无效的文件名' }, 400);
  }

  const filePath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return c.json({ error: '备份文件不存在' }, 404);
  }

  const stat = fs.statSync(filePath);
  c.header('Content-Type', 'application/gzip');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  c.header('Content-Length', String(stat.size));

  return stream(c, async (s) => {
    const readable = fs.createReadStream(filePath);
    for await (const chunk of readable) {
      await s.write(chunk as Uint8Array);
    }
  });
});

// Delete a backup
backupRoutes.delete('/:filename', authMiddleware, systemConfigMiddleware, (c) => {
  const filename = c.req.param('filename');
  if (!validateBackupFilename(filename)) {
    return c.json({ error: '无效的文件名' }, 400);
  }

  const filePath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return c.json({ error: '备份文件不存在' }, 404);
  }

  try {
    fs.unlinkSync(filePath);
    logger.info({ filename }, 'System backup deleted');
    return c.json({ success: true });
  } catch (err) {
    logger.error({ err, filename }, 'Failed to delete system backup');
    return c.json({ error: '删除备份失败' }, 500);
  }
});

// Restore from a backup
backupRoutes.post('/restore/:filename', authMiddleware, systemConfigMiddleware, async (c) => {
  const filename = c.req.param('filename');
  if (!validateBackupFilename(filename)) {
    return c.json({ error: '无效的文件名' }, 400);
  }

  const backupPath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(backupPath)) {
    return c.json({ error: '备份文件不存在' }, 404);
  }

  try {
    const cwd = path.dirname(DATA_DIR);
    await execFileAsync('tar', ['-xzf', backupPath], { cwd, maxBuffer: 10 * 1024 * 1024 });

    logger.info({ filename }, 'System backup restored');
    return c.json({ success: true, message: '恢复成功，请重启服务以应用更改' });
  } catch (err) {
    logger.error({ err, filename }, 'Failed to restore system backup');
    const message = err instanceof Error ? err.message : '恢复备份失败';
    return c.json({ error: message }, 500);
  }
});

export default backupRoutes;
