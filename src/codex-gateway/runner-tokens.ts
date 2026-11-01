// ─── ChatGPT/Codex 订阅网关 — Runner 级临时网关凭据 ────────────────────
//
// 每次启动 Runner（容器、宿主机进程）或宿主机侧一次性 SDK 查询时，铸造一枚
// 随机网关 token，只登记在主服务内存里，Runner/查询退出即吊销；服务重启后
// 全部失效。网关只接受这里登记过的 token，并据此把请求归属到 provider 与具体
// 工作区/会话。Provider 落盘的 anthropicAuthToken 只作为内部标识，用来在构建
// Runner 环境时找回对应 provider，不再是网关接受的凭据。
//
// 残余风险：Runner 里的 Agent 能从自己的进程环境读到这枚 token，在该 Runner
// 存活期间可以从本机回环或私网地址直接调用网关（网关拒绝公网来源与带反代头的
// 请求）。它拿不到上游 ChatGPT token，Runner 退出或服务重启后也无法再使用。

import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import { logger } from '../logger.js';
import {
  isCodexGatewayBaseUrl,
  resolveCodexGatewayBaseUrl,
  type CodexGatewayExecutionMode,
} from './resolve-gateway-url.js';
import { findCodexProviderByGatewayIdentifier } from './token-manager.js';

export type CodexGatewayRunnerKind = 'container' | 'host' | 'sdk-query';

export interface CodexGatewayRunnerOwner {
  kind: CodexGatewayRunnerKind;
  groupFolder?: string | null;
  /**
   * The session this runner serves: the namespace conversation-level choices
   * (model, effort) are stored under.
   */
  agentId?: string | null;
  /**
   * Explicit Agent reasoning effort for this runner. Undefined means the Agent
   * inherits, so the provider-level CODEX_REASONING_EFFORT applies.
   */
  agentEffort?: string;
  /**
   * Reasoning effort the user picked for this conversation in the composer, at
   * launch. It travels out of band, not through the SDK: the SDK cannot carry
   * every level the catalog has (`ultra`), and the CLI always sends its own
   * output_config.effort. See CodexGatewayGrant.sessionEffort for the live value.
   */
  sessionEffort?: string;
}

/**
 * What the gateway last told this runner. The host reads it after a provider
 * failure: Claude Code reports every exhausted 429 as an account-wide limit,
 * but a throttle the gateway applied itself says nothing about the account.
 */
export type CodexGatewayVerdict =
  | 'ok'
  | 'upstream_failure'
  | 'local_transient'
  | 'reauth_required';

export interface CodexGatewayGrant {
  /** Non-secret identifier for logs and per-runner rate windows. */
  readonly id: string;
  readonly providerId: string;
  readonly owner: Readonly<CodexGatewayRunnerOwner>;
  readonly createdAt: number;
  lastVerdict: CodexGatewayVerdict | null;
  /**
   * The conversation's reasoning effort as of now: seeded from the owner and
   * replaced in place by updateLiveSessionEffort, so a change of the effort
   * button reaches a warm runner on its next request without a restart.
   */
  sessionEffort: string | undefined;
}

const TOKEN_PREFIX = 'hcgw_';
const TOKEN_PATTERN = /^hcgw_[A-Za-z0-9_-]{43}$/;

/** Keyed by SHA-256 of the token: the map never holds a usable credential. */
const grants = new Map<string, { digest: Buffer; grant: CodexGatewayGrant }>();

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function issueCodexGatewayToken(
  providerId: string,
  owner: CodexGatewayRunnerOwner,
): { token: string; grant: CodexGatewayGrant } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const digest = tokenDigest(token);
  const grant: CodexGatewayGrant = {
    id: randomUUID(),
    providerId,
    owner: { ...owner },
    createdAt: Date.now(),
    lastVerdict: null,
    sessionEffort: owner.sessionEffort,
  };
  grants.set(digest.toString('hex'), { digest, grant });
  return { token, grant };
}

/** Resolve a presented bearer to its live grant, or null. */
export function resolveCodexGatewayToken(
  token: string,
): CodexGatewayGrant | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  const digest = tokenDigest(token);
  const entry = grants.get(digest.toString('hex'));
  // The map lookup selects by digest; compare the digests in constant time
  // anyway so acceptance never depends on a short-circuiting string compare.
  if (!entry || !timingSafeEqual(entry.digest, digest)) return null;
  return entry.grant;
}

export function revokeCodexGatewayToken(token: string): void {
  if (!TOKEN_PATTERN.test(token)) return;
  grants.delete(tokenDigest(token).toString('hex'));
}

/**
 * Point the live runners of one conversation at a new reasoning effort
 * (undefined: back to the default). The gateway reads the effort per request,
 * so the next upstream request already uses it. Isolated task runs and
 * host-side one-shot queries never serve a conversation and are left alone;
 * with `providerId`, so do runners that are on another configuration (a runner
 * that is being replaced by the choice that carries this effort).
 * Returns how many grants changed.
 */
export function updateLiveSessionEffort(
  conversation: {
    groupFolder: string;
    sessionAgentId?: string | null;
    providerId?: string;
  },
  effort: string | undefined,
): number {
  const sessionAgentId = conversation.sessionAgentId || null;
  let updated = 0;
  for (const { grant } of grants.values()) {
    const { owner } = grant;
    if (
      owner.kind === 'sdk-query' ||
      owner.groupFolder !== conversation.groupFolder ||
      (owner.agentId ?? null) !== sessionAgentId ||
      (conversation.providerId && grant.providerId !== conversation.providerId)
    ) {
      continue;
    }
    grant.sessionEffort = effort;
    updated += 1;
  }
  return updated;
}

/** Test/diagnostic hook: number of live runner tokens. */
export function countCodexGatewayTokens(): number {
  return grants.size;
}

/**
 * All gateway tokens issued for one runner process or one host-side query.
 * Create it before the launch, pass it to resolveCodexGatewayLaunchConfig, and
 * revoke it in the same finally block that ends the runner.
 */
export class CodexGatewayRunnerLease {
  private readonly issued: Array<{ token: string; grant: CodexGatewayGrant }> =
    [];
  private revoked = false;

  constructor(private readonly owner: CodexGatewayRunnerOwner) {}

  issue(providerId: string): string {
    if (this.revoked) throw new Error('Codex gateway lease already revoked');
    const issued = issueCodexGatewayToken(providerId, this.owner);
    this.issued.push(issued);
    return issued.token;
  }

  /** Verdict of the most recently answered request across this lease. */
  get lastVerdict(): CodexGatewayVerdict | null {
    for (let index = this.issued.length - 1; index >= 0; index -= 1) {
      const verdict = this.issued[index]?.grant.lastVerdict;
      if (verdict) return verdict;
    }
    return null;
  }

  revoke(): void {
    this.revoked = true;
    for (const { token } of this.issued.splice(0)) {
      revokeCodexGatewayToken(token);
    }
  }
}

/**
 * Single late substitution point for Codex providers: rewrite the stored
 * placeholder URL to the local gateway address for this execution mode and
 * replace the stored provider identifier with a runner-scoped token. Every
 * other provider config is returned unchanged.
 */
export function resolveCodexGatewayLaunchConfig<
  T extends { anthropicBaseUrl: string; anthropicAuthToken: string },
>(
  config: T,
  mode: CodexGatewayExecutionMode,
  lease: CodexGatewayRunnerLease | null | undefined,
): T {
  if (!isCodexGatewayBaseUrl(config.anthropicBaseUrl)) return config;
  const provider = findCodexProviderByGatewayIdentifier(
    config.anthropicAuthToken,
  );
  if (!provider || !lease) {
    logger.warn(
      { hasProvider: !!provider, hasLease: !!lease, mode },
      'Codex gateway: runner launched without a gateway grant; requests will be rejected',
    );
  }
  return {
    ...config,
    anthropicBaseUrl: resolveCodexGatewayBaseUrl(config.anthropicBaseUrl, mode),
    anthropicAuthToken: provider && lease ? lease.issue(provider.id) : '',
  };
}

/**
 * A gateway hop is local by construction. Keep it out of any configured HTTP
 * proxy so a forwarding proxy can neither see the runner token nor add the
 * forwarding headers the gateway refuses.
 */
export function codexGatewayNoProxyHost(
  mode: CodexGatewayExecutionMode,
): string {
  return mode === 'container' ? 'host.docker.internal' : '127.0.0.1';
}

function appendNoProxyHost(current: string | undefined, host: string): string {
  const entries = (current ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.includes(host)) entries.push(host);
  return entries.join(',');
}

/**
 * NO_PROXY for a runner environment that reaches the local gateway. Tools
 * disagree on which spelling wins, so both carry the same merged list.
 */
export function applyCodexGatewayNoProxy(
  env: Record<string, string | undefined>,
  mode: CodexGatewayExecutionMode,
): void {
  const merged = appendNoProxyHost(
    env.NO_PROXY || env.no_proxy,
    codexGatewayNoProxyHost(mode),
  );
  env.NO_PROXY = merged;
  env.no_proxy = merged;
}
