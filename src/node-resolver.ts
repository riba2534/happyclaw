/**
 * Resolves an absolute path to the `node` binary for spawning host-side
 * child processes (host-mode agent-runner, PTY worker, etc.).
 *
 * Host services launched by PM2 / launchd / GUI launchers may inherit a
 * minimal PATH that does not include nvm / fnm / volta managed Node
 * installations. A bare `spawn('node', ...)` then fails with ENOENT even
 * though the parent process is itself running on Node. This module walks
 * a prioritised candidate list and returns the first executable path,
 * falling back to literal `'node'` if nothing matches.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface NodeResolverContext {
  env: Record<string, string | undefined>;
  execPath?: string;
  argv0?: string;
  homeDir?: string;
  isExecutable: (filePath: string) => boolean;
}

export function isExecutableFile(filePath: string | undefined | null): boolean {
  if (!filePath) return false;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function resolveBinaryOnPath(
  binary: string,
  envPath: string | undefined,
  isExec: (filePath: string) => boolean = isExecutableFile,
): string | null {
  if (!envPath) return null;
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    if (isExec(candidate)) return candidate;
  }
  return null;
}

function hasNodeBasename(filePath: string | undefined): filePath is string {
  if (!filePath) return false;
  const basename = path.basename(filePath.replace(/\\/g, '/')).toLowerCase();
  return (
    basename === 'node' || basename === 'nodejs' || basename === 'node.exe'
  );
}

export function buildNodeCandidates(ctx: NodeResolverContext): string[] {
  const home = ctx.homeDir ?? '';
  const raw: (string | null | undefined)[] = [
    // process.execPath / argv0 can point at non-Node runtimes such as Bun,
    // so only trust them when the executable basename is a Node binary name.
    hasNodeBasename(ctx.execPath) ? ctx.execPath : null,
    hasNodeBasename(ctx.argv0) ? ctx.argv0 : null,
    ctx.env.npm_node_execpath,
    ctx.env.NVM_BIN ? path.join(ctx.env.NVM_BIN, 'node') : null,
    ctx.env.FNM_MULTISHELL_PATH
      ? path.join(ctx.env.FNM_MULTISHELL_PATH, 'bin', 'node')
      : null,
    ctx.env.VOLTA_HOME ? path.join(ctx.env.VOLTA_HOME, 'bin', 'node') : null,
    resolveBinaryOnPath('node', ctx.env.PATH, ctx.isExecutable),
    home
      ? path.join(
          home,
          '.local',
          'share',
          'fnm',
          'aliases',
          'default',
          'bin',
          'node',
        )
      : null,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ];
  return raw.filter((c): c is string => typeof c === 'string' && c.length > 0);
}

export function resolveNodeBinary(ctx: NodeResolverContext): string {
  for (const candidate of buildNodeCandidates(ctx)) {
    if (ctx.isExecutable(candidate)) return candidate;
  }
  return 'node';
}

export function resolveHostNodeBinary(
  env: Record<string, string | undefined> = process.env,
): string {
  return resolveNodeBinary({
    env,
    execPath: process.execPath,
    argv0: process.argv[0],
    homeDir: os.homedir(),
    isExecutable: isExecutableFile,
  });
}
