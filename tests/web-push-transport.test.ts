import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  PushResponseTooLargeError,
  postPushMessage,
} from '../src/web-push-transport.js';

let server: http.Server | null = null;

async function serve(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) =>
    server!.listen(0, '127.0.0.1', () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/push/abc`;
}

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

const message = (endpoint: string) => ({
  endpoint,
  headers: {
    TTL: 60,
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    Authorization: 'vapid t=token, k=key',
  },
  body: Buffer.from('ciphertext'),
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('postPushMessage', () => {
  test('posts the message and returns the status and a short body', async () => {
    let received: {
      method?: string;
      url?: string;
      ttl?: string;
      body?: string;
    } = {};
    const url = await serve((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received = {
          method: req.method,
          url: req.url,
          ttl: req.headers.ttl as string,
          body: Buffer.concat(chunks).toString(),
        };
        res.writeHead(201);
        res.end('created');
      });
    });
    expect(await postPushMessage(message(url))).toEqual({
      statusCode: 201,
      body: 'created',
    });
    expect(received).toEqual({
      method: 'POST',
      url: '/push/abc',
      ttl: '60',
      body: 'ciphertext',
    });
  });

  test('a response past the size limit is refused and the connection closed', async () => {
    let closed = false;
    let written = 0;
    const url = await serve((_req, res) => {
      res.writeHead(201);
      const chunk = Buffer.alloc(64 * 1024, 'x');
      res.on('close', () => (closed = true));
      // An endless body, as fast as the client takes it.
      const pump = () => {
        while (!res.destroyed && res.write(chunk)) written += chunk.length;
        if (!res.destroyed) res.once('drain', pump);
      };
      pump();
    });
    const uncaught = vi.fn();
    process.on('uncaughtException', uncaught);
    try {
      await expect(
        postPushMessage(message(url), { maxBodyBytes: 256 * 1024 }),
      ).rejects.toBeInstanceOf(PushResponseTooLargeError);
      await until(() => closed);
      expect(closed).toBe(true);
      // Far from what an unbounded reader would have buffered.
      expect(written).toBeLessThan(64 * 1024 * 1024);
    } finally {
      process.off('uncaughtException', uncaught);
    }
    expect(uncaught).not.toHaveBeenCalled();
  });

  test('a response that keeps trickling is cut off at the deadline', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(201);
      // Never idle long enough for an idle timeout, never done.
      const timer = setInterval(() => res.write('x'), 20);
      res.on('close', () => clearInterval(timer));
    });
    const started = Date.now();
    await expect(
      postPushMessage(message(url), { timeoutMs: 300 }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test('an endpoint that never answers is cut off at the deadline', async () => {
    const url = await serve(() => {});
    const started = Date.now();
    await expect(
      postPushMessage(message(url), { timeoutMs: 300 }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
