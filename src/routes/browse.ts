import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import type { Variables } from '../web-context.js';
import { hasHostExecutionPermission } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthUser } from '../types.js';
import { logger } from '../logger.js';
import { HOME_DIR } from '../environment.js';
import {
  loadMountAllowlist,
  expandPath,
  findAllowedRoot,
  matchesBlockedPattern,
} from '../mount-security.js';

const MAX_ENTRIES = 200;

const browseRoutes = new Hono<{ Variables: Variables }>();

interface DirectoryEntry {
  name: string;
  path: string;
  hasChildren: boolean;
}

/**
 * List subdirectories of a given path, filtering hidden dirs and blocked patterns.
 */
function listSubdirectories(
  dirPath: string,
  blockedPatterns: string[],
): DirectoryEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs: DirectoryEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip hidden directories
    if (entry.name.startsWith('.')) continue;
    // Skip blocked patterns
    const fullPath = path.join(dirPath, entry.name);
    if (matchesBlockedPattern(fullPath, blockedPatterns) !== null) continue;

    // Check if has subdirectories (for expand indicator)
    let hasChildren = false;
    try {
      const children = fs.readdirSync(fullPath, { withFileTypes: true });
      hasChildren = children.some(
        (c) => c.isDirectory() && !c.name.startsWith('.'),
      );
    } catch {
      // Permission denied or other error — treat as no children
    }

    dirs.push({ name: entry.name, path: fullPath, hasChildren });

    if (dirs.length >= MAX_ENTRIES) break;
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  return dirs;
}

// GET /api/browse/directories?path=xxx
browseRoutes.get('/directories', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  if (!hasHostExecutionPermission(authUser)) {
    return c.json({ error: 'Insufficient permissions' }, 403);
  }

  const requestedPath = c.req.query('path');
  const allowlist = loadMountAllowlist();
  const blockedPatterns = allowlist?.blockedPatterns ?? [];
  const hasAllowlist = allowlist !== null && allowlist.allowedRoots.length > 0;

  // No path → return root listing
  if (!requestedPath) {
    if (hasAllowlist) {
      // Return allowlist roots as top-level entries
      const roots: DirectoryEntry[] = [];
      for (const root of allowlist!.allowedRoots) {
        const expanded = expandPath(root.path);
        let realPath: string;
        try {
          realPath = fs.realpathSync(expanded);
        } catch {
          continue; // Root doesn't exist, skip
        }
        if (!fs.existsSync(realPath) || !fs.statSync(realPath).isDirectory())
          continue;

        let hasChildren = false;
        try {
          const children = fs.readdirSync(realPath, { withFileTypes: true });
          hasChildren = children.some(
            (ch) => ch.isDirectory() && !ch.name.startsWith('.'),
          );
        } catch {
          /* ignore */
        }

        roots.push({
          name: root.description || path.basename(realPath),
          path: realPath,
          hasChildren,
        });
      }

      return c.json({
        currentPath: null,
        parentPath: null,
        directories: roots,
        hasAllowlist: true,
      });
    }

    // No allowlist → return HOME directory
    const homeDir = HOME_DIR;
    return c.json({
      currentPath: homeDir,
      parentPath: homeDir === '/' ? null : path.dirname(homeDir),
      directories: listSubdirectories(homeDir, blockedPatterns),
      hasAllowlist: false,
    });
  }

  // Validate path
  if (!path.isAbsolute(requestedPath)) {
    return c.json({ error: 'Path must be absolute' }, 400);
  }

  let realPath: string;
  try {
    realPath = fs.realpathSync(requestedPath);
  } catch {
    return c.json({ error: 'Path does not exist' }, 400);
  }

  if (!fs.statSync(realPath).isDirectory()) {
    return c.json({ error: 'Path is not a directory' }, 400);
  }

  // Allowlist range check
  if (hasAllowlist) {
    const root = findAllowedRoot(realPath, allowlist!.allowedRoots);
    if (!root) {
      return c.json({ error: 'Path is not within allowed roots' }, 403);
    }
  }

  // Compute parentPath
  let parentPath: string | null = path.dirname(realPath);
  if (parentPath === realPath) {
    // At filesystem root
    parentPath = null;
  } else if (hasAllowlist) {
    // Check if parent is still within an allowed root
    const parentRoot = findAllowedRoot(parentPath, allowlist!.allowedRoots);
    if (!parentRoot) {
      // Parent is outside allowed roots — return null to go back to root listing
      parentPath = null;
    }
  }

  return c.json({
    currentPath: realPath,
    parentPath,
    directories: listSubdirectories(realPath, blockedPatterns),
    hasAllowlist,
  });
});

// POST /api/browse/directories — create a new folder
browseRoutes.post('/directories', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  if (!hasHostExecutionPermission(authUser)) {
    return c.json({ error: 'Insufficient permissions' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const { parentPath, name } = body;

  if (!parentPath || typeof parentPath !== 'string') {
    return c.json({ error: 'parentPath is required' }, 400);
  }
  if (!name || typeof name !== 'string') {
    return c.json({ error: 'name is required' }, 400);
  }

  // Validate name
  if (name.includes('/') || name.includes('..') || name.startsWith('.')) {
    return c.json(
      { error: 'Invalid folder name: must not contain /, .., or start with .' },
      400,
    );
  }

  if (!path.isAbsolute(parentPath)) {
    return c.json({ error: 'parentPath must be absolute' }, 400);
  }

  let realParent: string;
  try {
    realParent = fs.realpathSync(parentPath);
  } catch {
    return c.json({ error: 'Parent path does not exist' }, 400);
  }

  if (!fs.statSync(realParent).isDirectory()) {
    return c.json({ error: 'Parent path is not a directory' }, 400);
  }

  // Allowlist range check
  const allowlist = loadMountAllowlist();
  const hasAllowlist = allowlist !== null && allowlist.allowedRoots.length > 0;

  if (hasAllowlist) {
    const root = findAllowedRoot(realParent, allowlist!.allowedRoots);
    if (!root) {
      return c.json({ error: 'Parent path is not within allowed roots' }, 403);
    }
  }

  // Blocked patterns check
  const blockedPatterns = allowlist?.blockedPatterns ?? [];
  const targetPath = path.join(realParent, name);
  if (matchesBlockedPattern(targetPath, blockedPatterns) !== null) {
    return c.json({ error: 'Folder name matches a blocked pattern' }, 400);
  }

  // Check if already exists
  if (fs.existsSync(targetPath)) {
    return c.json({ error: 'Directory already exists' }, 400);
  }

  try {
    fs.mkdirSync(targetPath, { recursive: false });
    logger.info({ path: targetPath }, 'Directory created via browse API');
  } catch (err) {
    logger.error({ err, path: targetPath }, 'Failed to create directory');
    return c.json({ error: 'Failed to create directory' }, 500);
  }

  return c.json({
    name,
    path: targetPath,
    hasChildren: false,
  });
});

export default browseRoutes;
