import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { OutputFrameScanner } from '../src/output-frame-scanner.js';
import { signWorkspaceMemoryMutation } from '../src/agy-runner/mcp-server.js';
import {
  OUTPUT_END_MARKER,
  OUTPUT_START_MARKER,
} from '../src/agy-runner/protocol.js';

const repoRoot = process.cwd();
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const agyRunnerEntry = path.join(repoRoot, 'src', 'agy-runner', 'index.ts');
const mcpServerEntry = path.join(
  repoRoot,
  'src',
  'agy-runner',
  'mcp-server.ts',
);

const scratchRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-agy-integration-'),
);
const fakeAgyPath = path.join(scratchRoot, 'fake-agy.mjs');

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: scratchRoot,
}));

const FAKE_AGY_SCRIPT = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);

if (args[0] === 'models') {
  process.stdout.write(
    'gemini-4-neon-medium   Gemini 4 Neon (Medium)\\n' +
    'claude-opus-5-5-high   Claude Opus 5.5 (High)\\n',
  );
  process.exit(0);
}

if (args[0] === '-p' && args[1] === '/usage') {
  const counterFile = process.env.FAKE_AGY_USAGE_COUNTER;
  if (counterFile) {
    const prev = fs.existsSync(counterFile)
      ? Number(fs.readFileSync(counterFile, 'utf-8') || '0')
      : 0;
    fs.writeFileSync(counterFile, String(prev + 1));
  }
  process.stdout.write(
    'Gemini Models\\tWeekly Limit Remaining\\t70%\\t2026-11-27T02:00:00Z\\n' +
    'Gemini Models\\tFive Hour Limit Remaining\\t45%\\t2026-11-20T12:00:00Z\\n',
  );
  process.exit(0);
}

if (args[0] === 'acp' && args[1] === '--login') {
  process.stdout.write(
    'Open this link in a browser:\\n\\n' +
    '  https://accounts.google.com/o/oauth2/auth?client_id=fake&state=xyz\\n\\n' +
    'Paste authorization code:\\n',
  );
  const rl = readline.createInterface({ input: process.stdin });
  rl.once('line', (line) => {
    const code = line.trim();
    rl.close();
    if (!code || code === 'INVALID_CODE') {
      process.stderr.write('Invalid authorization code\\n');
      process.exit(1);
    }
    const home = process.env.HOME;
    if (home) {
      fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
      fs.writeFileSync(path.join(home, '.gemini', 'oauth_ok'), code);
    }
    process.stdout.write('Authentication successful\\n');
    process.exit(0);
  });
  process.stdin.resume();
} else {
  const logFile = process.env.FAKE_AGY_LOG;
  const appendLog = (entry) => {
    if (!logFile) return;
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\\n');
  };
  appendLog({ type: 'spawn', args, cwd: process.cwd(), home: process.env.HOME });

  process.on('SIGINT', () => {
    appendLog({ type: 'signal', signal: 'SIGINT' });
    process.exit(0);
  });

  const convId = args.includes('--conversation')
    ? args[args.indexOf('--conversation') + 1]
    : 'conv-int-1';

  let turnIndex = 0;
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    const content = msg?.message?.content ?? '';
    turnIndex += 1;
    appendLog({ type: 'turn', turnIndex, content });

    if (turnIndex === 1) {
      process.stdout.write(
        JSON.stringify({
          event: 'init',
          conversation_id: convId,
          init: { model: 'gemini-4-neon-medium', cwd: process.cwd(), tools: ['run_command'] },
        }) + '\\n',
      );
    }

    if (content.includes('[HOLD_FOR_INTERRUPT]')) {
      process.stdout.write(
        JSON.stringify({
          event: 'step_update',
          step_update: {
            conversation_id: convId,
            step_index: 1,
            state: 'ACTIVE',
            step_type: 'agent_response',
            text_delta: 'Working on a long task...',
          },
        }) + '\\n',
      );
      return;
    }

    if (content.includes('[USE_TOOL]')) {
      process.stdout.write(
        JSON.stringify({
          event: 'step_update',
          step_update: {
            conversation_id: convId,
            step_index: 2,
            state: 'ACTIVE',
            step_type: 'tool',
            tool_name: 'run_command',
            tool_info: { name: 'run_command', parameters: { CommandLine: 'echo ok' } },
          },
        }) + '\\n',
      );
      process.stdout.write(
        JSON.stringify({
          event: 'step_update',
          step_update: {
            conversation_id: convId,
            step_index: 2,
            state: 'DONE',
            step_type: 'tool',
            tool_name: 'run_command',
            duration_seconds: 0.05,
            tool_info: { name: 'run_command', parameters: { CommandLine: 'echo ok' }, output: 'ok\\n' },
          },
        }) + '\\n',
      );
    }

    const reply = 'Reply #' + turnIndex + ': ' + content.slice(-40);
    process.stdout.write(
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: convId,
          step_index: turnIndex * 10,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: reply,
        },
      }) + '\\n',
    );
    process.stdout.write(
      JSON.stringify({
        event: 'result',
        result: {
          conversation_id: convId,
          status: 'SUCCESS',
          response: reply,
          duration_seconds: 0.1,
          num_turns: 1,
          usage: {
            input_tokens: 120,
            output_tokens: 30,
            thinking_tokens: 5,
            cache_read_tokens: 40,
            total_tokens: 150,
          },
        },
      }) + '\\n',
    );
  });

  rl.on('close', () => {
    process.exit(0);
  });
}
`;

interface RunnerHandle {
  frames: Record<string, any>[];
  waitForFrame: (
    predicate: (frame: Record<string, any>) => boolean,
    timeoutMs?: number,
  ) => Promise<Record<string, any>>;
  waitForExit: (timeoutMs?: number) => Promise<number | null>;
  kill: () => void;
}

function spawnAgyRunner(options: {
  cwd: string;
  ipcDir: string;
  claudeConfigDir?: string;
  logFile: string;
  input: Record<string, unknown>;
  extraEnv?: Record<string, string>;
}): RunnerHandle {
  const frames: Record<string, any>[] = [];
  const waiters: Array<{
    predicate: (f: Record<string, any>) => boolean;
    resolve: (f: Record<string, any>) => void;
  }> = [];

  const child = spawn(tsxBin, [agyRunnerEntry], {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HAPPYCLAW_AGY_BIN: fakeAgyPath,
      HAPPYCLAW_WORKSPACE_IPC: options.ipcDir,
      HAPPYCLAW_WORKSPACE_GROUP: options.cwd,
      HAPPYCLAW_AGY_MODEL: 'gemini-4-neon-medium[1m]',
      ...(options.claudeConfigDir
        ? { CLAUDE_CONFIG_DIR: options.claudeConfigDir }
        : {}),
      FAKE_AGY_LOG: options.logFile,
      ...options.extraEnv,
    },
  });

  const scanner = new OutputFrameScanner(
    OUTPUT_START_MARKER,
    OUTPUT_END_MARKER,
  );
  child.stdout?.on('data', (chunk: Buffer) => {
    const events = scanner.push(chunk.toString('utf-8'));
    for (const ev of events) {
      if (ev.kind !== 'frame') continue;
      const frame = JSON.parse(ev.json) as Record<string, any>;
      frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(frame)) {
          const w = waiters.splice(i, 1)[0];
          w.resolve(frame);
        }
      }
    }
  });

  let stderrBuf = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf-8');
  });

  let exitCode: number | null | undefined;
  const exitWaiters: Array<(code: number | null) => void> = [];
  child.on('exit', (code) => {
    exitCode = code;
    while (exitWaiters.length > 0) {
      exitWaiters.shift()!(code);
    }
  });

  child.stdin!.write(JSON.stringify(options.input));
  child.stdin!.end();

  return {
    frames,
    waitForFrame: (predicate, timeoutMs = 10_000) => {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `Timed out waiting for frame. Received ${frames.length} frames. Stderr:\n${stderrBuf}`,
            ),
          );
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
    waitForExit: (timeoutMs = 10_000) => {
      if (exitCode !== undefined) return Promise.resolve(exitCode);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `Timed out waiting for agy-runner exit. Stderr:\n${stderrBuf}`,
            ),
          );
        }, timeoutMs);
        exitWaiters.push((code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
    },
    kill: () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    },
  };
}

function readLogEntries(logFile: string): Record<string, any>[] {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

beforeAll(() => {
  fs.writeFileSync(fakeAgyPath, FAKE_AGY_SCRIPT, { mode: 0o755 });
  process.env.HAPPYCLAW_AGY_BIN = fakeAgyPath;
});

afterAll(() => {
  delete process.env.HAPPYCLAW_AGY_BIN;
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

describe('agy-runner subprocess integration', () => {
  it('runs cold start + warm IPC turn + _close, syncing skills and stripping [1m] suffix', async () => {
    const caseDir = fs.mkdtempSync(path.join(scratchRoot, 'case-warm-'));
    const wsDir = path.join(caseDir, 'ws');
    const ipcDir = path.join(caseDir, 'ipc');
    const cfgDir = path.join(caseDir, 'cfg');
    const skillSrc = path.join(caseDir, 'skill-src');
    const logFile = path.join(caseDir, 'fake-agy.jsonl');

    fs.mkdirSync(wsDir, { recursive: true });
    fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });
    fs.mkdirSync(path.join(cfgDir, 'skills'), { recursive: true });
    fs.mkdirSync(skillSrc, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'CLAUDE.md'), 'WS_MEMORY_RULE');
    fs.writeFileSync(path.join(skillSrc, 'SKILL.md'), '# Demo Skill');
    fs.symlinkSync(skillSrc, path.join(cfgDir, 'skills', 'demo-skill'), 'dir');

    const runner = spawnAgyRunner({
      cwd: wsDir,
      ipcDir,
      claudeConfigDir: cfgDir,
      logFile,
      input: {
        prompt: 'Hello [USE_TOOL]',
        queryRunId: 'qr-1',
        turnId: 'turn-1',
        groupFolder: 'main',
        chatJid: 'web:main',
        interactionMode: 'assistant',
        launchEffort: 'medium',
        agentProfile: { identityPrompt: 'IDENTITY_RULE' },
      },
    });

    try {
      const turn1Done = await runner.waitForFrame(
        (f) => f.status === 'success' && f.queryRunId === 'qr-1',
      );
      expect(turn1Done).toMatchObject({
        status: 'success',
        newSessionId: 'conv-int-1',
        inputTurnCompleted: true,
        queryIdle: true,
      });

      // Verify tool lifecycle + usage events were streamed
      expect(
        runner.frames.some(
          (f) => f.streamEvent?.eventType === 'tool_use_start',
        ),
      ).toBe(true);
      expect(
        runner.frames.some((f) => f.streamEvent?.eventType === 'tool_result'),
      ).toBe(true);
      expect(
        runner.frames.some((f) => f.streamEvent?.eventType === 'usage'),
      ).toBe(true);

      // Verify skills were materialized as real directories for agy
      const syncedSkill = path.join(wsDir, '.agents', 'skills', 'demo-skill');
      expect(fs.lstatSync(syncedSkill).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(path.join(syncedSkill, 'SKILL.md'))).toBe(true);

      // Send a warm follow-up IPC turn with receipt
      fs.writeFileSync(
        path.join(ipcDir, 'input', '001-followup.json'),
        JSON.stringify({
          type: 'message',
          text: 'Second warm turn',
          queryRunId: 'qr-2',
          receipt: { deliveryId: 'deliv-2', kind: 'user' },
        }),
      );

      const turn2Done = await runner.waitForFrame(
        (f) => f.status === 'success' && f.queryRunId === 'qr-2',
      );
      expect(turn2Done).toMatchObject({
        status: 'success',
        newSessionId: 'conv-int-1',
        inputTurnCompleted: true,
        queryIdle: true,
        ipcReceipts: [{ deliveryId: 'deliv-2', kind: 'user' }],
      });

      // Signal _close and verify clean exit + turn context cleanup
      fs.writeFileSync(path.join(ipcDir, 'input', '_close'), '');
      const exitCode = await runner.waitForExit();
      expect(exitCode).toBe(0);
      expect(fs.existsSync(path.join(ipcDir, '.agy-turn-context.json'))).toBe(
        false,
      );

      const logs = readLogEntries(logFile);
      const spawns = logs.filter((e) => e.type === 'spawn');
      expect(spawns).toHaveLength(1);
      // `[1m]` stripped and `--effort` omitted because slug ends with `-medium`
      expect(spawns[0].args).toContain('gemini-4-neon-medium');
      expect(spawns[0].args).not.toContain('--effort');

      const turns = logs.filter((e) => e.type === 'turn');
      expect(turns).toHaveLength(2);
      expect(turns[0].content).toContain('IDENTITY_RULE');
      expect(turns[0].content).toContain('WS_MEMORY_RULE');
      // Cold-start instructions must NOT be re-injected on warm Turn 2
      expect(turns[1].content).not.toContain('IDENTITY_RULE');
      expect(turns[1].content).not.toContain('WS_MEMORY_RULE');
    } finally {
      runner.kill();
    }
  });

  it('exits cleanly when _drain arrives while idle in waitForNextIpcTurn', async () => {
    const caseDir = fs.mkdtempSync(path.join(scratchRoot, 'case-drain-'));
    const wsDir = path.join(caseDir, 'ws');
    const ipcDir = path.join(caseDir, 'ipc');
    const logFile = path.join(caseDir, 'fake-agy.jsonl');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });

    const runner = spawnAgyRunner({
      cwd: wsDir,
      ipcDir,
      logFile,
      input: {
        prompt: 'Quick turn before drain',
        queryRunId: 'qr-drain',
        turnId: 'turn-drain',
        groupFolder: 'g1',
        chatJid: 'web:g1',
      },
    });

    try {
      await runner.waitForFrame(
        (f) => f.status === 'success' && f.queryRunId === 'qr-drain',
      );
      fs.writeFileSync(path.join(ipcDir, 'input', '_drain'), '');
      const exitCode = await runner.waitForExit();
      expect(exitCode).toBe(0);
    } finally {
      runner.kill();
    }
  });

  it('interrupts an active turn via _interrupt sentinel (steer) and preserves sessionId', async () => {
    const caseDir = fs.mkdtempSync(path.join(scratchRoot, 'case-int-'));
    const wsDir = path.join(caseDir, 'ws');
    const ipcDir = path.join(caseDir, 'ipc');
    const logFile = path.join(caseDir, 'fake-agy.jsonl');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });

    const runner = spawnAgyRunner({
      cwd: wsDir,
      ipcDir,
      logFile,
      input: {
        prompt: 'Please wait [HOLD_FOR_INTERRUPT]',
        queryRunId: 'qr-interrupt-me',
        turnId: 'turn-int',
        groupFolder: 'main',
        chatJid: 'web:main',
      },
    });

    try {
      await runner.waitForFrame(
        (f) => f.streamEvent?.eventType === 'text_delta',
      );

      // Write mismatched queryRunId first -> must be ignored
      fs.writeFileSync(
        path.join(ipcDir, 'input', '_interrupt'),
        'wrong-query-id',
      );
      await new Promise((r) => setTimeout(r, 350));
      expect(
        runner.frames.some((f) => f.streamEvent?.statusText === 'interrupted'),
      ).toBe(false);

      // Now write matching queryRunId + steer reason
      fs.writeFileSync(
        path.join(ipcDir, 'input', '_interrupt_reason'),
        JSON.stringify({ queryId: 'qr-interrupt-me', reason: 'steer' }),
      );
      fs.writeFileSync(
        path.join(ipcDir, 'input', '_interrupt'),
        'qr-interrupt-me',
      );

      const interruptedFrame = await runner.waitForFrame(
        (f) => f.streamEvent?.statusText === 'interrupted',
      );
      expect(interruptedFrame).toMatchObject({
        status: 'stream',
        newSessionId: 'conv-int-1',
        queryRunId: 'qr-interrupt-me',
        queryIdle: true,
        streamEvent: {
          agentScope: 'main',
          eventType: 'status',
          statusText: 'interrupted',
          sessionId: 'conv-int-1',
        },
      });

      const exitCode = await runner.waitForExit();
      expect(exitCode).toBe(0);
      const logs = readLogEntries(logFile);
      expect(
        logs.some((e) => e.type === 'signal' && e.signal === 'SIGINT'),
      ).toBe(true);
    } finally {
      runner.kill();
    }
  });

  it('publishes proactive fallback IPC message and waits for send_message_result ack', async () => {
    const caseDir = fs.mkdtempSync(path.join(scratchRoot, 'case-proactive-'));
    const wsDir = path.join(caseDir, 'ws');
    const ipcDir = path.join(caseDir, 'ipc');
    const logFile = path.join(caseDir, 'fake-agy.jsonl');
    const messagesDir = path.join(ipcDir, 'messages');
    const resultsDir = path.join(ipcDir, 'message-results');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });
    fs.mkdirSync(messagesDir, { recursive: true });
    fs.mkdirSync(resultsDir, { recursive: true });

    // Simulate host IPC watcher acknowledging proactive final messages
    let capturedPayload: Record<string, unknown> | null = null;
    const ackInterval = setInterval(() => {
      for (const file of fs.readdirSync(messagesDir)) {
        if (!file.endsWith('.json')) continue;
        const full = path.join(messagesDir, file);
        const payload = JSON.parse(fs.readFileSync(full, 'utf-8')) as Record<
          string,
          unknown
        >;
        capturedPayload = payload;
        fs.unlinkSync(full);
        if (typeof payload.requestId === 'string') {
          fs.writeFileSync(
            path.join(
              resultsDir,
              `send_message_result_${payload.requestId}.json`,
            ),
            JSON.stringify({ ok: true }),
          );
        }
      }
    }, 25);

    const runner = spawnAgyRunner({
      cwd: wsDir,
      ipcDir,
      logFile,
      input: {
        prompt: 'Proactive hello',
        queryRunId: 'qr-pro',
        turnId: 'turn-pro',
        groupFolder: 'main',
        chatJid: 'web:main',
        interactionMode: 'proactive',
      },
    });

    try {
      const done = await runner.waitForFrame(
        (f) => f.status === 'success' && f.queryRunId === 'qr-pro',
      );
      expect(done.status).toBe('success');
      expect(capturedPayload).toMatchObject({
        type: 'message',
        chatJid: 'web:main',
        groupFolder: 'main',
        deliveryRole: 'final',
        presentation: 'native',
        interactionMode: 'proactive',
        inputTurnId: 'turn-pro',
      });

      fs.writeFileSync(path.join(ipcDir, 'input', '_close'), '');
      expect(await runner.waitForExit()).toBe(0);
    } finally {
      clearInterval(ackInterval);
      runner.kill();
    }
  });
});

describe('agy-runner stdio MCP server integration', () => {
  it('handles initialize, tools/list, get_channel_context, send_message, and HMAC-signed workspace_memory_remember', async () => {
    const caseDir = fs.mkdtempSync(path.join(scratchRoot, 'case-mcp-'));
    const wsDir = path.join(caseDir, 'ws');
    const ipcDir = path.join(caseDir, 'ipc');
    const messagesDir = path.join(ipcDir, 'messages');
    const messageResultsDir = path.join(ipcDir, 'message-results');
    const tasksDir = path.join(ipcDir, 'tasks');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.mkdirSync(messagesDir, { recursive: true });
    fs.mkdirSync(messageResultsDir, { recursive: true });
    fs.mkdirSync(tasksDir, { recursive: true });

    const signingSecret = 'integration-test-secret-key';
    fs.writeFileSync(
      path.join(ipcDir, '.agy-turn-context.json'),
      JSON.stringify({
        chatJid: 'web:main',
        groupFolder: 'main',
        agentId: 'agent-42',
        interactionMode: 'proactive',
        inputTurnId: 'turn-mcp-1',
        sessionId: 'conv-mcp-1',
        sourceJid: 'qq:12345',
        workspaceMemoryRunnerInstanceId: 'runner-inst-99',
        workspaceMemoryMutationSigningSecret: signingSecret,
      }),
    );

    let capturedMemoryTask: Record<string, unknown> | null = null;
    const hostWatcher = setInterval(() => {
      for (const file of fs.readdirSync(messagesDir)) {
        if (!file.endsWith('.json')) continue;
        const full = path.join(messagesDir, file);
        const msg = JSON.parse(fs.readFileSync(full, 'utf-8')) as Record<
          string,
          unknown
        >;
        fs.unlinkSync(full);
        if (typeof msg.requestId === 'string') {
          fs.writeFileSync(
            path.join(
              messageResultsDir,
              `send_message_result_${msg.requestId}.json`,
            ),
            JSON.stringify({ success: true, messageId: 'msg-1' }),
          );
        }
      }
      for (const file of fs.readdirSync(tasksDir)) {
        if (
          !file.endsWith('.json') ||
          file.startsWith('workspace_memory_result_')
        ) {
          continue;
        }
        const full = path.join(tasksDir, file);
        const task = JSON.parse(fs.readFileSync(full, 'utf-8')) as Record<
          string,
          unknown
        >;
        capturedMemoryTask = task;
        fs.unlinkSync(full);
        if (typeof task.requestId === 'string') {
          fs.writeFileSync(
            path.join(
              tasksDir,
              `workspace_memory_result_${task.requestId}.json`,
            ),
            JSON.stringify({
              success: true,
              memory: {
                id: 'mem-1',
                title: (task.input as Record<string, unknown>)?.title,
              },
            }),
          );
        }
      }
    }, 25);

    const child = spawn(tsxBin, [mcpServerEntry], {
      cwd: wsDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HAPPYCLAW_WORKSPACE_IPC: ipcDir,
        HAPPYCLAW_WORKSPACE_GROUP: wsDir,
      },
    });

    const pending = new Map<number, (msg: Record<string, any>) => void>();
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line) as Record<string, any>;
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const resolve = pending.get(msg.id)!;
        pending.delete(msg.id);
        resolve(msg);
      }
    });

    const rpc = (
      id: number,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<Record<string, any>> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`MCP RPC ${method} timed out`)),
          5_000,
        );
        pending.set(id, (res) => {
          clearTimeout(timer);
          resolve(res);
        });
        child.stdin!.write(
          JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
        );
      });

    try {
      const initRes = await rpc(1, 'initialize', {});
      expect(initRes.result.serverInfo.name).toBe('happyclaw');

      const listRes = await rpc(2, 'tools/list', {});
      const names = (listRes.result.tools as Array<{ name: string }>).map(
        (t) => t.name,
      );
      expect(names).toContain('send_message');
      expect(names).toContain('workspace_memory_remember');
      expect(names).toContain('workspace_memory_search');

      const ctxRes = await rpc(3, 'tools/call', {
        name: 'get_channel_context',
        arguments: {},
      });
      const ctxPayload = JSON.parse(ctxRes.result.content[0].text);
      expect(ctxPayload).toMatchObject({
        chatJid: 'web:main',
        groupFolder: 'main',
        interactionMode: 'proactive',
        sourceJid: 'qq:12345',
      });

      const sendRes = await rpc(4, 'tools/call', {
        name: 'send_message',
        arguments: { text: 'Hello via MCP', delivery_role: 'final' },
      });
      expect(sendRes.result.isError).toBeUndefined();
      // Final-sent dedup marker should be recorded
      const finalMarker = JSON.parse(
        fs.readFileSync(path.join(ipcDir, '.agy-final-sent.json'), 'utf-8'),
      );
      expect(finalMarker.inputTurnId).toBe('turn-mcp-1');

      const memRes = await rpc(5, 'tools/call', {
        name: 'workspace_memory_remember',
        arguments: {
          title: 'Deploy port',
          content: 'Production runs on port 3001',
          kind: 'fact',
          tags: ['ops'],
        },
      });
      expect(memRes.result.isError).toBeUndefined();
      expect(capturedMemoryTask).not.toBeNull();
      expect(capturedMemoryTask).toMatchObject({
        type: 'workspace_memory',
        operation: 'create',
        runnerInstanceId: 'runner-inst-99',
        title: 'Deploy port',
        content: 'Production runs on port 3001',
        kind: 'fact',
      });
      const expectedSig = signWorkspaceMemoryMutation(
        signingSecret,
        { groupFolder: 'main', agentId: 'agent-42' },
        capturedMemoryTask!,
      );
      expect(capturedMemoryTask!.mutationSignature).toBe(expectedSig);
    } finally {
      clearInterval(hostWatcher);
      rl.close();
      child.kill('SIGKILL');
    }
  });
});

describe('AGY OAuth & Usage integration with fake agy binary', () => {
  it('completes isolated OAuth login flow, discovers models, and cleans up profile dir', async () => {
    const {
      startAgyOAuthLogin,
      completeAgyOAuthLogin,
      deleteAgyProfileDir,
      resolveAgyProfileHomeDir,
    } = await import('../src/agy-runner/oauth.js');

    const started = await startAgyOAuthLogin({ targetProviderId: 'prov-1' });
    expect(started.authorizeUrl).toContain(
      'https://accounts.google.com/o/oauth2/auth',
    );
    expect(started.state.length).toBeGreaterThan(10);

    const completed = await completeAgyOAuthLogin(
      started.state,
      'valid-auth-code-123',
    );
    expect(completed.targetProviderId).toBe('prov-1');
    expect(completed.models.map((m) => m.id)).toEqual([
      'gemini-4-neon-medium',
      'claude-opus-5-5-high',
    ]);
    const homeDir = resolveAgyProfileHomeDir(completed.profileId);
    expect(homeDir).toBe(completed.profileDir);
    expect(
      fs.readFileSync(
        path.join(completed.profileDir, '.gemini', 'oauth_ok'),
        'utf-8',
      ),
    ).toBe('valid-auth-code-123');

    deleteAgyProfileDir(completed.profileId);
    expect(fs.existsSync(completed.profileDir)).toBe(false);
  });

  it('fetches and caches 5-hour & weekly quota usage via agy -p /usage', async () => {
    const { fetchAgyProviderUsage } =
      await import('../src/agy-runner/usage.js');
    const counterFile = path.join(scratchRoot, 'usage-counter.txt');
    process.env.FAKE_AGY_USAGE_COUNTER = counterFile;

    try {
      const first = await fetchAgyProviderUsage({
        providerId: 'prov-usage-test',
        forceRefresh: true,
      });
      expect(first.kind).toBe('agy_quotas');
      expect(first.groups).toHaveLength(1);
      expect(first.groups[0].fiveHour?.remainingPercent).toBe(45);
      expect(first.groups[0].weekly?.remainingPercent).toBe(70);
      expect(fs.readFileSync(counterFile, 'utf-8')).toBe('1');

      // Second call within 60s TTL should hit cache without spawning agy again
      const second = await fetchAgyProviderUsage({
        providerId: 'prov-usage-test',
      });
      expect(second.groups[0].fiveHour?.remainingPercent).toBe(45);
      expect(fs.readFileSync(counterFile, 'utf-8')).toBe('1');
    } finally {
      delete process.env.FAKE_AGY_USAGE_COUNTER;
    }
  });
});
