/**
 * Shared MCP server loading utilities.
 * Used by container-runner (Docker + Host modes) and routes/groups.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import type { RegisteredGroup } from './types.js';

/**
 * Load enabled MCP server configs from a servers.json file.
 * Returns only enabled servers with fields needed for settings.json.
 * Supports both stdio (command/args/env) and http/sse (type/url/headers) server types.
 */
function loadMcpServersFromFile(
  serversFile: string,
): Record<string, Record<string, unknown>> {
  try {
    if (!fs.existsSync(serversFile)) return {};
    const file = JSON.parse(fs.readFileSync(serversFile, 'utf8')) as {
      servers?: Record<string, Record<string, unknown>>;
    };
    const raw = file.servers || {};
    const result: Record<string, Record<string, unknown>> = {};
    for (const [name, server] of Object.entries(raw)) {
      if (!server.enabled) continue;

      const isHttpType = server.type === 'http' || server.type === 'sse';

      if (isHttpType) {
        if (!server.url) continue;
        const entry: Record<string, unknown> = {
          type: server.type,
          url: server.url,
        };
        if (
          server.headers &&
          typeof server.headers === 'object' &&
          Object.keys(server.headers as object).length > 0
        ) {
          entry.headers = server.headers;
        }
        result[name] = entry;
      } else {
        if (!server.command) continue;
        const entry: Record<string, unknown> = { command: server.command };
        if (server.args) entry.args = server.args;
        if (
          server.env &&
          typeof server.env === 'object' &&
          Object.keys(server.env as object).length > 0
        ) {
          entry.env = server.env;
        }
        result[name] = entry;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Load enabled MCP server configs for a user.
 * Reads data/mcp-servers/{userId}/servers.json.
 */
export function loadUserMcpServers(
  userId: string,
): Record<string, Record<string, unknown>> {
  const serversFile = path.join(DATA_DIR, 'mcp-servers', userId, 'servers.json');
  return loadMcpServersFromFile(serversFile);
}

/**
 * Resolve effective MCP servers for a group based on its mcp_mode and selected_mcps.
 *
 * - 'inherit' (default): use all global user MCP servers
 * - 'custom' with selected_mcps: filter global user MCP servers to only selected names
 * - 'custom' without selected_mcps (null): same as inherit (all user MCP servers)
 */
export function resolveGroupMcpServers(
  group: RegisteredGroup,
  ownerId: string | undefined,
): Record<string, Record<string, unknown>> {
  if (!ownerId) return {};

  const userMcpServers = loadUserMcpServers(ownerId);

  if (group.mcp_mode !== 'custom') {
    // Inherit mode: use all user MCP servers
    return userMcpServers;
  }

  // Custom mode: filter by selected_mcps
  if (!group.selected_mcps || group.selected_mcps.length === 0) {
    // No selection = use all (same as inherit)
    return userMcpServers;
  }

  const result: Record<string, Record<string, unknown>> = {};
  for (const mcpName of group.selected_mcps) {
    if (userMcpServers[mcpName]) {
      result[mcpName] = userMcpServers[mcpName];
    }
  }
  return result;
}
