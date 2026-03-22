#!/usr/bin/env node
/**
 * PTY Worker — runs under Node.js (not Bun) to use node-pty natively.
 * Spawned by terminal-manager.ts as: node pty-worker.cjs <json-args>
 *
 * Protocol (JSON lines over stdin/stdout):
 *   → stdin:  { type: 'write', data: string }
 *   → stdin:  { type: 'resize', cols: number, rows: number }
 *   → stdin:  { type: 'kill' }
 *   ← stdout: { type: 'data', data: string }
 *   ← stdout: { type: 'exit', exitCode: number, signal: number }
 */
'use strict';

const path = require('path');

// Resolve node-pty from the project's node_modules
let pty;
try {
  pty = require('node-pty');
} catch {
  // Fallback: try resolving relative to this script
  pty = require(path.join(__dirname, '..', 'node_modules', 'node-pty'));
}

const args = JSON.parse(process.argv[2]);

const termName = args.name || 'xterm-256color';
const p = pty.spawn(args.file, args.args, {
  name: termName,
  cols: args.cols || 80,
  rows: args.rows || 24,
  env: { ...process.env, TERM: termName },
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

p.onData((data) => {
  send({ type: 'data', data });
});

p.onExit(({ exitCode, signal }) => {
  send({ type: 'exit', exitCode, signal });
  // Give time for the message to flush
  setTimeout(() => process.exit(0), 100);
});

// Read JSON-line commands from stdin
process.stdin.setEncoding('utf8');
let inputBuffer = '';
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  let idx;
  while ((idx = inputBuffer.indexOf('\n')) !== -1) {
    const line = inputBuffer.slice(0, idx);
    inputBuffer = inputBuffer.slice(idx + 1);
    try {
      const msg = JSON.parse(line);
      switch (msg.type) {
        case 'write':
          p.write(msg.data);
          break;
        case 'resize':
          try { p.resize(msg.cols, msg.rows); } catch {}
          break;
        case 'kill':
          p.kill();
          break;
      }
    } catch {}
  }
});

// If parent dies, clean up
process.on('SIGHUP', () => { try { p.kill(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { p.kill(); } catch {} process.exit(0); });
