import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Standalone Node.js script that wraps node-pty.
 * Spawned as `node pty-worker.cjs <json-args>`, communicates via JSON lines
 * over stdin/stdout.  This sidesteps Bun's incompatibility with node-pty's
 * native addon.
 */
const PTY_WORKER_PATH = path.resolve(__dirname, '..', 'src', 'pty-worker.cjs');

interface TerminalSessionBase {
  containerName: string;
  groupJid: string;
  createdAt: number;
  stoppedManually: boolean;
}

interface PtyTerminalSession extends TerminalSessionBase {
  mode: 'pty';
  process: ChildProcess;
}

interface PipeTerminalSession extends TerminalSessionBase {
  mode: 'pipe';
  process: ChildProcess;
  onData: (data: string) => void;
}

type TerminalSession = PtyTerminalSession | PipeTerminalSession;

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();

  start(
    groupJid: string,
    containerName: string,
    cols: number,
    rows: number,
    onData: (data: string) => void,
    onExit: (exitCode: number, signal?: number) => void,
  ): void {
    // 如果已有会话，先关闭
    if (this.sessions.has(groupJid)) {
      this.stop(groupJid);
    }

    logger.info(
      { groupJid, containerName, cols, rows },
      'Starting terminal session',
    );

    const shellBootstrap =
      'if command -v zsh >/dev/null 2>&1; then exec zsh -il; ' +
      'elif command -v bash >/dev/null 2>&1; then exec bash -il; ' +
      'else exec sh -i; fi';

    // Try PTY mode via node subprocess (Bun can't load node-pty natively)
    if (fs.existsSync(PTY_WORKER_PATH)) {
      try {
        const workerArgs = JSON.stringify({
          file: 'docker',
          args: ['exec', '-it', '-u', 'node', containerName, '/bin/sh', '-c', shellBootstrap],
          name: 'xterm-256color',
          cols,
          rows,
        });

        const proc = spawn('node', [PTY_WORKER_PATH, workerArgs], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env as Record<string, string>,
        });

        const session: PtyTerminalSession = {
          mode: 'pty',
          process: proc,
          containerName,
          groupJid,
          createdAt: Date.now(),
          stoppedManually: false,
        };

        // Parse JSON-line messages from the worker
        let buffer = '';
        proc.stdout?.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          let newlineIdx: number;
          while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIdx);
            buffer = buffer.slice(newlineIdx + 1);
            try {
              const msg = JSON.parse(line);
              if (msg.type === 'data') {
                onData(msg.data);
              } else if (msg.type === 'exit') {
                if (!session.stoppedManually) {
                  logger.info({ groupJid, exitCode: msg.exitCode, signal: msg.signal }, 'Terminal session exited');
                  this.sessions.delete(groupJid);
                  onExit(msg.exitCode, msg.signal);
                }
              }
            } catch {
              // Not JSON — forward as raw output
              onData(line);
            }
          }
        });

        proc.stderr?.on('data', (chunk: Buffer) => {
          logger.warn({ groupJid, stderr: chunk.toString().trim() }, 'PTY worker stderr');
        });

        proc.on('close', (exitCode) => {
          if (!session.stoppedManually && this.sessions.has(groupJid)) {
            logger.info({ groupJid, exitCode }, 'PTY worker process closed');
            this.sessions.delete(groupJid);
            onExit(exitCode ?? 1);
          }
        });

        proc.on('error', (err) => {
          logger.warn({ err, groupJid }, 'PTY worker spawn error');
          if (!session.stoppedManually && this.sessions.has(groupJid)) {
            this.sessions.delete(groupJid);
            onData(`\r\n[terminal error: ${err.message}]\r\n`);
            onExit(1);
          }
        });

        this.sessions.set(groupJid, session);
        return;
      } catch (err) {
        logger.warn(
          { err, groupJid, containerName },
          'PTY worker spawn failed, falling back to pipe terminal',
        );
      }
    } else {
      logger.warn({ path: PTY_WORKER_PATH }, 'PTY worker script not found, falling back to pipe terminal');
    }

    // Fallback: pipe mode (no PTY, no prompt, line-based input)
    const proc = spawn('docker', ['exec', '-i', '-u', 'node', containerName, '/bin/sh'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TERM: process.env.TERM || 'xterm-256color',
      },
    });

    const session: PipeTerminalSession = {
      mode: 'pipe',
      process: proc,
      onData,
      containerName,
      groupJid,
      createdAt: Date.now(),
      stoppedManually: false,
    };

    let exited = false;
    const finalizeExit = (exitCode: number): void => {
      if (exited || session.stoppedManually) return;
      exited = true;
      logger.info({ groupJid, exitCode }, 'Pipe terminal session exited');
      this.sessions.delete(groupJid);
      onExit(exitCode);
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      onData(chunk.toString());
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      onData(chunk.toString());
    });
    proc.on('error', (err) => {
      onData(`\r\n[terminal process error: ${err.message}]\r\n`);
      finalizeExit(1);
    });
    proc.on('close', (exitCode) => {
      finalizeExit(exitCode ?? 0);
    });

    this.sessions.set(groupJid, session);
    onData(
      '\r\n[terminal compatibility mode: no PTY available]\r\n' +
        '[input is line-based; press Enter to execute]\r\n',
    );
  }

  write(groupJid: string, data: string): void {
    const session = this.sessions.get(groupJid);
    if (!session) return;

    if (session.mode === 'pty') {
      // Send write command to PTY worker via JSON line
      session.process.stdin?.write(JSON.stringify({ type: 'write', data }) + '\n');
    } else if (session.process.stdin?.writable) {
      const normalized = data.replace(/\r/g, '\n');
      session.process.stdin.write(normalized);
      if (normalized.length > 0) {
        const echoed = normalized
          .replace(/\n/g, '\r\n')
          .replace(/\u007f/g, '\b \b');
        session.onData(echoed);
      }
    }
  }

  resize(groupJid: string, cols: number, rows: number): void {
    const session = this.sessions.get(groupJid);
    if (session?.mode === 'pty') {
      try {
        session.process.stdin?.write(JSON.stringify({ type: 'resize', cols, rows }) + '\n');
      } catch {
        // Worker may already be dead — ignore
      }
    }
  }

  stop(groupJid: string): void {
    const session = this.sessions.get(groupJid);
    if (session) {
      logger.info({ groupJid }, 'Stopping terminal session');
      session.stoppedManually = true;
      this.sessions.delete(groupJid);
      try {
        if (session.mode === 'pty') {
          session.process.stdin?.write(JSON.stringify({ type: 'kill' }) + '\n');
          setTimeout(() => { try { session.process.kill(); } catch {} }, 500);
        } else {
          session.process.kill();
        }
      } catch {
        // ignore - process may already be dead
      }
    }
  }

  has(groupJid: string): boolean {
    return this.sessions.has(groupJid);
  }

  shutdown(): void {
    for (const [groupJid] of this.sessions) {
      this.stop(groupJid);
    }
  }
}
