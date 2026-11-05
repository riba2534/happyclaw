/**
 * Keeps credentials out of the Claude CLI's command line.
 *
 * The Agent SDK turns an inline `settings` object into `--settings <json>`
 * and `mcpServers` into `--mcp-config <json>`. Both carry secrets: the flag
 * settings pin the bound connection's token in `env`, and user MCP servers
 * hold API keys in headers, env or URLs. A process's argv is readable by
 * every local user for as long as it runs, so the Runner writes the two
 * documents to 0600 files in a private 0700 directory and passes their paths;
 * both CLI flags accept a path. HappyClaw's in-process MCP server stays in
 * `mcpServers`: the SDK hands SDK-type servers to the CLI over its control
 * channel, never argv.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CliSecretFiles {
  /** Path for the SDK's `settings` option (`--settings`). */
  settingsPath: string;
  /** Path for `--mcp-config`, or undefined when there are no external servers. */
  mcpConfigPath?: string;
  /** Removes the directory; safe to call more than once. */
  dispose(): void;
}

function writePrivate(file: string, value: unknown): void {
  // `wx` refuses to follow or reuse anything already at the path.
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
}

/**
 * Writes the flag settings and external MCP servers for one query. The
 * caller passes the paths to the SDK and disposes once the CLI has exited.
 */
export function writeCliSecretFiles(
  settings: Record<string, unknown>,
  externalMcpServers: Record<string, unknown>,
  baseDir: string = os.tmpdir(),
): CliSecretFiles {
  const dir = fs.mkdtempSync(path.join(baseDir, 'happyclaw-cli-'));
  const dispose = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    fs.chmodSync(dir, 0o700);
    const settingsPath = path.join(dir, 'settings.json');
    writePrivate(settingsPath, settings);
    let mcpConfigPath: string | undefined;
    if (Object.keys(externalMcpServers).length > 0) {
      mcpConfigPath = path.join(dir, 'mcp.json');
      writePrivate(mcpConfigPath, { mcpServers: externalMcpServers });
    }
    return { settingsPath, mcpConfigPath, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}
