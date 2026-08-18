/**
 * Local Anthropic Messages facade used by Codex and Grok runners.
 *
 * Official Claude and third-party Anthropic-compat providers stay direct.
 * Same Anthropic in; Codex and Grok are different Responses upstreams.
 */

import { Hono } from 'hono';

import { logger } from './logger.js';
import {
  anthropicErrorJson,
  anthropicErrorSse,
  anthropicMessageJson,
  anthropicToCodexRequest,
  CODEX_DEFAULT_MODEL,
  CODEX_RESPONSES_URL,
  estimateInputTokens,
  stripThinkingBlocks,
  translateCodexSse,
  type AnthropicMessagesRequest,
  type CodexCredential,
} from './codex-translator.js';
import {
  codexTokenExpiresSoon,
  credentialSnapshot,
  refreshCodexCredential,
} from './codex-oauth.js';
import { resolveCodexRunnerProviderId } from './codex-runtime.js';
import {
  grokCredentialExpiresSoon,
  grokCredentialSnapshot,
  refreshGrokCredential,
} from './grok-oauth.js';
import {
  anthropicToGrokRequest,
  GROK_DEFAULT_MODEL,
  GROK_RESPONSES_URL,
  grokUpstreamHeaders,
  type GrokCredential,
} from './grok-translator.js';
import {
  getProviders,
  updateProviderCodexCredentialsIfCurrent,
  updateProviderGrokCredentialsIfCurrent,
} from './runtime-config.js';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const refreshLocks = new Map<string, Promise<CodexCredential>>();
const grokRefreshLocks = new Map<string, Promise<GrokCredential>>();

export function resetCodexRefreshLocksForTests(): void {
  refreshLocks.clear();
  grokRefreshLocks.clear();
}

function readProvider(providerId: string) {
  return getProviders().find((item) => item.id === providerId) ?? null;
}

function readCodexCredential(providerId: string): CodexCredential | null {
  const provider = readProvider(providerId);
  if (
    !provider ||
    provider.type !== 'codex' ||
    !provider.codexOAuthCredentials
  ) {
    return null;
  }
  return { ...provider.codexOAuthCredentials };
}

function readGrokCredential(providerId: string): GrokCredential | null {
  const provider = readProvider(providerId);
  if (!provider || provider.type !== 'grok' || !provider.grokOAuthCredentials) {
    return null;
  }
  return { ...provider.grokOAuthCredentials };
}

function resolveGrokEffort(
  raw: AnthropicMessagesRequest,
  providerId: string,
): string {
  const rec = raw as AnthropicMessagesRequest & {
    effort?: unknown;
    thinking?: { effort?: unknown };
  };
  if (typeof rec.effort === 'string' && rec.effort.trim()) return rec.effort;
  if (typeof rec.thinking?.effort === 'string' && rec.thinking.effort.trim()) {
    return rec.thinking.effort;
  }
  const provider = readProvider(providerId);
  return provider?.customEnv?.CLAUDE_CODE_EFFORT_LEVEL || 'medium';
}

async function persistRefreshedCredential(
  providerId: string,
  expected: CodexCredential,
  refreshed: CodexCredential,
): Promise<boolean> {
  return updateProviderCodexCredentialsIfCurrent(
    providerId,
    expected,
    refreshed,
  );
}

export async function refreshAndPersistCodexCredential(
  providerId: string,
  stale: CodexCredential,
): Promise<CodexCredential> {
  const inflight = refreshLocks.get(providerId);
  if (inflight) return inflight;

  const work = (async () => {
    const latest = readCodexCredential(providerId);
    if (
      latest &&
      credentialSnapshot(latest) !== credentialSnapshot(stale) &&
      !codexTokenExpiresSoon(latest.accessToken, REFRESH_BUFFER_MS)
    ) {
      return latest;
    }
    const refreshed = await refreshCodexCredential(latest ?? stale);
    const persisted = await persistRefreshedCredential(
      providerId,
      latest ?? stale,
      refreshed,
    );
    if (!persisted) {
      const after = readCodexCredential(providerId);
      if (after) return after;
    }
    return refreshed;
  })();

  refreshLocks.set(providerId, work);
  try {
    return await work;
  } finally {
    refreshLocks.delete(providerId);
  }
}

export async function refreshAndPersistGrokCredential(
  providerId: string,
  stale: GrokCredential,
): Promise<GrokCredential> {
  const inflight = grokRefreshLocks.get(providerId);
  if (inflight) return inflight;

  const work = (async () => {
    const latest = readGrokCredential(providerId);
    if (
      latest &&
      grokCredentialSnapshot(latest) !== grokCredentialSnapshot(stale) &&
      !grokCredentialExpiresSoon(latest, REFRESH_BUFFER_MS)
    ) {
      return latest;
    }
    const refreshed = await refreshGrokCredential(latest ?? stale);
    const persisted = updateProviderGrokCredentialsIfCurrent(
      providerId,
      latest ?? stale,
      refreshed,
    );
    if (!persisted) {
      const after = readGrokCredential(providerId);
      if (after) return after;
    }
    return refreshed;
  })();

  grokRefreshLocks.set(providerId, work);
  try {
    return await work;
  } finally {
    grokRefreshLocks.delete(providerId);
  }
}

export async function callCodexResponses(
  providerId: string,
  credential: CodexCredential,
  body: unknown,
): Promise<{ status: number; text: string }> {
  let current = credential;
  if (
    current.refreshToken &&
    codexTokenExpiresSoon(current.accessToken, REFRESH_BUFFER_MS)
  ) {
    try {
      current = await refreshAndPersistCodexCredential(providerId, current);
    } catch (err) {
      logger.warn({ err, providerId }, 'Codex proactive token refresh failed');
    }
  }

  const once = async (cred: CodexCredential) => {
    const res = await fetch(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cred.accessToken}`,
        'chatgpt-account-id': cred.accountId,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
        Origin: 'https://chatgpt.com',
        Referer: 'https://chatgpt.com/codex',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text };
  };

  let first = await once(current);
  if (first.status === 401 && current.refreshToken) {
    try {
      current = await refreshAndPersistCodexCredential(providerId, current);
      first = await once(current);
    } catch (err) {
      logger.warn({ err, providerId }, 'Codex 401 refresh failed');
    }
  }
  return first;
}

export async function callGrokResponses(
  providerId: string,
  credential: GrokCredential,
  body: unknown,
): Promise<{ status: number; text: string }> {
  let current = credential;
  if (
    current.refreshToken &&
    grokCredentialExpiresSoon(current, REFRESH_BUFFER_MS)
  ) {
    try {
      current = await refreshAndPersistGrokCredential(providerId, current);
    } catch (err) {
      logger.warn({ err, providerId }, 'Grok proactive token refresh failed');
    }
  }

  const once = async (cred: GrokCredential) => {
    const res = await fetch(GROK_RESPONSES_URL, {
      method: 'POST',
      headers: grokUpstreamHeaders(cred.accessToken),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text };
  };

  let first = await once(current);
  if (first.status === 401 && current.refreshToken) {
    try {
      current = await refreshAndPersistGrokCredential(providerId, current);
      first = await once(current);
    } catch (err) {
      logger.warn({ err, providerId }, 'Grok 401 refresh failed');
    }
  }
  return first;
}

function parseUpstreamSse(text: string): string[] {
  return text.split(/\r?\n/);
}

function facadeErrorResponse(
  streaming: boolean,
  message: string,
  status: 400 | 502 = 502,
) {
  if (streaming) {
    return new Response(anthropicErrorSse(message), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  }
  return null;
}

export function createCodexFacadeApp(): Hono {
  const app = new Hono();

  app.use('/model/*', async (c, next) => {
    if (!resolveCodexRunnerProviderId(c.req.header('Authorization'))) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  app.post('/model/v1/messages/count_tokens', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json({
      input_tokens: estimateInputTokens(
        (body as { messages?: unknown }).messages ?? body,
      ),
    });
  });

  app.post('/model/v1/messages', async (c) => {
    const providerId = resolveCodexRunnerProviderId(
      c.req.header('Authorization'),
    );
    if (!providerId) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const provider = readProvider(providerId);
    const isGrok = provider?.type === 'grok';
    const codexCredential = isGrok ? null : readCodexCredential(providerId);
    const grokCredential = isGrok ? readGrokCredential(providerId) : null;
    if (!isGrok && !codexCredential) {
      return c.json(anthropicErrorJson('Codex account is not authorized'), 400);
    }
    if (isGrok && !grokCredential) {
      return c.json(anthropicErrorJson('Grok account is not authorized'), 400);
    }

    const raw = (await c.req
      .json()
      .catch(() => null)) as AnthropicMessagesRequest | null;
    if (!raw || typeof raw !== 'object') {
      return c.json(anthropicErrorJson('bad json'), 400);
    }
    if (Array.isArray(raw.messages)) {
      raw.messages = raw.messages.map((message) => ({
        ...message,
        content: stripThinkingBlocks(message.content),
      }));
    }
    raw.model =
      raw.model?.trim() || (isGrok ? GROK_DEFAULT_MODEL : CODEX_DEFAULT_MODEL);
    const streaming = raw.stream === true;
    const request = isGrok
      ? anthropicToGrokRequest(raw, resolveGrokEffort(raw, providerId))
      : anthropicToCodexRequest(raw);
    const label = isGrok ? 'grok' : 'codex';

    let upstream: { status: number; text: string };
    try {
      upstream = isGrok
        ? await callGrokResponses(providerId, grokCredential!, request)
        : await callCodexResponses(providerId, codexCredential!, request);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : `${label} upstream failed`;
      logger.warn(
        { err, providerId },
        `${isGrok ? 'Grok' : 'Codex'} upstream call failed`,
      );
      const sse = facadeErrorResponse(streaming, message);
      if (sse) return sse;
      return c.json(anthropicErrorJson(message), 502);
    }

    if (upstream.status !== 200) {
      const message = `${label} ${upstream.status}: ${upstream.text.slice(0, 800)}`;
      const sse = facadeErrorResponse(streaming, message);
      if (sse) return sse;
      return c.json(anthropicErrorJson(message), 502);
    }

    const translated = translateCodexSse(
      raw.model,
      parseUpstreamSse(upstream.text),
    );
    if (translated.error) {
      if (streaming) {
        return new Response(translated.sse, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
          },
        });
      }
      return c.json(anthropicErrorJson(translated.error), 502);
    }

    if (streaming) {
      return new Response(translated.sse, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      });
    }
    return c.json(anthropicMessageJson(raw.model, translated));
  });

  return app;
}

export const codexFacadeRoutes = createCodexFacadeApp();
