import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface CodexDependencyStatus {
  sdk: {
    available: boolean;
    packageName: '@openai/codex-sdk';
    error?: string;
  };
  cli: {
    available: boolean;
    path: string | null;
    version: string | null;
    supportsExecRequiredFlags?: boolean;
    error?: string;
  };
}

const CODEX_APP_CLI = '/Applications/Codex.app/Contents/Resources/codex';

export async function findCodexCli(): Promise<string | null> {
  if (process.env.CODEX_CLI_PATH && fs.existsSync(process.env.CODEX_CLI_PATH)) {
    return process.env.CODEX_CLI_PATH;
  }
  if (fs.existsSync(CODEX_APP_CLI)) return CODEX_APP_CLI;
  try {
    const { stdout } = await execFileAsync('sh', ['-lc', 'command -v codex'], {
      timeout: 3000,
    });
    const found = stdout.trim().split('\n')[0];
    return found || null;
  } catch {
    return null;
  }
}

async function probeSdk(): Promise<CodexDependencyStatus['sdk']> {
  try {
    const dynamicImport = new Function(
      'specifier',
      'return import(specifier)',
    ) as (specifier: string) => Promise<unknown>;
    await dynamicImport('@openai/codex-sdk');
    return { available: true, packageName: '@openai/codex-sdk' };
  } catch (err) {
    return {
      available: false,
      packageName: '@openai/codex-sdk',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeCli(): Promise<CodexDependencyStatus['cli']> {
  const cliPath = await findCodexCli();
  if (!cliPath) {
    return {
      available: false,
      path: null,
      version: null,
      error: 'Codex CLI executable not found',
    };
  }
  try {
    const { stdout, stderr } = await execFileAsync(cliPath, ['--version'], {
      timeout: 5000,
    });
    const version = (stdout || stderr).trim().split('\n')[0] || null;
    const help = await execFileAsync(cliPath, ['exec', '--help'], {
      timeout: 5000,
    });
    const helpText = `${help.stdout}\n${help.stderr}`;
    const requiredFlags = [
      '--json',
      '--cd',
      '--sandbox',
      '--skip-git-repo-check',
      '--output-last-message',
      '--image',
    ];
    const missingFlags = requiredFlags.filter((flag) => !helpText.includes(flag));
    if (missingFlags.length > 0) {
      return {
        available: false,
        path: cliPath,
        version,
        supportsExecRequiredFlags: false,
        error: `Codex CLI exec is missing required flags: ${missingFlags.join(', ')}`,
      };
    }
    return {
      available: true,
      path: cliPath,
      version,
      supportsExecRequiredFlags: true,
    };
  } catch (err) {
    return {
      available: false,
      path: cliPath,
      version: null,
      supportsExecRequiredFlags: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function probeCodexDependencies(): Promise<CodexDependencyStatus> {
  const [sdk, cli] = await Promise.all([probeSdk(), probeCli()]);
  return { sdk, cli };
}

export function defaultCodexHome(providerId: string): string {
  return path.join(os.homedir(), '.happyclaw', 'codex', providerId);
}
