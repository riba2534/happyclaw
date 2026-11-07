/**
 * The one HTTP request of a Web Push delivery: POST the encrypted message to
 * the subscription's push service.
 *
 * web-push's own sender reads the response without a size limit and only has
 * a socket-idle timeout, so a slow or flooding endpoint could hold a request
 * open or grow a string until the process dies. Here the whole exchange has a
 * deadline and the response body a byte limit; both end in a rejected
 * promise, never in an exception outside it. The request goes through
 * undici's global dispatcher, which honours HTTPS_PROXY / NO_PROXY like the
 * rest of the server's outbound traffic (see load-env.ts).
 */
import { request } from 'undici';

/** Longest a single delivery may take, connect to last byte. */
export const PUSH_REQUEST_TIMEOUT_MS = 10_000;
/** A push service answers with a few bytes; anything past this is refused. */
export const PUSH_RESPONSE_MAX_BYTES = 16 * 1024;

export interface PushHttpRequest {
  /** The normalised endpoint (see normalizePushEndpoint). */
  endpoint: string;
  headers: Record<string, string | number>;
  body: Buffer | null;
}

export interface PushHttpResponse {
  statusCode: number;
  body: string;
}

export interface PushHttpLimits {
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export class PushResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`push service response exceeded ${limit} bytes`);
    this.name = 'PushResponseTooLargeError';
  }
}

export async function postPushMessage(
  message: PushHttpRequest,
  limits: PushHttpLimits = {},
): Promise<PushHttpResponse> {
  const timeoutMs = limits.timeoutMs ?? PUSH_REQUEST_TIMEOUT_MS;
  const maxBodyBytes = limits.maxBodyBytes ?? PUSH_RESPONSE_MAX_BYTES;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.headers)) {
    headers[name] = String(value);
  }
  const response = await request(message.endpoint, {
    method: 'POST',
    headers,
    body: message.body ?? undefined,
    signal: AbortSignal.timeout(timeoutMs),
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
  const stream = response.body;
  // undici destroys the body with the abort reason; the loop below sees it.
  stream.on('error', () => {});
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += (chunk as Buffer).length;
      if (size > maxBodyBytes) {
        throw new PushResponseTooLargeError(maxBodyBytes);
      }
      chunks.push(chunk as Buffer);
    }
  } finally {
    if (!stream.destroyed) stream.destroy();
  }
  return {
    statusCode: response.statusCode,
    body: Buffer.concat(chunks).toString('utf-8'),
  };
}
