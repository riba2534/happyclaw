import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { ContainerInput, ContainerOutput, StreamEvent } from './types.js';

interface RunCodexQueryOptions {
  prompt: string;
  sessionId?: string;
  containerInput: ContainerInput;
  images?: Array<{ data: string; mimeType?: string }>;
  workspaceGroup: string;
  workspaceGlobal: string;
  workspaceMemory: string;
  workspaceIpc: string;
  claudeConfigDir?: string;
  codexModel?: string;
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  codexAuthJson?: string;
  writeOutput: (output: ContainerOutput) => void;
  log: (message: string) => void;
  shouldClose: () => boolean;
  shouldInterrupt: () => boolean;
  clearInterruptRequested: () => void;
}

interface CodexQueryResult {
  newSessionId?: string;
  closedDuringQuery: boolean;
  interruptedDuringQuery: boolean;
  sessionResumeFailed?: boolean;
}

function isCodexResumeFailure(stderrText: string): boolean {
  const text = stderrText.toLowerCase();
  return (
    text.includes('thread/resume failed') ||
    text.includes('no rollout found') ||
    text.includes('no conversation found') ||
    text.includes('failed to resume')
  );
}

function writeCodexConfig(
  codexHome: string,
  options: { model?: string; openaiBaseUrl?: string },
): void {
  fs.mkdirSync(codexHome, { recursive: true });
  const lines: string[] = [];
  if (options.model) {
    lines.push(`model = ${JSON.stringify(options.model)}`);
  }
  if (options.openaiBaseUrl) {
    lines.push(`openai_base_url = ${JSON.stringify(options.openaiBaseUrl)}`);
  }
  if (lines.length > 0) {
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      lines.join('\n') + '\n',
      'utf8',
    );
  }
}

function writeCodexAuth(
  codexHome: string,
  codexAuthJson?: string,
): void {
  if (!codexAuthJson?.trim()) return;
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, 'auth.json'),
    codexAuthJson.trim() + '\n',
    { encoding: 'utf8', mode: 0o600 },
  );
}

function materializeImages(
  images: Array<{ data: string; mimeType?: string }> | undefined,
): { paths: string[]; cleanup: () => void } {
  if (!images || images.length === 0) {
    return { paths: [], cleanup: () => {} };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-codex-'));
  const paths: string[] = [];

  for (const [index, image] of images.entries()) {
    const ext =
      image.mimeType === 'image/png'
        ? '.png'
        : image.mimeType === 'image/webp'
          ? '.webp'
          : image.mimeType === 'image/gif'
            ? '.gif'
            : '.jpg';
    const filePath = path.join(tempDir, `image-${index + 1}${ext}`);
    fs.writeFileSync(filePath, Buffer.from(image.data, 'base64'));
    paths.push(filePath);
  }

  return {
    paths,
    cleanup: () => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function decorateEvent(
  event: StreamEvent,
  containerInput: ContainerInput,
  sessionId?: string,
): StreamEvent {
  return {
    ...event,
    turnId: containerInput.turnId,
    sessionId,
  };
}

export async function runCodexQuery(
  options: RunCodexQueryOptions,
): Promise<CodexQueryResult> {
  const codexHome = path.join(
    path.dirname(options.claudeConfigDir || path.join(os.homedir(), '.claude')),
    '.codex',
  );
  writeCodexConfig(codexHome, {
    model: options.codexModel,
    openaiBaseUrl: options.openaiBaseUrl,
  });
  writeCodexAuth(codexHome, options.codexAuthJson);

  const imageFiles = materializeImages(options.images);
  const isResume = !!options.sessionId?.trim();
  const args = isResume ? ['exec', 'resume'] : ['exec'];

  args.push('--json');
  args.push('--skip-git-repo-check');
  args.push('--dangerously-bypass-approvals-and-sandbox');
  // `codex exec` supports extra writable dirs, but `codex exec resume` does not.
  // Passing them to resume causes Codex to reject the command and exit before any output.
  if (!isResume) {
    args.push('--add-dir', options.workspaceGlobal);
    args.push('--add-dir', options.workspaceMemory);
    args.push('--add-dir', options.workspaceIpc);
  }
  for (const imagePath of imageFiles.paths) {
    args.push('-i', imagePath);
  }
  if (options.sessionId && options.sessionId.trim()) {
    args.push(options.sessionId);
  }
  args.push(options.prompt);

  let currentSessionId = options.sessionId;
  let latestAgentMessage: string | null = null;
  let stderrText = '';
  let closedDuringQuery = false;
  let interruptedDuringQuery = false;
  const startedAt = Date.now();

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: codexHome,
      ...(options.openaiApiKey || process.env.OPENAI_API_KEY
        ? { OPENAI_API_KEY: options.openaiApiKey || process.env.OPENAI_API_KEY || '' }
        : {}),
      ...(options.openaiBaseUrl ? { OPENAI_BASE_URL: options.openaiBaseUrl } : {}),
      ...(options.codexModel ? { HAPPYCLAW_CODEX_MODEL: options.codexModel } : {}),
    };

  return await new Promise<CodexQueryResult>((resolve, reject) => {
    const proc = spawn('codex', args, {
      cwd: options.workspaceGroup,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    let monitorTimer: NodeJS.Timeout | null = setInterval(() => {
      if (options.shouldClose()) {
        closedDuringQuery = true;
        options.log('Codex close sentinel detected, terminating process');
        proc.kill('SIGTERM');
      } else if (options.shouldInterrupt()) {
        interruptedDuringQuery = true;
        options.clearInterruptRequested();
        options.log('Codex interrupt sentinel detected, terminating process');
        options.writeOutput({
          status: 'stream',
          result: null,
          streamEvent: decorateEvent(
            { eventType: 'status', statusText: 'interrupted' },
            options.containerInput,
            currentSessionId,
          ),
          turnId: options.containerInput.turnId,
          sessionId: currentSessionId,
        });
        proc.kill('SIGINT');
      }
    }, 300);

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrText += text;
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) options.log(`[codex] ${trimmed}`);
      }
    });

    proc.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line) {
          const event = parseJsonLine(line);
          if (event) {
            const type = String(event.type || '');
            if (type === 'thread.started' && typeof event.thread_id === 'string') {
              currentSessionId = event.thread_id;
            } else if (type === 'item.started') {
              const item = event.item as Record<string, unknown> | undefined;
              if (item?.type === 'command_execution') {
                options.writeOutput({
                  status: 'stream',
                  result: null,
                  streamEvent: decorateEvent(
                    {
                      eventType: 'tool_use_start',
                      toolName: 'Bash',
                      toolUseId: String(item.id || ''),
                      toolInputSummary: String(item.command || ''),
                    },
                    options.containerInput,
                    currentSessionId,
                  ),
                  turnId: options.containerInput.turnId,
                  sessionId: currentSessionId,
                });
              }
            } else if (type === 'item.completed') {
              const item = event.item as Record<string, unknown> | undefined;
              if (item?.type === 'agent_message' && typeof item.text === 'string') {
                latestAgentMessage = item.text;
              } else if (item?.type === 'command_execution') {
                const toolUseId = String(item.id || '');
                const aggregatedOutput = String(item.aggregated_output || '').trim();
                if (aggregatedOutput) {
                  options.writeOutput({
                    status: 'stream',
                    result: null,
                    streamEvent: decorateEvent(
                      {
                        eventType: 'tool_progress',
                        toolUseId,
                        statusText: aggregatedOutput.slice(0, 400),
                      },
                      options.containerInput,
                      currentSessionId,
                    ),
                    turnId: options.containerInput.turnId,
                    sessionId: currentSessionId,
                  });
                }
                options.writeOutput({
                  status: 'stream',
                  result: null,
                  streamEvent: decorateEvent(
                    { eventType: 'tool_use_end', toolUseId },
                    options.containerInput,
                    currentSessionId,
                  ),
                  turnId: options.containerInput.turnId,
                  sessionId: currentSessionId,
                });
              }
            } else if (type === 'turn.completed') {
              const usage = event.usage as Record<string, unknown> | undefined;
              if (usage) {
                options.writeOutput({
                  status: 'stream',
                  result: null,
                  streamEvent: decorateEvent(
                    {
                      eventType: 'usage',
                      usage: {
                        inputTokens: Number(usage.input_tokens || 0),
                        outputTokens: Number(usage.output_tokens || 0),
                        cacheReadInputTokens: Number(usage.cached_input_tokens || 0),
                        cacheCreationInputTokens: 0,
                        costUSD: 0,
                        durationMs: Date.now() - startedAt,
                        numTurns: 1,
                        modelUsage: options.codexModel
                          ? {
                              [options.codexModel]: {
                                inputTokens: Number(usage.input_tokens || 0),
                                outputTokens: Number(usage.output_tokens || 0),
                                costUSD: 0,
                              },
                            }
                          : undefined,
                      },
                    },
                    options.containerInput,
                    currentSessionId,
                  ),
                  turnId: options.containerInput.turnId,
                  sessionId: currentSessionId,
                });
              }
            }
          }
        }
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    });

    proc.on('error', (err) => {
      if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
      }
      imageFiles.cleanup();
      reject(err);
    });

    proc.on('close', (code) => {
      if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
      }
      imageFiles.cleanup();

      if (interruptedDuringQuery || closedDuringQuery) {
        resolve({
          newSessionId: currentSessionId,
          closedDuringQuery,
          interruptedDuringQuery,
        });
        return;
      }

      if (code !== 0) {
        reject(new Error(`Codex exited with code ${code}`));
        return;
      }

      if (!latestAgentMessage?.trim()) {
        if (isResume && isCodexResumeFailure(stderrText)) {
          resolve({
            newSessionId: undefined,
            closedDuringQuery: false,
            interruptedDuringQuery: false,
            sessionResumeFailed: true,
          });
          return;
        }
        const stderrSummary = stderrText.trim();
        const detail = stderrSummary
          ? `Codex completed without an assistant message. stderr: ${stderrSummary}`
          : 'Codex completed without an assistant message.';
        reject(new Error(detail));
        return;
      }

      options.writeOutput({
        status: 'success',
        result: latestAgentMessage,
        newSessionId: currentSessionId,
        turnId: options.containerInput.turnId,
        sessionId: currentSessionId,
        sourceKind: 'sdk_final',
        finalizationReason: 'completed',
      });

      resolve({
        newSessionId: currentSessionId,
        closedDuringQuery: false,
        interruptedDuringQuery: false,
      });
    });
  });
}
