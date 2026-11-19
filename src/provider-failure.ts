export const PROVIDER_FAILURE_USER_NOTICE =
  '⚠️ 当前模型服务额度已用尽或暂时不可用，本次处理已停止。请稍后重试，或联系管理员切换可用模型。';

/**
 * A liveness stall is not an account verdict, so it must not reuse the quota
 * wording. It is only surfaced after the bounded same-provider retry is spent.
 */
export const PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE =
  '⚠️ 模型服务本轮长时间没有任何响应，重试后仍未恢复，本次请求未被执行。这通常是上游暂时不可用或网络中断，与账号额度无关。请稍后重新发送。';

/**
 * A reported upstream error (529/5xx). Same disposition as a stall, but the
 * upstream did answer, so the wording must not claim it went silent.
 */
export const PROVIDER_TRANSIENT_FAILURE_USER_NOTICE =
  '⚠️ 模型服务上游暂时不可用（过载或服务端错误），重试后仍未恢复，本次请求未被执行。这与账号额度无关。请稍后重新发送。';

/**
 * A configuration verdict, not a capacity one. Retrying and failing over both
 * re-send the same unserviceable model name, so the user has to act.
 */
export const PROVIDER_MODEL_CONFIG_USER_NOTICE =
  '⚠️ 当前配置的模型在该服务端不存在或不可用，本次请求未被执行。这不是额度问题，重试或切换账号都无法解决，请在「模型配置」中检查模型名称。';

/**
 * An account verdict with a known remedy: the embedded ChatGPT/Codex gateway
 * found the provider's refresh grant rejected, so only a new login helps.
 */
export const CODEX_REAUTH_REQUIRED_USER_NOTICE =
  '⚠️ ChatGPT 订阅登录已失效，本次请求未被执行。请管理员在「模型配置」中重新登录 ChatGPT 后再发送。';

/**
 * A request the upstream refused as sent (a config failure that names its
 * reason): resending it is pointless, so the user has to change something.
 */
export const PROVIDER_REQUEST_REJECTED_USER_NOTICE =
  '⚠️ 模型服务拒绝了这次请求，本次请求未被执行。原样重试会得到同样的结果，请根据上游的说明调整连接、模型或设置后再发送。';

/**
 * A turn that still overflows the model's window after Claude Code compacted
 * the conversation: what is left is usually one input or attachment too
 * large for the model.
 */
export const PROVIDER_CONTEXT_OVERFLOW_USER_NOTICE =
  '⚠️ 这次请求超过了模型的上下文上限，自动压缩之后仍然放不下（多半是这条输入或附件太大）。请缩短后重新发送，或发送 /fresh 开一个新窗口。';

const UPSTREAM_EXCERPT_MAX_CHARS = 240;

/**
 * The upstream's own words about a failure as a notice may show them: the
 * message of a JSON error body if there is one, on one line, with addresses
 * and anything shaped like a key or token blanked, cut to a few hundred
 * characters. The notice also reaches IM groups, so it carries no more of
 * the upstream's answer than a user needs to act on.
 */
export function upstreamErrorExcerpt(
  text: string | null | undefined,
): string | undefined {
  let excerpt = text?.trim().replace(/^API Error:\s*/i, '');
  if (!excerpt) return undefined;
  const messages = [
    ...excerpt.matchAll(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g),
  ];
  const inner = messages.at(-1)?.[1];
  if (inner) {
    const status = /^\d{3}\b/.exec(excerpt)?.[0];
    try {
      excerpt = JSON.parse(`"${inner}"`) as string;
    } catch {
      excerpt = inner;
    }
    if (status && !excerpt.startsWith(status)) excerpt = `${status} ${excerpt}`;
  }
  excerpt = excerpt
    .replace(/\s+/g, ' ')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[已隐藏]')
    .replace(/\b(?:sk|pk|rk|ak)-[\w-]{8,}/gi, '[已隐藏]')
    .replace(/\b[A-Za-z0-9_]{32,}\b|[A-Za-z0-9+/]{40,}={0,2}/g, '[已隐藏]')
    .trim();
  if (!excerpt) return undefined;
  return excerpt.length > UPSTREAM_EXCERPT_MAX_CHARS
    ? `${excerpt.slice(0, UPSTREAM_EXCERPT_MAX_CHARS).trimEnd()}…`
    : excerpt;
}

/** Context overflow in the upstream's words, as Claude Code passes them on. */
const CONTEXT_OVERFLOW_TEXT =
  /prompt is too long|context (?:length|window)|maximum (?:context|prompt) length|exceeds? the maximum number of tokens|input is too long|too many (?:input )?tokens/i;

function withUpstreamExcerpt(
  notice: string,
  text: string | null | undefined,
): string {
  const excerpt = upstreamErrorExcerpt(text);
  return excerpt ? `${notice}\n上游返回：${excerpt}` : notice;
}

/** Failure classes as reported by the agent runner. */
export type ProviderFailureClass = 'account' | 'transient' | 'config';

/** The subset of an output that determines the failure class and its notice. */
export interface ProviderFailureClassification {
  readonly providerFailureClass?: ProviderFailureClass;
  readonly providerLivenessTimeout?: boolean;
  /** What the upstream said, when the runner passed it on. */
  readonly providerErrorText?: string;
}

/**
 * Resolve the class a failure must be dispositioned as.
 *
 * Defaults to `account` when the field is absent so that an output framed by an
 * older runner keeps its historical disposition rather than silently gaining
 * the never-quarantine transient path. `providerLivenessTimeout` is honoured on
 * its own for the same reason: a batch-1 runner emits the stall flag without a
 * class, and that stall must still avoid the quarantine.
 */
export function resolveProviderFailureClass(
  output: ProviderFailureClassification,
): ProviderFailureClass {
  if (output.providerFailureClass) return output.providerFailureClass;
  return output.providerLivenessTimeout ? 'transient' : 'account';
}

/**
 * The notice for a failure that has become terminal, or undefined when the
 * caller's own notice (an upstream limit text, or the generic pool notice)
 * should stand.
 */
export function resolveTerminalProviderFailureNotice(
  output: ProviderFailureClassification,
): string | undefined {
  const failureClass = resolveProviderFailureClass(output);
  const text = output.providerErrorText;
  if (failureClass === 'config') {
    if (text && CONTEXT_OVERFLOW_TEXT.test(text)) {
      return withUpstreamExcerpt(PROVIDER_CONTEXT_OVERFLOW_USER_NOTICE, text);
    }
    return upstreamErrorExcerpt(text)
      ? withUpstreamExcerpt(PROVIDER_REQUEST_REJECTED_USER_NOTICE, text)
      : PROVIDER_MODEL_CONFIG_USER_NOTICE;
  }
  if (failureClass !== 'transient') return undefined;
  return output.providerLivenessTimeout
    ? PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE
    : withUpstreamExcerpt(PROVIDER_TRANSIENT_FAILURE_USER_NOTICE, text);
}

/**
 * The notice of an account failure that ends the input: the runner's own
 * notice (an upstream limit text) when it has one, else the generic notice
 * with the upstream's words, which name the real cause (a 403 for a model
 * the subscription does not include reads as a quota wall otherwise).
 */
export function accountFailureNotice(output: {
  readonly providerFailureNotice?: string;
  readonly providerErrorText?: string;
}): string {
  return (
    output.providerFailureNotice ||
    withUpstreamExcerpt(PROVIDER_FAILURE_USER_NOTICE, output.providerErrorText)
  );
}

export interface ProviderFailureHealth {
  profileId: string;
  healthy: boolean;
}

export interface ProviderFailureDisposition {
  /** Another configured provider can replay the same durable input. */
  retryElsewhere: boolean;
  /** The provider pool is exhausted, so the user input must end visibly. */
  terminal: boolean;
}

/**
 * Decide whether an account/provider failure should remain a control-plane
 * retry signal or become a terminal user-visible failure.
 *
 * The failed provider must be quarantined before this function is called.
 */
export function resolveProviderFailureDisposition(
  selectedProfileId: string | null,
  health: ProviderFailureHealth[],
): ProviderFailureDisposition {
  const retryElsewhere =
    selectedProfileId !== null &&
    health.some(
      (candidate) =>
        candidate.profileId !== selectedProfileId && candidate.healthy,
    );
  return {
    retryElsewhere,
    terminal: !retryElsewhere,
  };
}

/** The identity fields a transient replay budget can be keyed on. */
export interface TransientRetryIdentity {
  readonly inputTurnId?: string;
  readonly ipcReceipts?: ReadonlyArray<{ cursor: { id: string } }>;
}

/**
 * A replay-stable identity for the input turn behind an output.
 *
 * `inputTurnId` is the IPC deliveryId for a warm turn, and that is a fresh UUID
 * on every hand-off — keying the retry budget on it would reset the budget on
 * each replay and never converge. The durable message id carried by the receipt
 * cursor survives replay, so prefer it. Cold turns already use the message id as
 * their ContainerInput.turnId, so they are stable either way.
 */
export function resolveTransientRetryKey(
  output: TransientRetryIdentity,
): string | undefined {
  return output.ipcReceipts?.[0]?.cursor?.id || output.inputTurnId;
}

/** Same-provider replay budget for one transient provider failure. */
export const DEFAULT_MAX_TRANSIENT_RETRIES = 1;
const DEFAULT_MAX_TRACKED_TRANSIENT_TURNS = 512;

/**
 * Bounded same-provider replay budget for transient provider failures — both
 * silent stalls and reported upstream errors — keyed by durable input turn.
 *
 * A transient failure judged no account, so the right answer is to run the same
 * input again rather than retire it. Each retry is a fresh runner, so the ledger
 * must live in the long-lived host process. It is what stops a permanently
 * wedged upstream from replaying one input forever.
 */
export class TransientRetryLedger {
  private readonly used = new Map<
    string,
    { attempts: number; profileId: string | null }
  >();

  constructor(
    private readonly maxRetries: number = DEFAULT_MAX_TRANSIENT_RETRIES,
    private readonly maxTracked: number = DEFAULT_MAX_TRACKED_TRANSIENT_TURNS,
  ) {}

  /**
   * @returns true when one more same-provider attempt is still allowed.
   *
   * Without a durable turn identity there is nothing to bound a replay with, so
   * this fails closed rather than risk an unbounded loop.
   */
  consume(
    inputTurnId: string | undefined,
    selectedProfileId: string | null = null,
  ): boolean {
    if (!inputTurnId) return false;
    const entry = this.used.get(inputTurnId);
    const spent = entry?.attempts ?? 0;
    if (
      spent >= this.maxRetries ||
      (entry && entry.profileId !== selectedProfileId)
    ) {
      this.used.delete(inputTurnId);
      return false;
    }
    // Turns that later succeed never come back to clear their entry, so evict
    // in insertion order instead of leaking one entry per stall.
    if (!this.used.has(inputTurnId) && this.used.size >= this.maxTracked) {
      const oldest = this.used.keys().next().value;
      if (oldest !== undefined) this.used.delete(oldest);
    }
    this.used.set(inputTurnId, {
      attempts: spent + 1,
      profileId: entry?.profileId ?? selectedProfileId,
    });
    return true;
  }

  clear(inputTurnId: string | undefined): void {
    if (inputTurnId) this.used.delete(inputTurnId);
  }

  /** Test/diagnostic hook: number of turns currently holding a spent retry. */
  get trackedTurnCount(): number {
    return this.used.size;
  }
}
