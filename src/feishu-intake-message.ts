/**
 * Shapes and pure helpers shared by the Feishu intake paths (WS events,
 * message.list backfill, message.get lookups).
 *
 * The REST list/get APIs do not return the event shape: a mention's `id` is a
 * plain string next to `id_type`, and the sender is `{ id, id_type }` instead
 * of `sender_id: { open_id }`. Every path that turns a REST item into an
 * inbound payload must normalize it here, or structural checks such as the
 * @Bot mention gate silently read `undefined`.
 */
export interface FeishuMentionLike {
  key?: string;
  name?: string;
  id?: { open_id?: string; user_id?: string; union_id?: string };
}

export interface FeishuNormalizedSender {
  openId?: string;
  userId?: string;
  unionId?: string;
  name?: string;
  tenantKey?: string;
  type?: string;
}

export interface IncomingMessagePayload {
  chatId: string;
  messageId: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  createTimeMs: number;
  messageType: string;
  content: string;
  chatType?: string;
  mentions?: FeishuMentionLike[];
  senderOpenId?: string;
  senderUserId?: string;
  senderUnionId?: string;
  senderName?: string;
  senderTenantKey?: string;
  senderType?: string;
  /**
   * Set by backfill for items at/before the durable chat cursor whose Inbox
   * row had to be created again. Such an item may already have been ingested
   * before its Inbox row was pruned, so intake checks the permanent message
   * table before running it.
   */
  backfilledBeforeCursor?: boolean;
}

type Recordish = Record<string, unknown>;

function record(value: unknown): Recordish | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Recordish)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function idObject(
  id: string,
  idType: string | undefined,
): FeishuMentionLike['id'] | undefined {
  switch (idType ?? 'open_id') {
    case 'open_id':
      return { open_id: id };
    case 'user_id':
      return { user_id: id };
    case 'union_id':
      return { union_id: id };
    default:
      // app_id and other identity kinds cannot match a user/Bot open_id.
      return undefined;
  }
}

/** Accept both the event shape (`id: {open_id}`) and the REST shape. */
export function normalizeFeishuMentions(
  mentions: unknown,
): FeishuMentionLike[] | undefined {
  if (!Array.isArray(mentions)) return undefined;
  return mentions.flatMap((raw): FeishuMentionLike[] => {
    const mention = record(raw);
    if (!mention) return [];
    let id: FeishuMentionLike['id'] | undefined;
    if (typeof mention.id === 'string') {
      const value = mention.id.trim();
      id = value ? idObject(value, text(mention.id_type)) : undefined;
    } else {
      const ids = record(mention.id);
      if (ids) {
        id = {
          ...(text(ids.open_id) ? { open_id: String(ids.open_id) } : {}),
          ...(text(ids.user_id) ? { user_id: String(ids.user_id) } : {}),
          ...(text(ids.union_id) ? { union_id: String(ids.union_id) } : {}),
        };
      }
    }
    return [
      {
        ...(text(mention.key) ? { key: String(mention.key) } : {}),
        ...(text(mention.name) ? { name: String(mention.name) } : {}),
        ...(id ? { id } : {}),
      },
    ];
  });
}

/** Accept both `sender_id: {open_id,…}` (events) and `{id, id_type}` (REST). */
export function normalizeFeishuSender(sender: unknown): FeishuNormalizedSender {
  const value = record(sender);
  if (!value) return {};
  const senderId = record(value.sender_id);
  const restId =
    text(value.id) && typeof value.id === 'string'
      ? idObject(value.id.trim(), text(value.id_type))
      : undefined;
  const openId = text(senderId?.open_id) ?? restId?.open_id;
  const userId = text(senderId?.user_id) ?? restId?.user_id;
  const unionId = text(senderId?.union_id) ?? restId?.union_id;
  return {
    ...(openId ? { openId } : {}),
    ...(userId ? { userId } : {}),
    ...(unionId ? { unionId } : {}),
    ...(text(value.sender_name) || text(value.name)
      ? { name: (text(value.sender_name) ?? text(value.name))! }
      : {}),
    ...(text(value.tenant_key) ? { tenantKey: String(value.tenant_key) } : {}),
    ...(text(value.sender_type) ? { type: String(value.sender_type) } : {}),
  };
}

export function feishuEpochMs(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric < 1e12 ? Math.trunc(numeric * 1000) : Math.trunc(numeric);
}

/**
 * Turn one message.list/message.get item into the same payload a WS event
 * produces. Returns undefined for deleted items, the Bot's own messages and
 * items without an id. `chatType` must come from a trusted chat lookup: the
 * REST item does not carry it, and guessing `group` flips mention and
 * runtime-control eligibility for private chats.
 */
export function normalizeListApiMessage(
  item: unknown,
  context: { chatId: string; chatType?: 'p2p' | 'group'; threadId?: string },
): IncomingMessagePayload | undefined {
  const value = record(item);
  if (!value) return undefined;
  const messageId = text(value.message_id);
  if (!messageId || value.deleted === true) return undefined;
  const sender = normalizeFeishuSender(value.sender);
  // Bot (app) messages, including our own replies, are never inbound input.
  if (sender.type === 'app') return undefined;
  const body = record(value.body);
  const itemChatType =
    value.chat_type === 'p2p' || value.chat_type === 'group'
      ? value.chat_type
      : undefined;
  const threadId = text(value.thread_id) ?? context.threadId;
  return {
    chatId: context.chatId,
    messageId,
    ...(text(value.root_id) ? { rootId: String(value.root_id) } : {}),
    ...(text(value.parent_id) ? { parentId: String(value.parent_id) } : {}),
    ...(threadId ? { threadId } : {}),
    createTimeMs: feishuEpochMs(value.create_time),
    messageType: text(value.msg_type) ?? text(value.message_type) ?? '',
    content:
      (typeof body?.content === 'string' ? body.content : undefined) ??
      (typeof value.content === 'string' ? value.content : ''),
    ...((itemChatType ?? context.chatType)
      ? { chatType: itemChatType ?? context.chatType }
      : {}),
    ...(Array.isArray(value.mentions)
      ? { mentions: normalizeFeishuMentions(value.mentions) }
      : {}),
    senderOpenId: sender.openId ?? '',
    ...(sender.userId ? { senderUserId: sender.userId } : {}),
    ...(sender.unionId ? { senderUnionId: sender.unionId } : {}),
    ...(sender.name ? { senderName: sender.name } : {}),
    ...(sender.tenantKey ? { senderTenantKey: sender.tenantKey } : {}),
    ...(sender.type ? { senderType: sender.type } : {}),
  };
}

/** `chat_mode` (p2p/group/topic) is authoritative; `chat_type` may be private/public. */
export function feishuChatTypeFromMode(
  chatMode: string | undefined,
  chatType?: string,
): 'p2p' | 'group' | undefined {
  if (chatMode === 'p2p') return 'p2p';
  if (chatMode === 'group' || chatMode === 'topic') return 'group';
  if (chatType === 'p2p' || chatType === 'group') return chatType;
  return undefined;
}

export const FEISHU_INBOUND_MAX_FAILURES = 8;
const FEISHU_INBOUND_RETRY_BASE_MS = 5_000;
const FEISHU_INBOUND_RETRY_MAX_MS = 10 * 60_000;

/** Exponential 5s → 10min backoff for the n-th (1-based) intake failure. */
export function feishuInboundRetryDelayMs(failures: number): number {
  const exponent = Math.max(0, Math.min(failures - 1, 16));
  return Math.min(
    FEISHU_INBOUND_RETRY_MAX_MS,
    FEISHU_INBOUND_RETRY_BASE_MS * 2 ** exponent,
  );
}

/** Durable per-row bookkeeping kept beside the normalized payload. */
export interface FeishuIntakeState {
  /** Intake failures that scheduled a retry (bounded by MAX_FAILURES). */
  failures: number;
  /** Passes spent waiting on merged-forward companions/material. */
  forwardMaterialAttempt: number;
}

export function readFeishuIntakeState(
  normalizedPayload: unknown,
): FeishuIntakeState {
  const intake = record(record(normalizedPayload)?.intake);
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? value
      : 0;
  return {
    failures: count(intake?.failures),
    forwardMaterialAttempt: count(intake?.forwardMaterialAttempt),
  };
}

/** Attach intake bookkeeping without disturbing the payload's own shape. */
export function withFeishuIntakeState(
  normalizedPayload: unknown,
  state: FeishuIntakeState,
): unknown {
  if (!state.failures && !state.forwardMaterialAttempt) {
    return normalizedPayload;
  }
  const base = record(normalizedPayload) ?? {};
  return { ...base, intake: { ...state } };
}
