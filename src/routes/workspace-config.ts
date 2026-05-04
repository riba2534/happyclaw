/**
 * Workspace-level Skills and MCP Servers management routes.
 *
 * Operates on the workspace's `.claude/` directory (project-level config).
 * SDK reads both 'project' and 'user' settingSources, so these configs
 * take effect alongside global (user-level) configs without any changes
 * to agent-runner or container-runner.
 */

import { Hono, type Context } from 'hono';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Variables } from '../web-context.js';
import type { AuthUser, RegisteredGroup } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import { GROUPS_DIR } from '../config.js';
import { canAccessGroup } from '../web-context.js';
import { getRegisteredGroup } from '../db.js';
import {
  parseFrontmatter,
  validateSkillId,
  validateSkillPath,
  scanSkillDirectory,
  listFiles,
} from '../skill-utils.js';

const execFileAsync = promisify(execFile);

const workspaceConfigRoutes = new Hono<{ Variables: Variables }>();

// --- Path Resolution ---

/**
 * Resolve the workspace root directory for a registered group.
 * Host mode with customCwd uses the real project directory;
 * otherwise falls back to data/groups/{folder}/.
 */
function getWorkspaceRoot(group: RegisteredGroup & { jid: string }): string {
  if (group.executionMode === 'host' && group.customCwd) {
    return group.customCwd;
  }
  return path.join(GROUPS_DIR, group.folder);
}

function getWorkspaceClaudeDir(
  group: RegisteredGroup & { jid: string },
): string {
  return path.join(getWorkspaceRoot(group), '.claude');
}

function getWorkspaceSkillsDir(
  group: RegisteredGroup & { jid: string },
): string {
  return path.join(getWorkspaceClaudeDir(group), 'skills');
}

function getWorkspaceSettingsPath(
  group: RegisteredGroup & { jid: string },
): string {
  return path.join(getWorkspaceClaudeDir(group), 'settings.json');
}

/**
 * Metadata file for workspace MCP servers.
 * Stores full config + enabled state so we can remove disabled servers
 * from settings.json (SDK won't see them) while preserving the config
 * for re-enabling.
 */
function getWorkspaceMcpMetaPath(
  group: RegisteredGroup & { jid: string },
): string {
  return path.join(getWorkspaceClaudeDir(group), 'happyclaw-workspace.json');
}

// --- MCP Metadata Helpers ---

interface McpServerMeta {
  enabled: boolean;
  description?: string;
  addedAt: string;
  // Full config preserved for re-enabling
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: 'http' | 'sse';
  url?: string;
  headers?: Record<string, string>;
}

interface WorkspaceMeta {
  mcpServers: Record<string, McpServerMeta>;
}

function readWorkspaceMeta(
  group: RegisteredGroup & { jid: string },
): WorkspaceMeta {
  try {
    const data = fs.readFileSync(getWorkspaceMcpMetaPath(group), 'utf-8');
    return JSON.parse(data);
  } catch {
    return { mcpServers: {} };
  }
}

function writeWorkspaceMeta(
  group: RegisteredGroup & { jid: string },
  meta: WorkspaceMeta,
): void {
  const metaPath = getWorkspaceMcpMetaPath(group);
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

function readWorkspaceSettings(
  group: RegisteredGroup & { jid: string },
): Record<string, unknown> {
  try {
    const data = fs.readFileSync(getWorkspaceSettingsPath(group), 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function writeWorkspaceSettings(
  group: RegisteredGroup & { jid: string },
  settings: Record<string, unknown>,
): void {
  const settingsPath = getWorkspaceSettingsPath(group);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

/**
 * Sync enabled MCP servers to settings.json so SDK can discover them.
 * Disabled servers are removed from settings.json but kept in metadata.
 */
function syncMcpToSettings(
  group: RegisteredGroup & { jid: string },
  meta: WorkspaceMeta,
  existingSettings?: Record<string, unknown>,
): void {
  const settings = existingSettings ?? readWorkspaceSettings(group);
  const mcpServers: Record<string, Record<string, unknown>> = {};

  for (const [id, entry] of Object.entries(meta.mcpServers)) {
    if (!entry.enabled) continue;

    const isHttpType = entry.type === 'http' || entry.type === 'sse';
    if (isHttpType) {
      if (!entry.url) continue;
      const server: Record<string, unknown> = {
        type: entry.type,
        url: entry.url,
      };
      if (entry.headers && Object.keys(entry.headers).length > 0) {
        server.headers = entry.headers;
      }
      mcpServers[id] = server;
    } else {
      if (!entry.command) continue;
      const server: Record<string, unknown> = { command: entry.command };
      if (entry.args && entry.args.length > 0) server.args = entry.args;
      if (entry.env && Object.keys(entry.env).length > 0)
        server.env = entry.env;
      mcpServers[id] = server;
    }
  }

  if (Object.keys(mcpServers).length > 0) {
    settings.mcpServers = mcpServers;
  } else {
    delete settings.mcpServers;
  }

  writeWorkspaceSettings(group, settings);
}

// --- Middleware: resolve group + access check ---

function resolveGroup(
  c: Context<{ Variables: Variables }>,
): (RegisteredGroup & { jid: string }) | null {
  const jid = c.req.param('jid');
  if (!jid) return null;
  const authUser = c.get('user') as AuthUser;

  const group = getRegisteredGroup(jid!);
  if (!group) {
    return null;
  }

  if (!canAccessGroup(authUser, group)) {
    return null;
  }

  return group;
}

// ===========================
// Skills API
// ===========================

// GET /workspace-config/skills — list workspace skills
workspaceConfigRoutes.get(
  '/:jid/workspace-config/skills',
  authMiddleware,
  async (c) => {
    const group = resolveGroup(c);
    if (!group) return c.json({ error: 'Group not found or access denied' }, 404);

    const skillsDir = getWorkspaceSkillsDir(group);
    const skills = scanSkillDirectory(skillsDir, 'workspace');
    return c.json({ skills });
  },
);

// POST /workspace-config/skills/install — install skill to workspace
workspaceConfigRoutes.post(
  '/:jid/workspace-config/skills/install',
  authMiddleware,
  async (c) => {
    const group = resolveGroup(c);
    if (!group) return c.json({ error: 'Group not found or access denied' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const pkg = typeof body.package === 'string' ? body.package.trim() : '';

    if (
      !/^[\w\-]+\/[\w\-.]+(?:[@#][\w\-.\/]+)?$/.test(pkg) &&
      !/^https?:\/\//.test(pkg)
    ) {
      return c.json({ error: 'Invalid package name format' }, 400);
    }

    // Install to a temp HOME, then copy to workspace skills dir
    const tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ws-skill-install-'),
    );
    const tempSkillsDir = path.join(tempHome, '.claude', 'skills');
    fs.mkdirSync(tempSkillsDir, { recursive: true });

    try {
      await execFileAsync(
        'npx',
        [
          '-y',
          'skills',
          'add',
          pkg,
          '--global',
          '--yes',
          '-a',
          'claude-code',
        ],
        {
          timeout: 60_000,
          env: { ...process.env, HOME: tempHome },
        },
      );

      // Discover installed skill directories
      const installedEntries: string[] = [];
      if (fs.existsSync(tempSkillsDir)) {
        for (const entry of fs.readdirSync(tempSkillsDir, {
          withFileTypes: true,
        })) {
          if (entry.isDirectory() || entry.isSymbolicLink()) {
            installedEntries.push(entry.name);
          }
        }
      }

      if (installedEntries.length === 0) {
        return c.json(
          { error: 'No skills were installed — package may be invalid' },
          500,
        );
      }

      // Copy to workspace skills directory
      const targetDir = getWorkspaceSkillsDir(group);
      fs.mkdirSync(targetDir, { recursive: true });

      for (const name of installedEntries) {
        const src = path.join(tempSkillsDir, name);
        const dest = path.join(targetDir, name);
        if (fs.existsSync(dest)) {
          fs.rmSync(dest, { recursive: true, force: true });
        }
        // Resolve symlinks and copy real content
        let realSrc = src;
        try {
          const lstat = fs.lstatSync(src);
          if (lstat.isSymbolicLink()) {
            realSrc = fs.realpathSync(src);
          }
        } catch {
          // use src as-is
        }
        fs.cpSync(realSrc, dest, { recursive: true });
      }

      return c.json({ success: true, installed: installedEntries });
    } catch (error) {
      return c.json(
        {
          error: 'Failed to install skill',
          details: error instanceof Error ? error.message : 'Unknown error',
        },
        500,
      );
    } finally {
      try {
        fs.rmSync(tempHome, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  },
);

// PATCH /workspace-config/skills/:id — enable/disable
workspaceConfigRoutes.patch(
  '/:jid/workspace-config/skills/:id',
  authMiddleware,
  async (c) => {
    const group = resolveGroup(c);
    if (!group) return c.json({ error: 'Group not found or access denied' }, 404);

    const id = c.req.param('id');
    if (!validateSkillId(id)) {
      return c.json({ error: 'Invalid skill ID' }, 400);
    }

    const { enabled } = await c.req.json<{ enabled: boolean }>();
    const skillsDir = getWorkspaceSkillsDir(group);
    const skillDir = path.join(skillsDir, id);

    if (!fs.existsSync(skillDir)) {
      return c.json({ error: 'Skill not found' }, 404);
    }
    if (!validateSkillPath(skillsDir, skillDir)) {
      return c.json({ error: 'Invalid skill path' }, 400);
    }

    const srcPath = path.join(
      skillDir,
      enabled ? 'SKILL.md.disabled' : 'SKILL.md',
    );
    const dstPath = path.join(
      skillDir,
      enabled ? 'SKILL.md' : 'SKILL.md.disabled',
    );

    if (!fs.existsSync(srcPath)) {
      return c.json(
        { error: 'Skill not found or already in desired state' },
        404,
      );
    }

    fs.renameSync(srcPath, dstPath);
    return c.json({ success: true });
  },
);

// DELETE /workspace-config/skills/:id — delete skill
workspaceConfigRoutes.delete(
  '/:jid/workspace-config/skills/:id',
  authMiddleware,
  async (c) => {
    const group = resolveGroup(c);
    if (!group) return c.json({ error: 'Group not found or access denied' }, 404);

    const id = c.req.param('id');
    if (!validateSkillId(id)) {
      return c.json({ error: 'Invalid skill ID' }, 400);
    }

    const skillsDir = getWorkspaceSkillsDir(group);
    const skillDir = path.join(skillsDir, id);

    if (!fs.existsSync(skillDir)) {
      return c.json({ error: 'Skill not found' }, 404);
    }
    if (!validateSkillPath(skillsDir, skillDir)) {
      return c.json({ error: 'Invalid skill path' }, 400);
    }

    fs.rmSync(skillDir, { recursive: true, force: true });
    return c.json({ success: true });
  },
);

// ===========================
// MCP Servers API
// ===========================

// GET /workspace-config/mcp-servers — list workspace MCP servers
workspaceConfigRoutes.get(
  '/:jid/workspace-config/mcp-servers',
  authMiddleware,
  async (c) => {
    const group = resolveGroup(c);
    if (!group) return c.json({ error: 'Group not found or access denied' }, 404);

    const meta = readWorkspaceMeta(group);
    const settings = readWorkspaceSettings(group);
    const settingsMcp =
      (settings.mcpServers as Record<string, Record<string, unknown>>) || {};

    // Merge: metadata has full info; also discover servers in settings.json
    // that aren't in metadata (e.g. manually added by user)
    const servers: Array<McpServerMeta & { id: string }> = [];

    // From metadata
    for (const [id, entry] of Object.entries(meta.mcpServers)) {
      servers.push({ id, ...entry });
    }

    // From settings.json (not in metadata = externally added)
    for (const [id, entry] of Object.entries(settingsMcp)) {
      if (meta.mcpServers[id]) continue; // already covered
      const isHttpType = entry.type === 'http' || entry.type === 'sse';
      servers.push({
        id,
        enabled: true, // in settings.json = enabled
        addedAt: '',
        ...(isHttpType
          ? {
              type: entry.type as 'http' | 'sse',
              url: entry.url as string,
              ...(entry.headers
                ? { headers: entry.headers as Record<string, string> }
                : {}),
            }
          : {
              command: entry.command as string,
              ...(entry.args ? { args: entry.args as string[] } : {}),
              ...(entry.env
                ? { env: entry.env as Record<string, string> }
                : {}),
            }),
      });
    }

    return c.json({ servers });
  },
);

// POST /workspace-config/mcp-servers — add MCP server
workspaceConfigRoutes.post(
  '/:jid/workspace-config/mcp-servers',
  authMiddleware,
  async (c) => {
    const group = resolveGroup(c);
    if (!group) return c.json({ error: 'Group not found or access denied' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const { id, command, args, env, description, type, url, headers } =
      body as {
        id?: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        description?: string;
        type?: string;
        url?: string;
        headers?: Record<string, string>;
      };

    if (!id || typeof id !== 'string') {
      return c.json({ error: 'id is required' }, 400);
    }
    if (!/^[\w\-]+$/.test(id)) {
      return c.json({ error: 'Invalid server ID' }, 400);
    }

    const isHttpType = type === 'http' || type === 'sse';
    if (isHttpType) {
      if (!url || typeof url !== 'string') {
        return c.json({ error: 'url is required for http/sse type' }, 400);
      }
    } else {
      if (!command || typeof command !== 'string') {
        return c.json({ error: 'command is required' }, 400);
      }
    }

    const meta = readWorkspaceMeta(group);
    if (meta.mcpServers[id]) {
      return c.json({ error: `Server "${id}" already exists` }, 409);
    }

    const entry: McpServerMeta = {
      enabled: true,
      addedAt: new Date().toISOString(),
      ...(description ? { description } : {}),
    };

    if (isHttpType) {
      entry.type = type as 'http' | 'sse';
      entry.url = url;
      if (headers && Object.keys(headers).length > 0) entry.headers = headers;
    } else {
      entry.command = command;
      if (args && args.length > 0) entry.args = args;
      if (env && Object.keys(env).length > 0) entry.env = env;
    }

    meta.mcpServers[id] = entry;
    writeWorkspaceMeta(group, meta);
    syncMcpToSettings(group, meta);

    return c.json({ success: true, server: { id, ...entry } });
  },
);

// PATCH /workspace-config/mcp-servers/:id — update/enable/disable
workspaceConfigRoutes.patch(
  '/:jid/workspace-config/mcp-servers/:id',
  authMiddleware,
  async (c) => {
    const group = resolveGroup(c);
    if (!group) return c.json({ error: 'Group not found or access denied' }, 404);

    const id = c.req.param('id');
    if (!/^[\w\-]+$/.test(id)) {
      return c.json({ error: 'Invalid server ID' }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const { command, args, env, enabled, description, url, headers } =
      body as {
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        enabled?: boolean;
        description?: string;
        url?: string;
        headers?: Record<string, string>;
      };

    const meta = readWorkspaceMeta(group);
    let entry = meta.mcpServers[id];

    // If not in metadata, check settings.json for externally added servers
    if (!entry) {
      const settings = readWorkspaceSettings(group);
      const settingsMcp =
        (settings.mcpServers as Record<string, Record<string, unknown>>) || {};
      const settingsEntry = settingsMcp[id];
      if (!settingsEntry) {
        return c.json({ error: 'Server not found' }, 404);
      }
      // Import from settings into metadata
      const isHttp =
        settingsEntry.type === 'http' || settingsEntry.type === 'sse';
      entry = {
        enabled: true,
        addedAt: '',
        ...(isHttp
          ? {
              type: settingsEntry.type as 'http' | 'sse',
              url: settingsEntry.url as string,
            }
          : { command: settingsEntry.command as string }),
      };
      meta.mcpServers[id] = entry;
    }

    if (command !== undefined) entry.command = command;
    if (args !== undefined) entry.args = args;
    if (env !== undefined) entry.env = env;
    if (url !== undefined) entry.url = url;
    if (headers !== undefined) entry.headers = headers;
    if (typeof enabled === 'boolean') entry.enabled = enabled;
    if (description !== undefined) {
      entry.description =
        typeof description === 'string' ? description : undefined;
    }

    writeWorkspaceMeta(group, meta);
    syncMcpToSettings(group, meta);

    return c.json({ success: true, server: { id, ...entry } });
  },
);

// DELETE /workspace-config/mcp-servers/:id — delete MCP server
workspaceConfigRoutes.delete(
  '/:jid/workspace-config/mcp-servers/:id',
  authMiddleware,
  async (c) => {
    const group = resolveGroup(c);
    if (!group) return c.json({ error: 'Group not found or access denied' }, 404);

    const id = c.req.param('id');
    if (!/^[\w\-]+$/.test(id)) {
      return c.json({ error: 'Invalid server ID' }, 400);
    }

    const meta = readWorkspaceMeta(group);
    const hadMeta = !!meta.mcpServers[id];
    delete meta.mcpServers[id];

    // Also remove from settings.json directly
    const settings = readWorkspaceSettings(group);
    const settingsMcp =
      (settings.mcpServers as Record<string, unknown>) || {};
    const hadSettings = id in settingsMcp;

    if (!hadMeta && !hadSettings) {
      return c.json({ error: 'Server not found' }, 404);
    }

    if (hadMeta) {
      writeWorkspaceMeta(group, meta);
    }
    syncMcpToSettings(group, meta, settings);

    return c.json({ success: true });
  },
);

export default workspaceConfigRoutes;
