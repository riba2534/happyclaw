import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  buildClaudeEnvLines,
  getClaudeProviderConfig,
  getCodexProviderConfig,
  getPrimaryProvider,
  providerToCodexConfig,
} from './runtime-config.js';
import { logger } from './logger.js';

// Mutex: process.env mutation is not re-entrant. Serialize concurrent calls
// to prevent overlapping env writes from corrupting each other.
let envLock: Promise<void> = Promise.resolve();

async function runCodexSdkQuery(
  prompt: string,
  opts?: { model?: string; timeout?: number },
  configOverride?: {
    openaiBaseUrl: string;
    openaiApiKey: string;
    codexAuthJson: string;
    codexModel: string;
    updatedAt: string | null;
  } | null,
): Promise<string | null> {
  const provider = getPrimaryProvider();
  const config =
    configOverride ||
    (provider?.runtime === 'codex' ? providerToCodexConfig(provider) : null);
  if (!config || (!config.openaiApiKey && !config.codexAuthJson)) return null;

  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-sdk-codex-'));
  try {
    const configLines: string[] = [];
    if (opts?.model || config.codexModel) {
      configLines.push(`model = ${JSON.stringify(opts?.model || config.codexModel)}`);
    }
    if (config.openaiBaseUrl) {
      configLines.push(`openai_base_url = ${JSON.stringify(config.openaiBaseUrl)}`);
    }
    if (configLines.length > 0) {
      fs.writeFileSync(path.join(codexHome, 'config.toml'), configLines.join('\n') + '\n', 'utf8');
    }
    if (config.codexAuthJson) {
      fs.writeFileSync(
        path.join(codexHome, 'auth.json'),
        config.codexAuthJson.trim() + '\n',
        { encoding: 'utf8', mode: 0o600 },
      );
    }

    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--ephemeral',
      prompt,
    ];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: codexHome,
      ...(config.openaiApiKey ? { OPENAI_API_KEY: config.openaiApiKey } : {}),
      ...(config.openaiBaseUrl ? { OPENAI_BASE_URL: config.openaiBaseUrl } : {}),
    };

    return await new Promise<string | null>((resolve) => {
      const proc = spawn('codex', args, {
        cwd: process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let latestMessage: string | null = null;
      let stdoutBuffer = '';
      const timer = setTimeout(() => proc.kill('SIGTERM'), opts?.timeout ?? 60_000);

      proc.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();
        let newlineIdx = stdoutBuffer.indexOf('\n');
        while (newlineIdx !== -1) {
          const line = stdoutBuffer.slice(0, newlineIdx).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
          if (line) {
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              if (parsed.type === 'item.completed') {
                const item = parsed.item as Record<string, unknown> | undefined;
                if (item?.type === 'agent_message' && typeof item.text === 'string') {
                  latestMessage = item.text;
                }
              }
            } catch {
              /* ignore non-json lines */
            }
          }
          newlineIdx = stdoutBuffer.indexOf('\n');
        }
      });

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) logger.debug({ stderr: text.slice(0, 300) }, 'codex sdkQuery stderr');
      });

      proc.on('close', () => {
        clearTimeout(timer);
        resolve(latestMessage?.trim() || null);
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        logger.warn({ err: err.message.slice(0, 200) }, 'codex sdkQuery failed');
        resolve(null);
      });
    });
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
}

/**
 * Send a prompt to the configured agent runtime and return the plain-text response.
 * Uses the provider configured in the web settings (not a separate CLI install).
 *
 * @param prompt  The user prompt text
 * @param opts.model   Override model (defaults to provider config)
 * @param opts.timeout Timeout in ms (default 60 000)
 * @returns The assistant's text response, or null on failure
 */
export async function sdkQuery(
  prompt: string,
  opts?: { model?: string; timeout?: number },
): Promise<string | null> {
  const primaryProvider = getPrimaryProvider();
  if (primaryProvider?.runtime === 'codex') {
    return runCodexSdkQuery(prompt, opts);
  }
  if (!primaryProvider) {
    const codexConfig = getCodexProviderConfig();
    if (codexConfig.openaiApiKey) {
      return runCodexSdkQuery(prompt, opts, codexConfig);
    }
  }

  // Chain on the lock so only one sdkQuery touches process.env at a time
  let release: () => void;
  const acquired = new Promise<void>((r) => (release = r));
  const prevLock = envLock;
  envLock = acquired;
  await prevLock;

  const timeout = opts?.timeout ?? 60_000;

  // Inject provider credentials into process.env for the SDK
  const config = getClaudeProviderConfig();
  const envLines = buildClaudeEnvLines(config);
  const savedEnv: Record<string, string | undefined> = {};
  for (const line of envLines) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeout);

  try {
    const model = opts?.model || config.anthropicModel || undefined;

    let result = '';
    const conversation = query({
      prompt,
      options: {
        ...(model && { model }),
        maxTurns: 1,
        allowedTools: [],
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        abortController,
      },
    });

    for await (const event of conversation) {
      if (event.type === 'result' && event.subtype === 'success') {
        result = event.result;
      }
    }

    return result.trim() || null;
  } catch (err) {
    logger.warn({ err: (err as Error).message?.slice(0, 200) }, 'sdkQuery failed');
    return null;
  } finally {
    clearTimeout(timer);
    // Restore original env
    for (const [key, original] of Object.entries(savedEnv)) {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    release!();
  }
}
