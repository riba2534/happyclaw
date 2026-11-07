import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import type { Variables } from '../web-context.js';
import { hasHostExecutionPermission } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthUser } from '../types.js';
import { logger } from '../logger.js';
import {
  loadMountAllowlist,
  expandPath,
  findAllowedRoot,
  getProtectedHostPaths,
  isHostMountNavigationPathAllowed,
  matchesBlockedPattern,
  validateMount,
} from '../mount-security.js';
import type { AllowedRoot } from '../types.js';
import {
  workspaceRootContaining,
  workspaceRootDirs,
} from '../workspace-dir.js';

const MAX_ENTRIES = 200;

const browseRoutes = new Hono<{ Variables: Variables }>();

/**
 * What one request may not enter, resolved once: the workspace roots (for
 * every purpose) and the protected host paths mounts check against.
 */
interface BrowseDenySet {
  workspaceRoots: string[];
  protectedPaths: string[];
}

function browseDenySet(): BrowseDenySet {
  const workspaceRoots = workspaceRootDirs();
  return {
    workspaceRoots,
    protectedPaths: getProtectedHostPaths(workspaceRoots),
  };
}

interface DirectoryEntry {
  name: string;
  path: string;
  hasChildren: boolean;
  selectable?: boolean;
}

/**
 * List subdirectories of a given path, filtering hidden dirs and blocked patterns.
 */
function listSubdirectories(
  dirPath: string,
  blockedPatterns: string[],
  deny: BrowseDenySet,
  mountPurpose = false,
  allowedRoots: AllowedRoot[] = [],
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
    let fullPath = path.join(dirPath, entry.name);
    if (matchesBlockedPattern(fullPath, blockedPatterns) !== null) continue;
    let realPath: string;
    try {
      realPath = fs.realpathSync(fullPath);
    } catch {
      continue;
    }
    // Workspace roots hold other workspaces' directories: neither a mount
    // nor a custom directory may point into them.
    if (workspaceRootContaining(realPath, deny.workspaceRoots)) continue;
    if (mountPurpose) {
      fullPath = realPath;
      if (
        !findAllowedRoot(fullPath, allowedRoots) ||
        !isHostMountNavigationPathAllowed(fullPath, deny.protectedPaths)
      ) {
        continue;
      }
    }

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

    dirs.push({
      name: entry.name,
      path: fullPath,
      hasChildren,
      ...(mountPurpose
        ? {
            selectable: validateMount(
              {
                hostPath: fullPath,
                containerPath: 'browse-entry',
                readonly: true,
              },
              false,
              deny.protectedPaths,
            ).allowed,
          }
        : {}),
    });

    if (dirs.length >= MAX_ENTRIES) break;
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  return dirs;
}

// GET /api/browse/directories?path=xxx
browseRoutes.get('/directories', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const purpose = c.req.query('purpose');
  if (purpose !== undefined && purpose !== 'mount') {
    return c.json(
      { error: 'Unsupported browse purpose', code: 'INVALID_BROWSE_PURPOSE' },
      400,
    );
  }
  if (
    purpose === 'mount' &&
    (authUser.role !== 'admin' || authUser.status !== 'active')
  ) {
    return c.json(
      {
        error: 'Only an active administrator can browse host mount paths',
        code: 'HOST_MOUNT_ADMIN_REQUIRED',
      },
      403,
    );
  }
  if (purpose !== 'mount' && !hasHostExecutionPermission(authUser)) {
    return c.json({ error: 'Insufficient permissions' }, 403);
  }
  const deny = browseDenySet();

  const requestedPath = c.req.query('path');
  const allowlist = loadMountAllowlist();
  const blockedPatterns = allowlist?.blockedPatterns ?? [];
  const hasAllowlist = allowlist !== null && allowlist.allowedRoots.length > 0;
  if (purpose === 'mount' && !hasAllowlist) {
    return c.json(
      {
        error: 'Host directory mount policy is unavailable',
        code: 'HOST_MOUNT_POLICY_UNAVAILABLE',
      },
      503,
    );
  }

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
        if (
          purpose === 'mount' &&
          (!isHostMountNavigationPathAllowed(realPath, deny.protectedPaths) ||
            matchesBlockedPattern(realPath, blockedPatterns) !== null)
        ) {
          continue;
        }

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
          ...(purpose === 'mount'
            ? {
                selectable: validateMount(
                  {
                    hostPath: realPath,
                    containerPath: 'browse-root',
                    readonly: true,
                  },
                  false,
                  deny.protectedPaths,
                ).allowed,
              }
            : {}),
        });
      }

      return c.json({
        currentPath: null,
        parentPath: null,
        directories: roots,
        hasAllowlist: true,
        ...(purpose === 'mount' ? { mountingEnabled: true } : {}),
      });
    }

    // No allowlist → return HOME directory
    const homeDir = process.env.HOME || '/';
    return c.json({
      currentPath: homeDir,
      parentPath: homeDir === '/' ? null : path.dirname(homeDir),
      directories: listSubdirectories(homeDir, blockedPatterns, deny),
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

  if (workspaceRootContaining(realPath, deny.workspaceRoots)) {
    return c.json(
      {
        error: 'Path is inside the workspace root',
        code: 'WORKSPACE_ROOT_FORBIDDEN',
      },
      403,
    );
  }

  if (
    purpose === 'mount' &&
    (matchesBlockedPattern(realPath, blockedPatterns) !== null ||
      !isHostMountNavigationPathAllowed(realPath, deny.protectedPaths))
  ) {
    return c.json(
      {
        error: 'Path is not eligible for host directory browsing',
        code: 'HOST_MOUNT_PATH_FORBIDDEN',
      },
      403,
    );
  }

  // Allowlist range check
  if (hasAllowlist) {
    const root = findAllowedRoot(realPath, allowlist!.allowedRoots);
    if (!root) {
      return c.json(
        {
          error: 'Path is not within allowed roots',
          ...(purpose === 'mount' ? { code: 'HOST_MOUNT_PATH_FORBIDDEN' } : {}),
        },
        403,
      );
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
    directories: listSubdirectories(
      realPath,
      blockedPatterns,
      deny,
      purpose === 'mount',
      allowlist?.allowedRoots ?? [],
    ),
    hasAllowlist,
    ...(purpose === 'mount'
      ? {
          mountingEnabled: true,
          currentSelectable: validateMount(
            {
              hostPath: realPath,
              containerPath: 'browse-selection',
              readonly: true,
            },
            false,
            deny.protectedPaths,
          ).allowed,
        }
      : {}),
  });
});

// POST /api/browse/directories — create a new folder
browseRoutes.post('/directories', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const purpose = c.req.query('purpose');
  if (purpose !== undefined && purpose !== 'mount') {
    return c.json(
      { error: 'Unsupported browse purpose', code: 'INVALID_BROWSE_PURPOSE' },
      400,
    );
  }
  if (
    purpose === 'mount' &&
    (authUser.role !== 'admin' || authUser.status !== 'active')
  ) {
    return c.json(
      {
        error: 'Only an active administrator can create host mount paths',
        code: 'HOST_MOUNT_ADMIN_REQUIRED',
      },
      403,
    );
  }
  if (purpose !== 'mount' && !hasHostExecutionPermission(authUser)) {
    return c.json({ error: 'Insufficient permissions' }, 403);
  }
  const deny = browseDenySet();

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

  if (workspaceRootContaining(realParent, deny.workspaceRoots)) {
    return c.json(
      {
        error: 'Parent path is inside the workspace root',
        code: 'WORKSPACE_ROOT_FORBIDDEN',
      },
      403,
    );
  }

  // Allowlist range check
  const allowlist = loadMountAllowlist();
  const hasAllowlist = allowlist !== null && allowlist.allowedRoots.length > 0;
  if (purpose === 'mount' && !hasAllowlist) {
    return c.json(
      {
        error: 'Host directory mount policy is unavailable',
        code: 'HOST_MOUNT_POLICY_UNAVAILABLE',
      },
      503,
    );
  }

  if (hasAllowlist) {
    const root = findAllowedRoot(realParent, allowlist!.allowedRoots);
    if (!root) {
      return c.json(
        {
          error: 'Parent path is not within allowed roots',
          ...(purpose === 'mount' ? { code: 'HOST_MOUNT_PATH_FORBIDDEN' } : {}),
        },
        403,
      );
    }
  }
  if (
    purpose === 'mount' &&
    !validateMount(
      {
        hostPath: realParent,
        containerPath: 'browse-create-parent',
        readonly: true,
      },
      false,
      deny.protectedPaths,
    ).allowed
  ) {
    return c.json(
      {
        error: 'Parent path is not eligible for host directory mounting',
        code: 'HOST_MOUNT_PATH_FORBIDDEN',
      },
      403,
    );
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
