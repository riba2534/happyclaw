import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import pty from 'node-pty';
import { logger } from './logger.js';
import { TERM_TYPE } from './environment.js';

interface TerminalSessionBase {
  containerName: string;
  groupJid: string;
  createdAt: number;
  stoppedManually: boolean;
}

interface PtyTerminalSession extends TerminalSessionBase {
  mode: 'pty';
  pty: pty.IPty;
}

interface PipeTerminalSession extends TerminalSessionBase {
  mode: 'pipe';
  process: ChildProcess;
  onData: (data: string) => void;
}

type TerminalSession = PtyTerminalSession | PipeTerminalSession;

export class TerminalManager {
  private static ensuredPtyHelper = false;
  private sessions = new Map<string, TerminalSession>();

  private ensurePtySpawnHelperExecutable(): void {
    if (TerminalManager.ensuredPtyHelper) return;
    TerminalManager.ensuredPtyHelper = true;

    if (process.platform === 'win32') return;

    try {
      const require = createRequire(import.meta.url);
      const nodePtyMain = require.resolve('node-pty');
      const helperPath = path.join(
        path.dirname(nodePtyMain),
        '..',
        'prebuilds',
        `${process.platform}-${process.arch}`,
        'spawn-helper',
      );
      if (!fs.existsSync(helperPath)) return;
      const stat = fs.statSync(helperPath);
      // Ensure user-executable bit for node-pty helper.
      if ((stat.mode & 0o100) === 0) {
        fs.chmodSync(helperPath, stat.mode | 0o755);
        logger.info({ helperPath }, 'Fixed node-pty spawn-helper executable bit');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to validate node-pty spawn-helper permissions');
    }
  }

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

    logger.info({ groupJid, containerName, cols, rows }, 'Starting terminal session');

    const shellBootstrap =
      'if command -v zsh >/dev/null 2>&1; then exec zsh -il; ' +
      'elif command -v bash >/dev/null 2>&1; then exec bash -il; ' +
      'else exec sh -i; fi';

    this.ensurePtySpawnHelperExecutable();

    try {
      const ptyProcess = pty.spawn(
        'docker',
        ['exec', '-it', containerName, '/bin/sh', '-lc', shellBootstrap],
        {
          name: 'xterm-256color',
          cols,
          rows,
          env: process.env as Record<string, string>,
        },
      );

      const session: PtyTerminalSession = {
        mode: 'pty',
        pty: ptyProcess,
        containerName,
        groupJid,
        createdAt: Date.now(),
        stoppedManually: false,
      };

      ptyProcess.onData(onData);
      ptyProcess.onExit(({ exitCode, signal }) => {
        if (session.stoppedManually) return;
        logger.info({ groupJid, exitCode, signal }, 'Terminal session exited');
        this.sessions.delete(groupJid);
        onExit(exitCode, signal);
      });

      this.sessions.set(groupJid, session);
      return;
    } catch (err) {
      logger.warn(
        { err, groupJid, containerName },
        'PTY spawn failed, falling back to pipe terminal',
      );
    }

    const proc = spawn('docker', ['exec', '-i', containerName, '/bin/sh'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TERM: TERM_TYPE,
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
    if (session) {
      if (session.mode === 'pty') {
        session.pty.write(data);
      } else if (session.process.stdin?.writable) {
        // xterm sends Enter as "\r"; pipes need "\n" to submit commands.
        const normalized = data.replace(/\r/g, '\n');
        session.process.stdin.write(normalized);

        // In non-TTY mode, remote shell usually won't echo input.
        // Emit a lightweight local echo so users can see what they typed.
        if (normalized.length > 0) {
          const echoed = normalized
            .replace(/\n/g, '\r\n')
            .replace(/\u007f/g, '\b \b');
          session.onData(echoed);
        }
      }
    }
  }

  resize(groupJid: string, cols: number, rows: number): void {
    const session = this.sessions.get(groupJid);
    if (session?.mode === 'pty') {
      session.pty.resize(cols, rows);
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
          session.pty.kill();
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
