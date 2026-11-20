/**
 * Standalone AGY Runner entrypoint (Host mode).
 *
 * Implements the exact HappyClaw Runner process contract:
 *   - Reads ContainerInput JSON from stdin until EOF.
 *   - Spawns a persistent `agy --input-format stream-json --output-format stream-json`
 *     child process in the workspace cwd.
 *   - Emits OUTPUT_START_MARKER / OUTPUT_END_MARKER JSON frames on stdout.
 *   - Polls HAPPYCLAW_WORKSPACE_IPC/input for warm follow-up turns and
 *     `_close` / `_drain` sentinels.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { buildFreshSessionInstructions } from './instructions.js';
import {
  ensureAgyWorkspaceMcpConfig,
  syncAgyWorkspaceSkills,
} from './mcp-config.js';
import { DEFAULT_AGY_MODEL, resolveAgyBinary } from './models.js';
import {
  AgyStreamTranslator,
  OUTPUT_END_MARKER,
  OUTPUT_START_MARKER,
  formatAgyUserEvent,
  type AgyRunnerOutputFrame,
} from './protocol.js';

interface AgyRunnerInput {
  prompt: string;
  sessionId?: string;
  launchEffort?: string | null;
  queryRunId?: string;
  turnId?: string;
  currentSourceJid?: string;
  groupFolder: string;
  chatJid: string;
  agentId?: string;
  interactionMode?: 'assistant' | 'proactive' | string;
  hostIdleCloseMs?: number;
  workspaceMemoryMutationSigningSecret?: string;
  workspaceMemoryRunnerInstanceId?: string;
  images?: Array<{ data: string; mimeType?: string }>;
  agentProfile?: {
    identityPrompt?: string;
  };
}

interface QueuedTurn {
  prompt: string;
  images?: Array<{ data: string; mimeType?: string }>;
  queryRunId?: string;
  turnId?: string;
  inputTurnId?: string;
  sourceJid?: string;
  ipcReceipts?: unknown[];
}

const WORKSPACE_IPC = process.env.HAPPYCLAW_WORKSPACE_IPC || '/workspace/ipc';
const IPC_INPUT_DIR = path.join(WORKSPACE_IPC, 'input');
const IPC_MESSAGES_DIR = path.join(WORKSPACE_IPC, 'messages');
const IPC_MESSAGE_RESULTS_DIR = path.join(WORKSPACE_IPC, 'message-results');
const TURN_CONTEXT_FILE = path.join(WORKSPACE_IPC, '.agy-turn-context.json');
const FINAL_SENT_FILE = path.join(WORKSPACE_IPC, '.agy-final-sent.json');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_INPUT_DRAIN_SENTINEL = path.join(IPC_INPUT_DIR, '_drain');
const IPC_INPUT_INTERRUPT_SENTINEL = path.join(IPC_INPUT_DIR, '_interrupt');
const IPC_INPUT_INTERRUPT_REASON_SENTINEL = path.join(
  IPC_INPUT_DIR,
  '_interrupt_reason',
);
const IPC_POLL_MS = 500;

function writeTurnContextFile(
  input: AgyRunnerInput,
  inputTurnId?: string,
  sourceJid?: string,
  sessionId?: string,
): void {
  try {
    const tmp = `${TURN_CONTEXT_FILE}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        chatJid: input.chatJid,
        groupFolder: input.groupFolder,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        interactionMode:
          input.interactionMode === 'proactive' ? 'proactive' : 'assistant',
        ...(inputTurnId ? { inputTurnId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(sourceJid ? { sourceJid } : {}),
        ...(input.workspaceMemoryRunnerInstanceId
          ? {
              workspaceMemoryRunnerInstanceId:
                input.workspaceMemoryRunnerInstanceId,
            }
          : {}),
        ...(input.workspaceMemoryMutationSigningSecret
          ? {
              workspaceMemoryMutationSigningSecret:
                input.workspaceMemoryMutationSigningSecret,
            }
          : {}),
      }),
      { mode: 0o600 },
    );
    fs.renameSync(tmp, TURN_CONTEXT_FILE);
  } catch {
    // best effort
  }
}

function cleanupTurnContextFile(): void {
  try {
    if (fs.existsSync(TURN_CONTEXT_FILE)) fs.unlinkSync(TURN_CONTEXT_FILE);
  } catch {
    // ignore
  }
}

function consumeInterruptForQuery(
  activeQueryRunId?: string,
): { reason: 'stop' | 'steer' } | null {
  if (!fs.existsSync(IPC_INPUT_INTERRUPT_SENTINEL)) return null;
  let content = '';
  try {
    content = fs.readFileSync(IPC_INPUT_INTERRUPT_SENTINEL, 'utf-8').trim();
  } catch {
    return null;
  }
  if (content && activeQueryRunId && content !== activeQueryRunId) {
    return null;
  }
  try {
    fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL);
  } catch {
    // ignore
  }
  let reason: 'stop' | 'steer' = 'steer';
  try {
    const raw = JSON.parse(
      fs.readFileSync(IPC_INPUT_INTERRUPT_REASON_SENTINEL, 'utf-8'),
    ) as { queryId?: unknown; reason?: unknown };
    if (!content || raw.queryId === content) {
      if (raw.reason === 'stop') reason = 'stop';
      fs.unlinkSync(IPC_INPUT_INTERRUPT_REASON_SENTINEL);
    }
  } catch {
    // no reason file -> default steer
  }
  return { reason };
}

function clearFinalSentMarker(): void {
  try {
    if (fs.existsSync(FINAL_SENT_FILE)) fs.unlinkSync(FINAL_SENT_FILE);
  } catch {
    // ignore
  }
}

function wasProactiveFinalAlreadySent(inputTurnId?: string): boolean {
  try {
    if (!fs.existsSync(FINAL_SENT_FILE)) return false;
    const raw = JSON.parse(fs.readFileSync(FINAL_SENT_FILE, 'utf-8')) as {
      inputTurnId?: string | null;
    };
    if (!inputTurnId) return true;
    return raw.inputTurnId === inputTurnId;
  } catch {
    return false;
  }
}

async function publishProactiveFinalMessage(
  input: AgyRunnerInput,
  text: string,
  inputTurnId?: string,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    fs.mkdirSync(IPC_MESSAGES_DIR, { recursive: true });
    const requestId = `agy-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const payload: Record<string, unknown> = {
      type: 'message',
      chatJid: input.chatJid,
      groupFolder: input.groupFolder,
      timestamp: new Date().toISOString(),
      text: trimmed,
      deliveryRole: 'final',
      presentation: 'native',
      interactionMode: 'proactive',
      requestId,
      ...(inputTurnId ? { inputTurnId } : {}),
    };
    const fileName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
    const tmpPath = path.join(IPC_MESSAGES_DIR, `${fileName}.tmp`);
    const finalPath = path.join(IPC_MESSAGES_DIR, fileName);
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
    fs.renameSync(tmpPath, finalPath);

    // Wait briefly for the host IPC watcher to acknowledge delivery so the
    // terminal ContainerOutput lands after nativeDelivered is recorded.
    const resultFile = path.join(
      IPC_MESSAGE_RESULTS_DIR,
      `send_message_result_${requestId}.json`,
    );
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(resultFile)) {
        try {
          fs.unlinkSync(resultFile);
        } catch {
          // ignore
        }
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  } catch (err) {
    log(
      `Failed to publish proactive final IPC message: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function log(message: string): void {
  process.stderr.write(`[agy-runner] ${message}\n`);
}

function writeOutput(frame: AgyRunnerOutputFrame): void {
  process.stdout.write(
    `${OUTPUT_START_MARKER}\n${JSON.stringify(frame)}\n${OUTPUT_END_MARKER}\n`,
  );
}

async function readStdinAll(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function consumeSentinel(sentinelPath: string): boolean {
  if (!fs.existsSync(sentinelPath)) return false;
  try {
    fs.unlinkSync(sentinelPath);
  } catch {
    // ignore
  }
  return true;
}

function shouldClose(): boolean {
  return consumeSentinel(IPC_INPUT_CLOSE_SENTINEL);
}

function shouldDrain(): boolean {
  return consumeSentinel(IPC_INPUT_DRAIN_SENTINEL);
}

function saveImagesToIpc(
  images: Array<{ data: string; mimeType?: string }> | undefined,
): string[] {
  if (!images || images.length === 0) return [];
  const imgDir = path.join(WORKSPACE_IPC, 'agy-images');
  fs.mkdirSync(imgDir, { recursive: true });
  const savedPaths: string[] = [];

  for (const img of images) {
    if (!img?.data) continue;
    const ext =
      img.mimeType === 'image/png'
        ? 'png'
        : img.mimeType === 'image/webp'
          ? 'webp'
          : img.mimeType === 'image/gif'
            ? 'gif'
            : 'jpg';
    const filePath = path.join(
      imgDir,
      `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`,
    );
    try {
      fs.writeFileSync(filePath, Buffer.from(img.data, 'base64'));
      savedPaths.push(filePath);
    } catch (err) {
      log(
        `Failed to materialize image attachment: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return savedPaths;
}

function buildTurnPrompt(
  prompt: string,
  images?: Array<{ data: string; mimeType?: string }>,
  identityPromptPrefix?: string,
): string {
  const parts: string[] = [];
  if (identityPromptPrefix?.trim()) {
    parts.push(
      `<system_instructions>\n${identityPromptPrefix.trim()}\n</system_instructions>`,
    );
  }
  parts.push(prompt);

  const imagePaths = saveImagesToIpc(images);
  if (imagePaths.length > 0) {
    const list = imagePaths.map((p) => `- ${p}`).join('\n');
    parts.push(
      `[用户附带了以下图片文件，请使用 view_file 工具查看后再回答]\n${list}`,
    );
  }

  return parts.join('\n\n');
}

function drainIpcMessages(): QueuedTurn[] {
  const turns: QueuedTurn[] = [];
  try {
    if (!fs.existsSync(IPC_INPUT_DIR)) return turns;
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .sort();

    for (const file of files) {
      const fullPath = path.join(IPC_INPUT_DIR, file);
      try {
        const raw = fs.readFileSync(fullPath, 'utf-8');
        fs.unlinkSync(fullPath);
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (
          data.type === 'message' &&
          typeof data.text === 'string' &&
          data.text
        ) {
          const receipt =
            data.receipt && typeof data.receipt === 'object'
              ? (data.receipt as Record<string, unknown>)
              : undefined;
          const deliveryId =
            typeof receipt?.deliveryId === 'string'
              ? receipt.deliveryId
              : undefined;
          turns.push({
            prompt: data.text,
            images: Array.isArray(data.images)
              ? (data.images as Array<{ data: string; mimeType?: string }>)
              : undefined,
            queryRunId:
              typeof data.queryRunId === 'string' ? data.queryRunId : undefined,
            inputTurnId: deliveryId,
            sourceJid:
              typeof data.sourceJid === 'string' ? data.sourceJid : undefined,
            ...(receipt ? { ipcReceipts: [receipt] } : {}),
          });
        }
      } catch (err) {
        log(
          `Skipping unreadable IPC message ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(fullPath);
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  return turns;
}

function waitForNextIpcTurn(
  idleCloseMs?: number,
  onCancelRegister?: (cancel: () => void) => void,
): Promise<QueuedTurn | null> {
  return new Promise((resolve) => {
    let settled = false;
    let watcher: fs.FSWatcher | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (turn: QueuedTurn | null) => {
      if (settled) return;
      settled = true;
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
      }
      if (pollTimer) clearInterval(pollTimer);
      if (idleTimer) clearTimeout(idleTimer);
      resolve(turn);
    };

    onCancelRegister?.(() => finish(null));

    const check = () => {
      if (shouldClose() || shouldDrain()) {
        finish(null);
        return;
      }
      const turns = drainIpcMessages();
      if (turns.length > 0) {
        // Merge multiple queued messages into one turn if they arrived together
        if (turns.length === 1) {
          finish(turns[0]);
        } else {
          const mergedPrompt = turns.map((t) => t.prompt).join('\n\n');
          const mergedImages = turns.flatMap((t) => t.images ?? []);
          const mergedReceipts = turns.flatMap((t) => t.ipcReceipts ?? []);
          const last = turns[turns.length - 1];
          finish({
            prompt: mergedPrompt,
            images: mergedImages.length > 0 ? mergedImages : undefined,
            queryRunId: last.queryRunId,
            inputTurnId: last.inputTurnId,
            ...(mergedReceipts.length > 0
              ? { ipcReceipts: mergedReceipts }
              : {}),
          });
        }
      }
    };

    try {
      fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
      watcher = fs.watch(IPC_INPUT_DIR, () => check());
      watcher.on('error', () => {
        // fallback polling handles it
      });
    } catch {
      // fallback polling handles it
    }

    pollTimer = setInterval(check, IPC_POLL_MS);
    if (idleCloseMs && idleCloseMs > 0) {
      idleTimer = setTimeout(() => {
        log(`Idle timeout (${idleCloseMs}ms) reached; closing agy-runner`);
        finish(null);
      }, idleCloseMs);
    }

    check();
  });
}

async function main(): Promise<void> {
  let input: AgyRunnerInput;
  try {
    const raw = await readStdinAll();
    input = JSON.parse(raw) as AgyRunnerInput;
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse runner stdin: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  const agyBin = resolveAgyBinary(process.env);
  const rawModel =
    process.env.HAPPYCLAW_AGY_MODEL?.trim() ||
    process.env.ANTHROPIC_MODEL?.trim() ||
    DEFAULT_AGY_MODEL;
  const model =
    rawModel.replace(/(?:\[1m\])+$/i, '').trim() || DEFAULT_AGY_MODEL;
  const effort =
    process.env.HAPPYCLAW_AGY_EFFORT?.trim() ||
    input.launchEffort?.trim() ||
    undefined;

  const args = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--dangerously-skip-permissions',
    '--model',
    model,
  ];
  // Only pass --effort when the model slug itself does not already encode a level
  if (effort && !/-(low|medium|high|xhigh|max)$/i.test(model)) {
    args.push('--effort', effort);
  }
  if (input.sessionId) {
    args.push('--conversation', input.sessionId);
  }

  // Register HappyClaw's stdio MCP bridge in `<workspace>/.agents/mcp_config.json`
  const mcpServerEntrypoint = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    'mcp-server.js',
  );
  if (fs.existsSync(mcpServerEntrypoint)) {
    try {
      ensureAgyWorkspaceMcpConfig({
        workspaceDir: process.cwd(),
        nodeBinary: process.execPath,
        mcpServerEntrypoint,
      });
    } catch (err) {
      log(
        `Failed to register HappyClaw MCP config: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Mirror HappyClaw's effective skills into `<workspace>/.agents/skills/`
  try {
    const { synced, pruned } = syncAgyWorkspaceSkills({
      workspaceDir: process.cwd(),
      claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
    });
    if (synced > 0 || pruned > 0) {
      log(
        `Synced workspace skills for agy: synced=${synced}, pruned=${pruned}`,
      );
    }
  } catch (err) {
    log(
      `Failed to sync workspace skills for agy: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const agyHome = process.env.HAPPYCLAW_AGY_HOME?.trim();
  log(
    `Spawning ${agyBin} ${args.join(' ')}${agyHome ? ` (isolated HOME)` : ''}`,
  );

  const child: ChildProcess = spawn(agyBin, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(agyHome ? { HOME: agyHome } : {}),
      HAPPYCLAW_CHAT_JID: input.chatJid,
      HAPPYCLAW_GROUP_FOLDER: input.groupFolder,
      HAPPYCLAW_INTERACTION_MODE:
        input.interactionMode === 'proactive' ? 'proactive' : 'assistant',
    },
  });

  const translator = new AgyStreamTranslator(input.sessionId, model);
  let childExited = false;
  let childExitError: string | null = null;
  let stderrTail = '';

  let turnDoneResolver: (() => void) | null = null;
  let cancelIdleWait: (() => void) | null = null;
  const waitForTurnResult = (): Promise<void> =>
    new Promise((resolve) => {
      if (childExited) {
        resolve();
        return;
      }
      turnDoneResolver = resolve;
    });

  const signalTurnDone = () => {
    if (turnDoneResolver) {
      const fn = turnDoneResolver;
      turnDoneResolver = null;
      fn();
    }
  };

  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
    process.stderr.write(chunk);
  });

  child.on('error', (err) => {
    childExited = true;
    childExitError = `Failed to spawn agy (${agyBin}): ${err.message}`;
    log(childExitError);
    signalTurnDone();
    cancelIdleWait?.();
  });

  child.on('exit', (code, signal) => {
    childExited = true;
    if (code !== 0 && code !== null) {
      childExitError =
        stderrTail.trim() ||
        `agy exited with code ${code}${signal ? ` (signal ${signal})` : ''}`;
    }
    signalTurnDone();
    cancelIdleWait?.();
  });

  const rl = readline.createInterface({
    input: child.stdout!,
    crlfDelay: Infinity,
  });

  let receivedResultForCurrentTurn = false;
  let lastTurnStatus: 'success' | 'error' | null = null;
  let activeInputTurnId: string | undefined;
  let pendingTerminalFrame: AgyRunnerOutputFrame | null = null;

  rl.on('line', (line) => {
    const frames = translator.translateLine(line);
    for (const frame of frames) {
      if (frame.status === 'success' || frame.status === 'error') {
        pendingTerminalFrame = frame;
        receivedResultForCurrentTurn = true;
        lastTurnStatus = frame.status;
        signalTurnDone();
      } else {
        writeOutput(frame);
      }
    }
  });

  const shutdownChild = () => {
    if (childExited) return;
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (!childExited) {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }, 1500);
  };

  process.on('SIGTERM', () => {
    cleanupTurnContextFile();
    shutdownChild();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    cleanupTurnContextFile();
    shutdownChild();
    process.exit(0);
  });

  // Run initial turn + warm follow-up turns
  let currentTurn: QueuedTurn | null = {
    prompt: input.prompt,
    images: input.images,
    queryRunId: input.queryRunId,
    turnId: input.turnId,
    inputTurnId: input.turnId,
    sourceJid: input.currentSourceJid,
  };
  let isFirstTurn = true;

  while (currentTurn && !childExited) {
    receivedResultForCurrentTurn = false;
    lastTurnStatus = null;
    pendingTerminalFrame = null;
    activeInputTurnId = currentTurn.inputTurnId;
    clearFinalSentMarker();
    writeTurnContextFile(
      input,
      activeInputTurnId,
      currentTurn.sourceJid,
      translator.getSessionId(),
    );
    translator.setTurnCorrelation({
      queryRunId: currentTurn.queryRunId,
      turnId: currentTurn.turnId,
      inputTurnId: currentTurn.inputTurnId,
      ipcReceipts: currentTurn.ipcReceipts,
    });

    const identityPrefix =
      isFirstTurn && !input.sessionId
        ? buildFreshSessionInstructions({
            cwd: process.cwd(),
            claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
            identityPrompt: input.agentProfile?.identityPrompt,
          })
        : undefined;
    isFirstTurn = false;

    const fullPrompt = buildTurnPrompt(
      currentTurn.prompt,
      currentTurn.images,
      identityPrefix,
    );

    try {
      child.stdin!.write(formatAgyUserEvent(fullPrompt));
    } catch (err) {
      writeOutput({
        status: 'error',
        result: null,
        error: `Failed to write prompt to agy stdin: ${err instanceof Error ? err.message : String(err)}`,
        ...(currentTurn.queryRunId
          ? { queryRunId: currentTurn.queryRunId }
          : {}),
        inputTurnCompleted: true,
        queryIdle: true,
      });
      break;
    }

    // Watch for `_interrupt` (steer / stop) while the active turn is running
    let interruptedReason: 'stop' | 'steer' | null = null;
    let interruptWatcher: fs.FSWatcher | null = null;
    const checkInterrupt = () => {
      if (interruptedReason) return;
      const hit = consumeInterruptForQuery(currentTurn?.queryRunId);
      if (!hit) return;
      interruptedReason = hit.reason;
      log(
        `Interrupt (${hit.reason}) received for query ${currentTurn?.queryRunId ?? 'unknown'}; interrupting agy`,
      );
      try {
        child.kill('SIGINT');
      } catch {
        // ignore
      }
      signalTurnDone();
    };
    try {
      interruptWatcher = fs.watch(IPC_INPUT_DIR, () => checkInterrupt());
      interruptWatcher.on('error', () => {
        // fallback poll handles it
      });
    } catch {
      // fallback poll handles it
    }
    const interruptPoll = setInterval(checkInterrupt, 250);
    checkInterrupt();

    await waitForTurnResult();

    clearInterval(interruptPoll);
    if (interruptWatcher) {
      try {
        interruptWatcher.close();
      } catch {
        // ignore
      }
    }

    if (interruptedReason) {
      writeOutput({
        status: 'stream',
        result: null,
        ...(translator.getSessionId()
          ? { newSessionId: translator.getSessionId() }
          : {}),
        ...(currentTurn.queryRunId
          ? { queryRunId: currentTurn.queryRunId }
          : {}),
        ...(currentTurn.ipcReceipts?.length
          ? { ipcReceipts: currentTurn.ipcReceipts }
          : {}),
        queryIdle: true,
        streamEvent: {
          agentScope: 'main',
          eventType: 'status',
          statusText: 'interrupted',
          ...(currentTurn.queryRunId
            ? { queryRunId: currentTurn.queryRunId }
            : {}),
          ...(currentTurn.turnId ? { turnId: currentTurn.turnId } : {}),
          ...(currentTurn.inputTurnId
            ? { inputTurnId: currentTurn.inputTurnId }
            : {}),
          ...(translator.getSessionId()
            ? { sessionId: translator.getSessionId() }
            : {}),
        },
      });
      break;
    }

    if (pendingTerminalFrame) {
      const terminalFrame: AgyRunnerOutputFrame = pendingTerminalFrame;
      pendingTerminalFrame = null;
      if (
        terminalFrame.status === 'success' &&
        input.interactionMode === 'proactive' &&
        terminalFrame.result &&
        !wasProactiveFinalAlreadySent(activeInputTurnId)
      ) {
        await publishProactiveFinalMessage(
          input,
          terminalFrame.result,
          activeInputTurnId,
        );
      }
      writeOutput(terminalFrame);
    } else if (!receivedResultForCurrentTurn) {
      writeOutput({
        status: 'error',
        result: null,
        error: childExitError || 'agy process exited before returning a result',
        ...(translator.getSessionId()
          ? { newSessionId: translator.getSessionId() }
          : {}),
        ...(currentTurn.queryRunId
          ? { queryRunId: currentTurn.queryRunId }
          : {}),
        ...(currentTurn.ipcReceipts?.length
          ? { ipcReceipts: currentTurn.ipcReceipts }
          : {}),
        inputTurnCompleted: true,
        queryIdle: true,
      });
      break;
    }

    if (
      shouldDrain() ||
      shouldClose() ||
      childExited ||
      lastTurnStatus === 'error'
    ) {
      break;
    }

    currentTurn = await waitForNextIpcTurn(input.hostIdleCloseMs, (cancel) => {
      cancelIdleWait = cancel;
    });
    cancelIdleWait = null;
  }

  cleanupTurnContextFile();
  shutdownChild();
  rl.close();
}

main().catch((err) => {
  writeOutput({
    status: 'error',
    result: null,
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
