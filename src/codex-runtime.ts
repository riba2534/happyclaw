/**
 * Runner-side Codex binding: local facade URL and per-provider bearer tokens.
 * Official / third_party providers never use these values.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

import { WEB_PORT } from './config.js';
import { CODEX_DEFAULT_MODEL } from './codex-translator.js';

export { CODEX_DEFAULT_MODEL };

const runnerTokens = new Map<string, string>();

export function getCodexFacadeBaseUrl(): string {
  return `http://127.0.0.1:${WEB_PORT}/model`;
}

export function isCodexFacadeBaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
    return (
      (host === '127.0.0.1' ||
        host === 'localhost' ||
        host === '::1' ||
        host === 'host.docker.internal') &&
      parsed.pathname.replace(/\/$/, '') === '/model'
    );
  } catch {
    return false;
  }
}

export function rewriteCodexFacadeUrlForContainer(url: string): {
  url: string;
  addHostGateway: boolean;
} {
  if (!isCodexFacadeBaseUrl(url)) {
    return { url, addHostGateway: false };
  }
  const parsed = new URL(url);
  parsed.hostname = 'host.docker.internal';
  return { url: parsed.toString().replace(/\/$/, ''), addHostGateway: true };
}

export function rewriteCodexFacadeEnvForContainer(lines: string[]): {
  lines: string[];
  addHostGateway: boolean;
} {
  let addHostGateway = false;
  const next = lines.map((line) => {
    if (!line.startsWith('ANTHROPIC_BASE_URL=')) return line;
    const rewritten = rewriteCodexFacadeUrlForContainer(
      line.slice('ANTHROPIC_BASE_URL='.length),
    );
    addHostGateway = addHostGateway || rewritten.addHostGateway;
    return `ANTHROPIC_BASE_URL=${rewritten.url}`;
  });
  return { lines: next, addHostGateway };
}

export function issueCodexRunnerToken(providerId: string): string {
  for (const [token, id] of runnerTokens) {
    if (id === providerId) return token;
  }
  const token = randomBytes(24).toString('hex');
  runnerTokens.set(token, providerId);
  return token;
}

export function resetCodexRunnerTokensForTests(): void {
  runnerTokens.clear();
}

export function resolveCodexRunnerProviderId(
  authorization: string | undefined,
): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const provided = authorization.slice(7).trim();
  if (!provided) return null;
  for (const [token, providerId] of runnerTokens) {
    const left = Buffer.from(token);
    const right = Buffer.from(provided);
    if (left.length === right.length && timingSafeEqual(left, right)) {
      return providerId;
    }
  }
  return null;
}
