// MCP Servers management routes

import { Hono } from 'hono';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import { DATA_DIR } from '../config.js';

// --- Types ---

interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
  syncedFromHost?: boolean;
  description?: string;
  addedAt: string;
}

interface McpServersFile {
  servers: Record<string, McpServerEntry>;
}

interface HostSyncManifest {
  syncedServers: string[];
  lastSyncAt: string;
}

// --- Utility Functions ---

function getUserMcpServersDir(userId: string): string {
  return path.join(DATA_DIR, 'mcp-servers', userId);
}

function getServersFilePath(userId: string): string {
  return path.join(getUserMcpServersDir(userId), 'servers.json');
}

function getHostSyncManifestPath(userId: string): string {
  return path.join(getUserMcpServersDir(userId), '.host-sync.json');
}

function validateServerId(id: string): boolean {
  return /^[\w\-]+$/.test(id) && id !== 'happyclaw';
}

async function readMcpServersFile(userId: string): Promise<McpServersFile> {
  try {
    const data = await fs.readFile(getServersFilePath(userId), 'utf-8');
    return JSON.parse(data);
  } catch {
    return { servers: {} };
  }
}

async function writeMcpServersFile(
  userId: string,
  data: McpServersFile,
): Promise<void> {
  const dir = getUserMcpServersDir(userId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(getServersFilePath(userId), JSON.stringify(data, null, 2));
}

async function readHostSyncManifest(userId: string): Promise<HostSyncManifest> {
  try {
    const data = await fs.readFile(getHostSyncManifestPath(userId), 'utf-8');
    return JSON.parse(data);
  } catch {
    return { syncedServers: [], lastSyncAt: '' };
  }
}

async function writeHostSyncManifest(
  userId: string,
  manifest: HostSyncManifest,
): Promise<void> {
  const dir = getUserMcpServersDir(userId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    getHostSyncManifestPath(userId),
    JSON.stringify(manifest, null, 2),
  );
}

// --- Routes ---

const mcpServersRoutes = new Hono<{ Variables: Variables }>();

// GET / — list all MCP servers for the current user
mcpServersRoutes.get('/', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const file = await readMcpServersFile(authUser.id);
  const servers = Object.entries(file.servers).map(([id, entry]) => ({
    id,
    ...entry,
  }));
  return c.json({ servers });
});

// POST / — add a new MCP server
mcpServersRoutes.post('/', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));

  const { id, command, args, env, description } = body as {
    id?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    description?: string;
  };

  if (!id || typeof id !== 'string') {
    return c.json({ error: 'id is required and must be a string' }, 400);
  }
  if (!validateServerId(id)) {
    return c.json(
      {
        error:
          'Invalid server ID: must match /^[\\w\\-]+$/ and cannot be "happyclaw"',
      },
      400,
    );
  }
  if (!command || typeof command !== 'string') {
    return c.json(
      { error: 'command is required and must be a string' },
      400,
    );
  }
  if (args !== undefined && !Array.isArray(args)) {
    return c.json({ error: 'args must be an array of strings' }, 400);
  }
  if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env))) {
    return c.json({ error: 'env must be a plain object' }, 400);
  }

  const file = await readMcpServersFile(authUser.id);
  if (file.servers[id]) {
    return c.json({ error: `Server "${id}" already exists` }, 409);
  }

  file.servers[id] = {
    command,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    enabled: true,
    ...(description ? { description } : {}),
    addedAt: new Date().toISOString(),
  };

  await writeMcpServersFile(authUser.id, file);
  return c.json({ success: true, server: { id, ...file.servers[id] } });
});

// PATCH /:id — update config / enable / disable
mcpServersRoutes.patch('/:id', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');

  if (!validateServerId(id)) {
    return c.json({ error: 'Invalid server ID' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const { command, args, env, enabled, description } = body as {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    enabled?: boolean;
    description?: string;
  };

  const file = await readMcpServersFile(authUser.id);
  const entry = file.servers[id];
  if (!entry) {
    return c.json({ error: 'Server not found' }, 404);
  }

  if (command !== undefined) {
    if (typeof command !== 'string' || !command) {
      return c.json({ error: 'command must be a non-empty string' }, 400);
    }
    entry.command = command;
  }
  if (args !== undefined) {
    if (!Array.isArray(args)) {
      return c.json({ error: 'args must be an array of strings' }, 400);
    }
    entry.args = args;
  }
  if (env !== undefined) {
    if (typeof env !== 'object' || env === null || Array.isArray(env)) {
      return c.json({ error: 'env must be a plain object' }, 400);
    }
    entry.env = env;
  }
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }
    entry.enabled = enabled;
  }
  if (description !== undefined) {
    entry.description = typeof description === 'string' ? description : undefined;
  }

  await writeMcpServersFile(authUser.id, file);
  return c.json({ success: true, server: { id, ...entry } });
});

// DELETE /:id — delete a server
mcpServersRoutes.delete('/:id', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');

  if (!validateServerId(id)) {
    return c.json({ error: 'Invalid server ID' }, 400);
  }

  const file = await readMcpServersFile(authUser.id);
  if (!file.servers[id]) {
    return c.json({ error: 'Server not found' }, 404);
  }

  delete file.servers[id];
  await writeMcpServersFile(authUser.id, file);
  return c.json({ success: true });
});

// POST /sync-host — sync from host ~/.claude/settings.json (admin only)
mcpServersRoutes.post('/sync-host', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  if (authUser.role !== 'admin') {
    return c.json({ error: 'Only admin can sync host MCP servers' }, 403);
  }

  // Read host settings
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let hostServers: Record<string, any> = {};
  try {
    const raw = await fs.readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(raw);
    hostServers = settings.mcpServers || {};
  } catch {
    return c.json({ error: 'Failed to read host settings.json' }, 500);
  }

  const file = await readMcpServersFile(authUser.id);
  const manifest = await readHostSyncManifest(authUser.id);
  const previouslySynced = new Set(manifest.syncedServers);
  const hostServerIds = new Set(Object.keys(hostServers));

  const stats = { added: 0, updated: 0, deleted: 0, skipped: 0 };
  const newSyncedList: string[] = [];

  // Add/update from host
  for (const [id, hostEntry] of Object.entries(hostServers)) {
    if (!validateServerId(id)) {
      stats.skipped++;
      continue;
    }

    const existsInUser = !!file.servers[id];
    const wasSynced = previouslySynced.has(id);

    // Skip manually added entries
    if (existsInUser && !wasSynced) {
      stats.skipped++;
      continue;
    }

    const entry: McpServerEntry = {
      command: hostEntry.command || '',
      ...(hostEntry.args ? { args: hostEntry.args } : {}),
      ...(hostEntry.env ? { env: hostEntry.env } : {}),
      enabled: true,
      syncedFromHost: true,
      addedAt: existsInUser
        ? (file.servers[id].addedAt || new Date().toISOString())
        : new Date().toISOString(),
    };

    if (existsInUser) {
      stats.updated++;
    } else {
      stats.added++;
    }

    file.servers[id] = entry;
    newSyncedList.push(id);
  }

  // Delete servers that were synced before but no longer on host
  for (const id of previouslySynced) {
    if (!hostServerIds.has(id) && file.servers[id]?.syncedFromHost) {
      delete file.servers[id];
      stats.deleted++;
    }
  }

  await writeMcpServersFile(authUser.id, file);
  await writeHostSyncManifest(authUser.id, {
    syncedServers: newSyncedList,
    lastSyncAt: new Date().toISOString(),
  });

  return c.json(stats);
});

export { getUserMcpServersDir, readMcpServersFile };
export default mcpServersRoutes;
