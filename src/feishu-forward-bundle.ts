import { classifyFeishuError } from './feishu-errors.js';
import { normalizeFeishuSender } from './feishu-intake-message.js';
import type { ChannelContentLink } from './types.js';

/**
 * Feishu emits "merged forward + note" as two physical messages. The note
 * has no dedicated flag: on real events it is a textual message whose
 * root_id and parent_id both point directly at the merge_forward root.
 */
export const FEISHU_FORWARD_COMPANION_MAX_GAP_MS = 60_000;
/**
 * Feishu can render a newly-created topic as a root message followed by an
 * immediate, paragraph-wrapped authored reply even though both provider
 * events are plain text. Keep this compatibility window and wrapper check
 * intentionally strict so ordinary topic replies never become implicit steer
 * requests.
 */
export const FEISHU_RAPID_TOPIC_COMPANION_MAX_GAP_MS = 2_000;
/**
 * A directly-authored caption/reply that immediately follows an image root.
 * The image root is never held for it: like a rapid topic root it runs at
 * once, and the caption asks the scheduler to coalesce into that run.
 */
export const FEISHU_MEDIA_TOPIC_COMPANION_MAX_GAP_MS = 3_000;
const FEISHU_FORWARD_FACT_TTL_MS = 60_000;
const FEISHU_FORWARD_FACT_MAX_ENTRIES = 1_000;
const FEISHU_FORWARD_LOOKUP_TIMEOUT_MS = 5_000;

export interface FeishuForwardCandidate {
  messageId: string;
  messageType: string;
  content: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  senderOpenId?: string;
  createTimeMs: number;
  chatType?: 'p2p' | 'group';
}

interface ForwardRootFact {
  kind: ChannelContentLink['kind'];
  shape: 'merge_forward' | 'rapid_topic' | 'media_topic';
  messageId: string;
  senderOpenId: string;
  createTimeMs: number;
  threadId?: string;
}

interface ForwardFactCacheEntry {
  observedAtMs: number;
  value: Promise<ForwardRootFact | undefined>;
}

interface FeishuMessageGetItem {
  message_id?: string;
  msg_type?: string;
  create_time?: string | number;
  thread_id?: string;
  root_id?: string;
  parent_id?: string;
  chat_type?: string;
  deleted?: boolean;
  body?: { content?: string };
  sender?: {
    id?: string;
    id_type?: string;
    sender_id?: { open_id?: string };
  };
}

export class TransientFeishuForwardLookupError extends Error {
  constructor(cause: unknown) {
    super('Feishu forward root lookup failed transiently', { cause });
    this.name = 'TransientFeishuForwardLookupError';
  }
}

function responseItems(response: unknown): FeishuMessageGetItem[] {
  if (!response || typeof response !== 'object') return [];
  const result = response as {
    data?: { items?: FeishuMessageGetItem[] };
    items?: FeishuMessageGetItem[];
  };
  const items = result.data?.items ?? result.items;
  return Array.isArray(items) ? items : [];
}

function toEpochMs(value: string | number | undefined): number {
  const numeric = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric < 1e12 ? Math.trunc(numeric * 1_000) : Math.trunc(numeric);
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`Feishu forward lookup timed out after ${timeoutMs}ms`),
        ),
      timeoutMs,
    );
    timer.unref?.();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function isParagraphWrappedText(content: string): boolean {
  const parsed = parseJsonObject(content);
  return (
    typeof parsed?.text === 'string' &&
    /^<p>[\s\S]*<\/p>$/i.test(parsed.text.trim())
  );
}

function postBodyNodeHasText(node: unknown, seen: Set<object>): boolean {
  if (!node || typeof node !== 'object') return false;
  if (seen.has(node as object)) return false;
  seen.add(node as object);
  if (Array.isArray(node)) {
    return node.some((child) => postBodyNodeHasText(child, seen));
  }
  const value = node as Record<string, unknown>;
  const tag = typeof value.tag === 'string' ? value.tag : undefined;
  if (
    (tag === 'text' || tag === 'md') &&
    typeof value.text === 'string' &&
    value.text.trim()
  ) {
    return true;
  }
  if (
    tag === 'a' &&
    ((typeof value.text === 'string' && value.text.trim()) ||
      (typeof value.href === 'string' && value.href.trim()))
  ) {
    return true;
  }
  if (
    tag === 'at' &&
    ((typeof value.key === 'string' && value.key.trim()) ||
      (typeof value.user_name === 'string' && value.user_name.trim()) ||
      (typeof value.user_id === 'string' && value.user_id.trim()))
  ) {
    return true;
  }
  return false;
}

function postDocumentHasText(document: unknown): boolean {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return false;
  }
  const value = document as Record<string, unknown>;
  if (typeof value.title === 'string' && value.title.trim()) return true;
  return postBodyNodeHasText(value.content, new Set());
}

/** Inspect the original provider shape, never flattened media placeholders. */
export function hasAuthoredFeishuText(
  messageType: string,
  content: string,
): boolean {
  const parsed = parseJsonObject(content);
  if (!parsed) return false;
  if (messageType === 'text') {
    return typeof parsed.text === 'string' && parsed.text.trim().length > 0;
  }
  if (messageType !== 'post') return false;
  if (postDocumentHasText(parsed)) return true;
  const nestedPost =
    parsed.post &&
    typeof parsed.post === 'object' &&
    !Array.isArray(parsed.post)
      ? (parsed.post as Record<string, unknown>)
      : parsed;
  if (!nestedPost || typeof nestedPost !== 'object') {
    return false;
  }
  return Object.entries(nestedPost).some(
    ([locale, document]) =>
      /^[a-z]{2}_[a-z]{2}$/i.test(locale) && postDocumentHasText(document),
  );
}

/**
 * message.get refused for a reason a retry cannot change (missing scope, root
 * invisible to the Bot, recalled root). The note is then simply not a
 * companion; throwing would retry the whole intake forever.
 */
function isDeterministicLookupRejection(error: unknown): boolean {
  const kind = classifyFeishuError(error).kind;
  return (
    kind === 'definitive' ||
    kind === 'target_unavailable' ||
    kind === 'content_rejected'
  );
}

function rootContentLink(messageId: string): ChannelContentLink {
  return {
    kind: 'forward_bundle',
    bundleId: messageId,
    role: 'forwarded_content',
  };
}

function isMediaTopicRoot(candidate: FeishuForwardCandidate): boolean {
  return (
    candidate.chatType === 'group' &&
    candidate.messageType === 'image' &&
    Boolean(candidate.threadId) &&
    !candidate.rootId &&
    !candidate.parentId
  );
}

function isRapidTopicRoot(candidate: FeishuForwardCandidate): boolean {
  return (
    candidate.chatType === 'group' &&
    candidate.messageType === 'text' &&
    Boolean(candidate.threadId) &&
    !candidate.rootId &&
    !candidate.parentId &&
    hasAuthoredFeishuText(candidate.messageType, candidate.content)
  );
}

/**
 * Per-connection, bounded fact cache. Promise entries collapse concurrent
 * note-first lookups. Failed/empty/deleted lookups are not negative-cached;
 * a later real root event can always replace an in-flight probe.
 */
export class FeishuForwardBundleResolver {
  private readonly facts = new Map<string, ForwardFactCacheEntry>();

  constructor(
    private readonly lookupMessage: (messageId: string) => Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(nowMs = this.now()): void {
    for (const [messageId, entry] of this.facts) {
      if (nowMs - entry.observedAtMs > FEISHU_FORWARD_FACT_TTL_MS) {
        this.facts.delete(messageId);
      }
    }
    while (this.facts.size > FEISHU_FORWARD_FACT_MAX_ENTRIES) {
      const oldest = this.facts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.facts.delete(oldest);
    }
  }

  private setFact(messageId: string, entry: ForwardFactCacheEntry): void {
    // Map#set does not refresh insertion order. Reinsert so the bounded cache
    // evicts the genuinely oldest observation rather than a recently updated
    // root that happened to have an old key.
    this.facts.delete(messageId);
    this.facts.set(messageId, entry);
  }

  observeRoot(
    candidate: FeishuForwardCandidate,
  ): ChannelContentLink | undefined {
    const mergeForward = candidate.messageType === 'merge_forward';
    const rapidTopic = isRapidTopicRoot(candidate);
    const mediaTopic = isMediaTopicRoot(candidate);
    if (!mergeForward && !rapidTopic && !mediaTopic) return undefined;
    if (
      candidate.senderOpenId &&
      Number.isFinite(candidate.createTimeMs) &&
      candidate.createTimeMs > 0
    ) {
      const fact: ForwardRootFact = {
        kind: mergeForward ? 'forward_bundle' : 'rapid_topic_bundle',
        shape: mergeForward
          ? 'merge_forward'
          : rapidTopic
            ? 'rapid_topic'
            : 'media_topic',
        messageId: candidate.messageId,
        senderOpenId: candidate.senderOpenId,
        createTimeMs: candidate.createTimeMs,
        ...(candidate.threadId ? { threadId: candidate.threadId } : {}),
      };
      this.setFact(candidate.messageId, {
        observedAtMs: this.now(),
        value: Promise.resolve(fact),
      });
      this.prune();
    }
    // A plain or image topic root is only a provisional candidate. It runs
    // as an ordinary current request (an image root no longer waits 3s, and
    // its download failure is an ordinary `[图片下载失败]`, not missing
    // forward material); a provider-structured companion arriving inside the
    // tight window coalesces into that run through the scheduler.
    return mergeForward ? rootContentLink(candidate.messageId) : undefined;
  }

  private lookupRoot(messageId: string): Promise<ForwardRootFact | undefined> {
    this.prune();
    const cached = this.facts.get(messageId);
    if (cached) return cached.value;

    const probe = withTimeout(
      this.lookupMessage(messageId).catch((error: unknown) => {
        if (isDeterministicLookupRejection(error)) return null;
        throw error;
      }),
      FEISHU_FORWARD_LOOKUP_TIMEOUT_MS,
    ).then((response) => {
      if (response === null) {
        return { definitive: true, fact: undefined } as const;
      }
      const items = responseItems(response);
      const item =
        items.find((candidate) => candidate.message_id === messageId) ??
        items.find((candidate) => !candidate.message_id);
      if (!item || item.deleted) {
        return { definitive: false, fact: undefined } as const;
      }
      const mergeForward = item.msg_type === 'merge_forward';
      const mediaTopic =
        item.msg_type === 'image' &&
        Boolean(item.thread_id) &&
        !item.root_id &&
        !item.parent_id &&
        (!item.chat_type || item.chat_type === 'group');
      const rapidTopic =
        item.msg_type === 'text' &&
        Boolean(item.thread_id) &&
        !item.root_id &&
        !item.parent_id &&
        (!item.chat_type || item.chat_type === 'group') &&
        typeof item.body?.content === 'string' &&
        hasAuthoredFeishuText('text', item.body.content);
      if (!mergeForward && !rapidTopic && !mediaTopic) {
        return { definitive: true, fact: undefined } as const;
      }
      const senderOpenId = normalizeFeishuSender(item.sender).openId;
      const createTimeMs = toEpochMs(item.create_time);
      if (
        !senderOpenId ||
        !Number.isFinite(createTimeMs) ||
        createTimeMs <= 0
      ) {
        return { definitive: false, fact: undefined } as const;
      }
      return {
        definitive: true,
        fact: {
          kind: mergeForward ? 'forward_bundle' : 'rapid_topic_bundle',
          shape: mergeForward
            ? 'merge_forward'
            : rapidTopic
              ? 'rapid_topic'
              : 'media_topic',
          messageId: item.message_id || messageId,
          senderOpenId,
          createTimeMs,
          ...(item.thread_id ? { threadId: item.thread_id } : {}),
        } satisfies ForwardRootFact,
      } as const;
    });
    let value!: Promise<ForwardRootFact | undefined>;
    value = probe.then(
      (result) => result.fact,
      (error) => {
        if (this.facts.get(messageId)?.value === value) {
          this.facts.delete(messageId);
        }
        throw new TransientFeishuForwardLookupError(error);
      },
    );
    this.setFact(messageId, { observedAtMs: this.now(), value });
    void probe.then(
      (result) => {
        if (
          !result.definitive &&
          !result.fact &&
          this.facts.get(messageId)?.value === value
        ) {
          this.facts.delete(messageId);
        }
      },
      () => undefined,
    );
    this.prune();
    return value;
  }

  async resolveCompanion(
    candidate: FeishuForwardCandidate,
  ): Promise<ChannelContentLink | undefined> {
    if (
      (candidate.messageType !== 'text' && candidate.messageType !== 'post') ||
      !hasAuthoredFeishuText(candidate.messageType, candidate.content)
    ) {
      return undefined;
    }
    const rootId = candidate.rootId;
    if (!rootId || candidate.parentId !== rootId) return undefined;

    const lookup = this.lookupRoot(rootId);
    let fact: ForwardRootFact | undefined;
    try {
      fact = await lookup;
    } catch (error) {
      const replacement = this.facts.get(rootId)?.value;
      if (!replacement || replacement === lookup) throw error;
      fact = await replacement;
    }
    const latest = this.facts.get(rootId)?.value;
    if (!fact && latest && latest !== lookup) fact = await latest;
    if (!fact || fact.senderOpenId !== candidate.senderOpenId) return undefined;
    if (fact.shape === 'rapid_topic') {
      if (
        candidate.messageType !== 'text' ||
        !isParagraphWrappedText(candidate.content) ||
        candidate.chatType !== 'group' ||
        !fact.threadId ||
        !candidate.threadId ||
        fact.threadId !== candidate.threadId
      ) {
        return undefined;
      }
    } else if (
      fact.threadId &&
      candidate.threadId &&
      fact.threadId !== candidate.threadId
    ) {
      return undefined;
    }
    if (
      fact.shape === 'media_topic' &&
      (candidate.chatType !== 'group' ||
        !fact.threadId ||
        !candidate.threadId ||
        fact.threadId !== candidate.threadId)
    ) {
      return undefined;
    }
    const gapMs = candidate.createTimeMs - fact.createTimeMs;
    const maxGapMs =
      fact.shape === 'rapid_topic'
        ? FEISHU_RAPID_TOPIC_COMPANION_MAX_GAP_MS
        : fact.shape === 'media_topic'
          ? FEISHU_MEDIA_TOPIC_COMPANION_MAX_GAP_MS
          : FEISHU_FORWARD_COMPANION_MAX_GAP_MS;
    if (gapMs < 0 || gapMs > maxGapMs) {
      return undefined;
    }
    return {
      kind: fact.kind,
      bundleId: rootId,
      role: 'forwarder_comment',
      relatedMessageId: rootId,
    };
  }
}
