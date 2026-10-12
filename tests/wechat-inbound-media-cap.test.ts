import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

// Small cap so the over-limit cases stay cheap; wechat.ts reads MAX_FILE_SIZE
// from im-downloader, so overriding it there drives the real call path.
const CAP = 1024 * 1024;
// Ciphertext for a CAP-byte plaintext (PKCS7 always pads to the next block).
const CIPHER_CAP = (Math.floor(CAP / 16) + 1) * 16;
const CHUNK = 16 * 1024;
const OVER = 8 * 1024 * 1024;

// Count the body bytes downloadAndDecryptMedia actually pulls: wrap undici's
// fetch so resp.body passes through a counting TransformStream. With the
// default readable highWaterMark of 0, transform() only runs when the reader
// pulls, and cancelling the reader cancels the real undici body.
const pulled = vi.hoisted(() => ({ bytes: 0, maxChunk: 0 }));
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  const fetch = (async (...args: Parameters<typeof actual.fetch>) => {
    const resp = await actual.fetch(...args);
    if (!resp.body) return resp;
    const counted = resp.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          pulled.bytes += chunk.byteLength;
          pulled.maxChunk = Math.max(pulled.maxChunk, chunk.byteLength);
          controller.enqueue(chunk);
        },
      }),
    );
    return new actual.Response(counted, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  }) as typeof actual.fetch;
  return { ...actual, fetch };
});

const downloader = vi.hoisted(() => ({
  saveDownloadedFile: vi.fn(
    async (_f, _c, fileName: string) => `ws/${fileName}`,
  ),
}));
vi.mock('../src/im-downloader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/im-downloader.js')>()),
  ...downloader,
  MAX_FILE_SIZE: 1024 * 1024,
}));
const db = vi.hoisted(() => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  updateChatName: vi.fn(),
  isDatabaseInitialized: () => false,
}));
vi.mock('../src/db.js', () => db);
vi.mock('../src/message-notifier.js', () => ({ notifyNewImMessage: vi.fn() }));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { downloadAndDecryptMedia, encryptAesEcb } =
  await import('../src/wechat-crypto.js');
const { createWeChatConnection } = await import('../src/wechat.js');

const rawKey = crypto.randomBytes(16);
// Canonical inbound encoding: base64(32-char hex ASCII).
const aesKey = Buffer.from(rawKey.toString('hex'), 'utf-8').toString('base64');

type Mode = 'content-length' | 'chunked';
interface Served {
  written: number;
  aborted: boolean;
  finished: boolean;
}
const objects = new Map<string, { body: Buffer; mode: Mode }>();
const served = new Map<string, Served>();

function putObject(id: string, plaintextSize: number, mode: Mode): Buffer {
  const plaintext = crypto.randomBytes(plaintextSize);
  objects.set(id, { body: encryptAesEcb(plaintext, rawKey), mode });
  return plaintext;
}

// Stand-in for the WeChat CDN /download endpoint. Bodies are written in
// CHUNK-sized pieces with backpressure, so the server-side count shows how
// far the client let the transfer run.
const server = http.createServer((req, res) => {
  const id = new URL(req.url!, 'http://x').searchParams.get(
    'encrypted_query_param',
  )!;
  const obj = objects.get(id);
  if (!obj) {
    res.writeHead(404).end();
    return;
  }
  const stat: Served = { written: 0, aborted: false, finished: false };
  served.set(id, stat);
  res.on('close', () => {
    if (!stat.finished) stat.aborted = true;
  });
  const headers: http.OutgoingHttpHeaders = {
    'content-type': 'application/octet-stream',
  };
  if (obj.mode === 'content-length')
    headers['content-length'] = obj.body.length;
  res.writeHead(200, headers);
  res.flushHeaders();
  void (async () => {
    // Give a client that rejects on headers alone time to hang up first.
    await new Promise((r) => setTimeout(r, 50));
    for (let off = 0; off < obj.body.length; off += CHUNK) {
      if (res.destroyed || stat.aborted) return;
      const piece = obj.body.subarray(off, off + CHUNK);
      if (!res.write(piece)) {
        await new Promise((r) => res.once('drain', r).once('close', r));
      }
      stat.written += piece.length;
      await new Promise((r) => setImmediate(r));
    }
    stat.finished = true;
    res.end();
  })();
});

let cdnBase = '';
let agent: Agent;

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cdnBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}/c2c`;
  agent = new Agent();
});

afterAll(async () => {
  await agent.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  pulled.bytes = 0;
  pulled.maxChunk = 0;
  vi.clearAllMocks();
});

async function waitForServerClose(id: string): Promise<Served> {
  await vi.waitFor(() => {
    const s = served.get(id);
    expect(s && (s.aborted || s.finished)).toBe(true);
  });
  return served.get(id)!;
}

// Resolve to the length only, so an uncapped download (the bug) fails fast
// instead of pretty-printing an 8 MB Buffer in the assertion message.
function downloadedLength(id: string): Promise<number> {
  return downloadAndDecryptMedia(id, aesKey, cdnBase, agent, CAP).then(
    (buf) => buf.length,
  );
}

describe('downloadAndDecryptMedia byte cap', () => {
  test('media under the cap round-trips byte-identical', async () => {
    const plaintext = putObject('small', CAP - 100, 'content-length');
    const out = await downloadAndDecryptMedia(
      'small',
      aesKey,
      cdnBase,
      agent,
      CAP,
    );
    expect(Buffer.compare(out, plaintext)).toBe(0);
    expect((await waitForServerClose('small')).finished).toBe(true);
  });

  test('media of exactly the cap is accepted', async () => {
    const plaintext = putObject('exact', CAP, 'chunked');
    const out = await downloadAndDecryptMedia(
      'exact',
      aesKey,
      cdnBase,
      agent,
      CAP,
    );
    expect(Buffer.compare(out, plaintext)).toBe(0);
  });

  test('an over-cap Content-Length is rejected without reading the body', async () => {
    putObject('big-cl', OVER, 'content-length');
    await expect(downloadedLength('big-cl')).rejects.toMatchObject({
      name: 'WeChatMediaTooLargeError',
    });
    expect(pulled.bytes).toBe(0);
    const stat = await waitForServerClose('big-cl');
    expect(stat.aborted).toBe(true);
    expect(stat.written).toBeLessThanOrEqual(CHUNK);
  });

  test('an over-cap chunked body is cancelled mid-stream at the cap', async () => {
    putObject('big-chunked', OVER, 'chunked');
    await expect(downloadedLength('big-chunked')).rejects.toMatchObject({
      name: 'WeChatMediaTooLargeError',
    });
    expect(pulled.bytes).toBeGreaterThan(CIPHER_CAP);
    expect(pulled.bytes).toBeLessThanOrEqual(CIPHER_CAP + pulled.maxChunk);
    const stat = await waitForServerClose('big-chunked');
    expect(stat.aborted).toBe(true);
    expect(stat.written).toBeLessThan(OVER / 2);
  });
});

describe('WeChat inbound media over the cap', () => {
  function inbound(id: string, item: Record<string, unknown>) {
    return {
      message_id: id,
      from_user_id: 'wxid_user1',
      create_time_ms: Date.now(),
      context_token: 'tok',
      item_list: [item],
    };
  }

  async function deliver(item: Record<string, unknown>): Promise<string> {
    let first = true;
    const fetchMock = vi.fn(
      async (_url: string, init?: { signal?: AbortSignal | null }) => {
        if (first) {
          first = false;
          return Response.json({
            get_updates_buf: 'c1',
            msgs: [inbound('m-1', item)],
          });
        }
        return new Promise<Response>((_resolve, reject) => {
          const abort = () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (init?.signal?.aborted) return abort();
          init?.signal?.addEventListener('abort', abort, { once: true });
        });
      },
    );
    const connection = createWeChatConnection(
      {
        botToken: 'secret-token',
        ilinkBotId: 'bot@example',
        cdnBaseUrl: cdnBase,
      },
      {
        fetch: fetchMock as typeof fetch,
        createDispatcher: () => new Agent(),
        contextTokenStore: null,
        random: () => 0.5,
        now: () => Date.now(),
      },
    );
    try {
      await connection.connect({
        onNewChat: vi.fn(),
        isChatAuthorized: () => true,
        resolveGroupFolder: () => '/tmp/wechat-ws',
        resolveEffectiveChatJid: (jid: string) => ({
          effectiveJid: jid,
          agentId: null,
        }),
      });
      await vi.waitFor(() => expect(db.storeMessageDirect).toHaveBeenCalled(), {
        timeout: 10_000,
      });
    } finally {
      await connection.disconnect();
    }
    return String(db.storeMessageDirect.mock.calls[0][4]);
  }

  test('an oversized file is reported over the limit and never decrypted', async () => {
    putObject('wx-file', OVER, 'chunked');
    const content = await deliver({
      type: 4,
      file_item: {
        file_name: 'huge.bin',
        media: { encrypt_query_param: 'wx-file', aes_key: aesKey },
      },
    });
    expect(content).toBe('[文件: huge.bin，文件过大未保存（超过 1MB 上限）]');
    expect(downloader.saveDownloadedFile).not.toHaveBeenCalled();
    expect((await waitForServerClose('wx-file')).aborted).toBe(true);
  });

  test('an oversized video is reported over the limit', async () => {
    putObject('wx-video', OVER, 'content-length');
    const content = await deliver({
      type: 5,
      video_item: {
        media: { encrypt_query_param: 'wx-video', aes_key: aesKey },
      },
    });
    expect(content).toBe('[视频消息: 文件过大未保存（超过 1MB 上限）]');
    expect(downloader.saveDownloadedFile).not.toHaveBeenCalled();
  });

  test('a file within the cap is still saved', async () => {
    const plaintext = putObject('wx-ok', 4096, 'chunked');
    const content = await deliver({
      type: 4,
      file_item: {
        file_name: 'ok.bin',
        media: { encrypt_query_param: 'wx-ok', aes_key: aesKey },
      },
    });
    expect(content).toBe('[文件: ws/ok.bin]');
    const saved = downloader.saveDownloadedFile.mock.calls[0][3] as Buffer;
    expect(Buffer.compare(saved, plaintext)).toBe(0);
  });
});
