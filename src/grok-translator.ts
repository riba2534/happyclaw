/**
 * Grok (xAI) Responses adapter on top of the Codex Anthropic translator.
 *
 * Same Messages → Responses mapping as Codex. Differences: default model
 * grok-4.5, reasoning effort low|medium|high, and grok-shell client headers
 * required by cli-chat-proxy.
 */

import {
  anthropicToCodexRequest,
  type AnthropicMessagesRequest,
  type CodexResponsesRequest,
} from './codex-translator.js';

export const GROK_DEFAULT_MODEL = 'grok-4.5';
export const GROK_RESPONSES_URL =
  'https://cli-chat-proxy.grok.com/v1/responses';
export const GROK_DEFAULT_BASE = 'https://cli-chat-proxy.grok.com/v1';

export const GROK_TOKEN_AUTH = 'xai-grok-cli';
export const GROK_CLIENT_VERSION = '0.2.93';
export const GROK_CLIENT_IDENTIFIER = 'grok-shell';
export const GROK_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36';

export type GrokEffort = 'low' | 'medium' | 'high';

export interface GrokCredential {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt?: string;
  email?: string;
}

export interface GrokResponsesRequest extends Omit<
  CodexResponsesRequest,
  'reasoning'
> {
  reasoning: { effort: GrokEffort; summary: 'auto' };
}

export function grokEffort(effort: string | undefined | null): GrokEffort {
  switch (
    String(effort || '')
      .trim()
      .toLowerCase()
  ) {
    case 'low':
    case 'minimal':
      return 'low';
    case 'high':
    case 'max':
    case 'xhigh':
    case 'ultracode':
      return 'high';
    default:
      return 'medium';
  }
}

export function parseGrokCredential(secret: string): GrokCredential {
  try {
    const parsed = JSON.parse(secret) as Partial<GrokCredential> & {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      expires_at?: string;
    };
    if (parsed && typeof parsed === 'object') {
      const accessToken = parsed.accessToken || parsed.access_token || '';
      if (accessToken) {
        return {
          accessToken: String(accessToken),
          refreshToken: String(
            parsed.refreshToken || parsed.refresh_token || '',
          ),
          idToken:
            parsed.idToken || parsed.id_token
              ? String(parsed.idToken || parsed.id_token)
              : undefined,
          expiresAt:
            parsed.expiresAt || parsed.expires_at
              ? String(parsed.expiresAt || parsed.expires_at)
              : undefined,
          email: parsed.email ? String(parsed.email) : undefined,
        };
      }
    }
  } catch {
    // fall through: treat the whole string as a bare access token
  }
  const trimmed = secret.trim();
  if (!trimmed) {
    throw new Error('grok credential is missing access_token');
  }
  return { accessToken: trimmed, refreshToken: '' };
}

export function grokUpstreamHeaders(
  accessToken: string,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': GROK_USER_AGENT,
    'X-XAI-Token-Auth': GROK_TOKEN_AUTH,
    'x-grok-client-version': GROK_CLIENT_VERSION,
    'x-grok-client-identifier': GROK_CLIENT_IDENTIFIER,
  };
}

export function anthropicToGrokRequest(
  req: AnthropicMessagesRequest,
  effort?: string | null,
): GrokResponsesRequest {
  const body = anthropicToCodexRequest({
    ...req,
    model: req.model?.trim() || GROK_DEFAULT_MODEL,
  });
  return {
    ...body,
    reasoning: { effort: grokEffort(effort), summary: 'auto' },
  };
}

export function extractGrokAuthCode(input: string): {
  code: string;
  state?: string;
} {
  const trimmed = input.trim();
  if (!trimmed) return { code: '' };

  const fromSearch = (search: string): { code: string; state?: string } => {
    const params = new URLSearchParams(
      search.startsWith('?') ? search.slice(1) : search,
    );
    const code = params.get('code')?.trim() || '';
    const state = params.get('state')?.trim() || undefined;
    return { code, state };
  };

  try {
    const url = new URL(trimmed);
    const parsed = fromSearch(url.search);
    if (parsed.code) return parsed;
  } catch {
    // not a full URL
  }

  if (trimmed.includes('code=')) {
    const query = trimmed.includes('?') ? trimmed.split('?')[1] : trimmed;
    const parsed = fromSearch(query);
    if (parsed.code) return parsed;
  }

  return { code: trimmed.split('#')[0]?.split('&')[0] ?? trimmed };
}
