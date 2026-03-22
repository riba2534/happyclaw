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
  lineBuffer: string;
}

type TerminalSession = PtyTerminalSession | PipeTerminalSession;

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  /** Set to true when node-pty is detected as broken (e.g. Node.js version incompatibility) */
  private ptyDisabled = false;

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
      'export TERM="${TERM:-xterm-256color}"; stty erase "^?" 2>/dev/null; ' +
      'if command -v zsh >/dev/null 2>&1; then exec zsh -il; ' +
      'elif command -v bash >/dev/null 2>&1; then exec bash -il; ' +
      'else exec sh -i; fi';

    // Try PTY mode via node subprocess (Bun can't load node-pty natively)
    if (!this.ptyDisabled && fs.existsSync(PTY_WORKER_PATH)) {
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

        // Track whether PTY worker has been alive long enough to be considered healthy
        let ptyHealthy = false;
        const ptyHealthTimer = setTimeout(() => { ptyHealthy = true; }, 2000);

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
          clearTimeout(ptyHealthTimer);
          if (session.stoppedManually || !this.sessions.has(groupJid)) return;
          // If PTY worker crashes quickly (< 2s), node-pty is broken — fall back to pipe mode permanently
          if (!ptyHealthy) {
            logger.warn({ groupJid, exitCode }, 'PTY worker crashed on startup, disabling PTY and falling back to pipe mode');
            this.ptyDisabled = true;
            this.sessions.delete(groupJid);
            this.startPipeMode(groupJid, containerName, shellBootstrap, onData, onExit);
            return;
          }
          logger.info({ groupJid, exitCode }, 'PTY worker process closed');
          this.sessions.delete(groupJid);
          onExit(exitCode ?? 1);
        });

        proc.on('error', (err) => {
          clearTimeout(ptyHealthTimer);
          logger.warn({ err, groupJid }, 'PTY worker spawn error');
          if (!session.stoppedManually && this.sessions.has(groupJid)) {
            this.sessions.delete(groupJid);
            // Disable PTY and fall back to pipe mode
            this.ptyDisabled = true;
            this.startPipeMode(groupJid, containerName, shellBootstrap, onData, onExit);
          }
        });

        this.sessions.set(groupJid, session);
        return;
      } catch (err) {
        logger.warn(
          { err, groupJid, containerName },
          'PTY worker spawn failed, falling back to pipe terminal',
        );
        this.ptyDisabled = true;
      }
    } else if (!fs.existsSync(PTY_WORKER_PATH)) {
      logger.warn({ path: PTY_WORKER_PATH }, 'PTY worker script not found, falling back to pipe terminal');
    }

    this.startPipeMode(groupJid, containerName, shellBootstrap, onData, onExit);
  }

  /** Pipe mode fallback (no PTY, line-based input) */
  private startPipeMode(
    groupJid: string,
    containerName: string,
    shellBootstrap: string,
    onData: (data: string) => void,
    onExit: (exitCode: number, signal?: number) => void,
  ): void {
    const proc = spawn('docker', ['exec', '-i', '-u', 'node', containerName, '/bin/sh', '-c', shellBootstrap], {
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
      lineBuffer: '',
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
      // Pipe mode: local line buffer with editing support.
      // Characters are buffered locally; only the final edited line is sent
      // to the shell on Enter. This is necessary because pipe stdin has no
      // PTY line discipline to process backspace / Ctrl-U / etc.
      for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        if (ch === '\r' || ch === '\n') {
          // Skip \n following \r (Windows CRLF from paste)
          if (ch === '\r' && i + 1 < data.length && data[i + 1] === '\n') i++;
          // Send the clean, edited line to the shell
          session.process.stdin.write(session.lineBuffer + '\n');
          session.onData('\r\n');
          session.lineBuffer = '';
        } else if (ch === '\x7f' || ch === '\b') {
          // Backspace / DEL: remove last character
          if (session.lineBuffer.length > 0) {
            session.lineBuffer = session.lineBuffer.slice(0, -1);
            session.onData('\b \b');
          }
        } else if (ch === '\x15') {
          // Ctrl-U: kill entire line
          const len = session.lineBuffer.length;
          if (len > 0) {
            session.onData('\b \b'.repeat(len));
            session.lineBuffer = '';
          }
        } else if (ch === '\x17') {
          // Ctrl-W: delete last word
          const buf = session.lineBuffer;
          const trimmed = buf.replace(/\s+$/, '');
          const lastSpace = trimmed.lastIndexOf(' ');
          const newBuf = lastSpace >= 0 ? buf.slice(0, lastSpace + 1) : '';
          const removed = buf.length - newBuf.length;
          if (removed > 0) {
            session.onData('\b \b'.repeat(removed));
            session.lineBuffer = newBuf;
          }
        } else if (ch === '\x03') {
          // Ctrl-C: discard current line
          session.onData('^C\r\n');
          session.lineBuffer = '';
        } else if (ch === '\x04') {
          // Ctrl-D: send EOF if line is empty, otherwise ignore
          if (session.lineBuffer.length === 0) {
            session.process.stdin.end();
          }
        } else if (ch === '\t') {
          // Tab: insert literal tab (no completion in pipe mode)
          session.lineBuffer += ch;
          session.onData(ch);
        } else if (ch >= ' ') {
          // Printable character
          session.lineBuffer += ch;
          session.onData(ch);
        }
        // Ignore other control characters (arrow keys, etc.)
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
