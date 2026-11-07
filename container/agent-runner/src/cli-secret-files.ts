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
 *
 * The files must not outlive the Runner. Directories still in use when the
 * process exits (the Runner's SIGTERM handler, liveness timeout and fatal
 * errors all end in process.exit(), skipping the query's finally) are
 * removed by an exit hook. SIGKILL runs nothing, so each directory name
 * carries its Runner's pid and a starting Runner sweeps the ones whose pid
 * is gone.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR_PREFIX = 'happyclaw-cli-';
const OWN_DIR = /^happyclaw-cli-(\d+)-/;

export interface CliSecretFiles {
  /** Path for the SDK's `settings` option (`--settings`). */
  settingsPath: string;
  /** Path for `--mcp-config`, or undefined when there are no external servers. */
  mcpConfigPath?: string;
  /**
   * Removes the directory; safe to call more than once. Never throws: a
   * failure is logged and the exit hook tries again.
   */
  dispose(): void;
}

/** Directories written by this process and not yet removed. */
const liveDirs = new Set<string>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // 'exit' listeners run synchronously inside process.exit().
  process.on('exit', () => {
    for (const dir of [...liveDirs]) removeDir(dir);
  });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    liveDirs.delete(dir);
  } catch (err) {
    console.error(
      `[agent-runner:warn] Could not remove CLI secret files in ${dir}: ${describeError(err)}`,
    );
  }
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
  installExitHook();
  const dir = fs.mkdtempSync(
    path.join(baseDir, `${DIR_PREFIX}${process.pid}-`),
  );
  liveDirs.add(dir);
  const dispose = () => {
    if (liveDirs.has(dir)) removeDir(dir);
  };
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

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // EPERM means the pid is alive under another uid.
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Removes directories that Runners killed outright left in `baseDir`. Only
 * this module's own directories qualify: the name carries a pid that no
 * longer exists, it is a real directory rather than a link, and it belongs
 * to the current uid. Never throws. Returns how many were removed.
 */
export function sweepOrphanCliSecretDirs(
  baseDir: string = os.tmpdir(),
): number {
  // Without a uid there is no way to tell whose directory it is.
  const uid = process.getuid?.();
  if (uid === undefined) return 0;
  let names: string[];
  try {
    names = fs.readdirSync(baseDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const pid = Number(OWN_DIR.exec(name)?.[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const dir = path.join(baseDir, name);
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.uid !== uid) continue;
      if (!processIsGone(pid)) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch (err) {
      console.error(
        `[agent-runner:warn] Could not sweep CLI secret files in ${dir}: ${describeError(err)}`,
      );
    }
  }
  return removed;
}
