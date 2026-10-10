import type * as lark from '@larksuiteoapi/node-sdk';
import { createHash } from 'crypto';

import {
  classifyFeishuError,
  feishuErrorCode,
  feishuRetryAfterMs as feishuResponseRetryAfterMs,
} from './feishu-errors.js';
import type { ChannelTurnContext } from './types.js';

export type FeishuCapabilityOperation =
  | 'get_chat'
  | 'list_members'
  | 'get_user'
  | 'get_history'
  | 'send_card'
  | 'add_reaction'
  | 'remove_reaction'
  | 'edit_message'
  | 'recall_message'
  | 'api_request';

export interface FeishuCapabilityRequest {
  operation: FeishuCapabilityOperation;
  params?: Record<string, unknown>;
  /**
   * Broker-assigned Feishu `uuid` for message-creating operations (≤50
   * chars). Set by the durable Outbox from its idempotency identity so an
   * ambiguous send can be replayed safely within Feishu's one-hour dedupe
   * window. Never taken from runner-supplied params.
   */
  providerUuid?: string;
}

/** Feishu message `uuid` (≤50 chars) for a stable idempotency identity. */
export function feishuCapabilityUuid(identity: string): string {
  return `hc${createHash('sha256').update(identity).digest('hex').slice(0, 40)}`;
}

/** Serialized card size limit for send_card, in UTF-8 bytes. */
export const FEISHU_SEND_CARD_MAX_BYTES = 30 * 1024;
const SEND_CARD_RATE_LIMIT_RETRIES = 3;
const SEND_CARD_MAX_RETRY_AFTER_MS = 10_000;

export interface FeishuCapabilityResult {
  operation: FeishuCapabilityOperation;
  data: unknown;
}

/**
 * The broker or Feishu explicitly rejected a capability request before any
 * visible mutation could be accepted. The durable Outbox may safely record a
 * definitive failure or scheduled retry instead of fencing the whole turn as
 * uncertain.
 */
export class DefinitiveFeishuCapabilityError extends Error {
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: { cause?: unknown; retryAfterMs?: number } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'DefinitiveFeishuCapabilityError';
    this.retryAfterMs = options.retryAfterMs;
  }
}

const FEISHU_PRE_ACCEPTANCE_RETRY_DELAYS_MS = [2_000, 4_000] as const;

/**
 * Axios/Node can prove that a request never crossed the provider mutation
 * boundary in a small set of transport failures. In particular, HTTP content
 * cannot be sent before TLS is established. DNS and connection-refused errors
 * likewise happen before there is a provider socket to accept the request.
 *
 * Keep this deliberately narrower than a generic ECONNRESET/timeout check:
 * those errors can also happen after Feishu accepted the message and must
 * remain uncertain to avoid duplicate visible output.
 */
export function definitiveFeishuPreAcceptanceFailure(
  error: unknown,
): DefinitiveFeishuCapabilityError | null {
  if (error instanceof DefinitiveFeishuCapabilityError) return null;
  const value = record(error);
  if (Object.keys(record(value.response)).length > 0) return null;

  const code = optionalString(value.code);
  const message =
    error instanceof Error
      ? error.message
      : optionalString(value.message) || String(error);
  const disconnectedBeforeTls =
    /Client network socket disconnected before secure TLS connection was established/i.test(
      message,
    );
  const failedBeforeConnect =
    code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED';
  if (!disconnectedBeforeTls && !failedBeforeConnect) return null;

  return new DefinitiveFeishuCapabilityError(
    `Feishu was unreachable before the request was sent${code ? ` (${code})` : ''}`,
    { cause: error },
  );
}

/**
 * Retry only failures which prove that Feishu could not have accepted the
 * request. The retry happens inside one durable Outbox send attempt, so a
 * successful retry still persists exactly one provider acknowledgement.
 */
export async function withFeishuPreAcceptanceRetry<T>(
  operation: () => Promise<T>,
  options: {
    retryDelaysMs?: readonly number[];
    sleep?: (delayMs: number) => Promise<void>;
    onRetry?: (input: {
      attempt: number;
      nextAttempt: number;
      delayMs: number;
      error: DefinitiveFeishuCapabilityError;
    }) => void;
  } = {},
): Promise<T> {
  const retryDelaysMs =
    options.retryDelaysMs ?? FEISHU_PRE_ACCEPTANCE_RETRY_DELAYS_MS;
  const sleep =
    options.sleep ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const failure = definitiveFeishuPreAcceptanceFailure(error);
      const delayMs = retryDelaysMs[attempt - 1];
      if (!failure || delayMs === undefined) throw failure ?? error;
      options.onRetry?.({
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        error: failure,
      });
      await sleep(delayMs);
    }
  }
}

const FEISHU_READ_OPERATIONS = new Set<FeishuCapabilityOperation>([
  'get_chat',
  'list_members',
  'get_user',
  'get_history',
]);

/** Classify operations before they cross the durable side-effect boundary. */
export function isFeishuCapabilityMutation(
  request: FeishuCapabilityRequest,
): boolean {
  if (FEISHU_READ_OPERATIONS.has(request.operation)) return false;
  if (request.operation !== 'api_request') return true;
  const params =
    request.params &&
    typeof request.params === 'object' &&
    !Array.isArray(request.params)
      ? request.params
      : {};
  const method =
    typeof params.method === 'string' ? params.method.trim().toUpperCase() : '';
  return method !== '' && method !== 'GET';
}

const GENERIC_API_PREFIXES: ReadonlyArray<{
  prefix: string;
  methods: ReadonlySet<string>;
}> = [
  {
    prefix: '/open-apis/docx/',
    methods: new Set(['GET', 'POST', 'PATCH', 'DELETE']),
  },
  {
    prefix: '/open-apis/drive/',
    methods: new Set(['GET', 'POST', 'PATCH', 'DELETE']),
  },
  {
    prefix: '/open-apis/wiki/',
    methods: new Set(['GET', 'POST', 'PATCH']),
  },
  {
    prefix: '/open-apis/bitable/',
    methods: new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  },
  {
    prefix: '/open-apis/sheets/',
    methods: new Set(['GET', 'POST', 'PUT', 'PATCH']),
  },
  {
    prefix: '/open-apis/calendar/',
    methods: new Set(['GET', 'POST', 'PATCH', 'DELETE']),
  },
  {
    prefix: '/open-apis/task/',
    methods: new Set(['GET', 'POST', 'PATCH', 'DELETE']),
  },
  {
    prefix: '/open-apis/contact/',
    methods: new Set(['GET']),
  },
];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function feishuRetryAfterMs(
  response: Record<string, unknown>,
  error?: unknown,
): number {
  // Prefer Feishu's own reset hint (x-ogw-ratelimit-reset, seconds).
  const hinted =
    error === undefined ? undefined : feishuResponseRetryAfterMs(error);
  if (hinted !== undefined) {
    return Math.min(300_000, Math.max(1_000, hinted));
  }
  const headers = record(response.headers);
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const text =
    typeof value === 'number' || typeof value === 'string'
      ? String(value).trim()
      : '';
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return Math.min(300_000, Math.max(1_000, Number(text) * 1_000));
  }
  const retryAt = Date.parse(text);
  if (Number.isFinite(retryAt)) {
    return Math.min(300_000, Math.max(1_000, retryAt - Date.now()));
  }
  return 5_000;
}

function boundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

/**
 * Models frequently remember the legacy interactive-card wrappers while also
 * selecting Schema 2.0. Feishu rejects that mixed shape with HTTP 400 even
 * though the user-visible intent is unambiguous. Normalize only exact,
 * content-preserving legacy shapes at the trusted broker boundary:
 *
 * - `action.actions[]` -> standalone Schema 2.0 action elements
 * - `note` -> notation-sized markdown
 * - `header.theme.color_style` -> `header.template`
 *
 * Unknown elements remain untouched so the provider can return a definitive
 * validation error instead of the broker silently dropping content.
 */
export function normalizeFeishuCardForSend(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const card = { ...input };
  if (card.schema !== '2.0') return card;

  const header = record(card.header);
  if (Object.keys(header).length > 0) {
    const normalizedHeader = { ...header };
    const theme = record(normalizedHeader.theme);
    const legacyTemplate = optionalString(theme.color_style);
    if (
      !optionalString(normalizedHeader.template) &&
      legacyTemplate &&
      hasOnlyKeys(theme, ['color_style'])
    ) {
      normalizedHeader.template = legacyTemplate;
      delete normalizedHeader.theme;
    }
    card.header = normalizedHeader;
  }

  const body = record(card.body);
  if (Object.keys(body).length === 0 || !Array.isArray(body.elements)) {
    return card;
  }

  const elements: Record<string, unknown>[] = [];
  for (const value of body.elements) {
    const element = record(value);
    const tag = optionalString(element.tag);

    if (tag === 'action') {
      const actions = Array.isArray(element.actions) ? element.actions : [];
      const buttons = actions.map(record);
      const canFlatten =
        hasOnlyKeys(element, ['tag', 'actions']) &&
        buttons.length > 0 &&
        buttons.every(
          (button) =>
            optionalString(button.tag) === 'button' &&
            Object.keys(button).length > 1,
        );
      if (canFlatten) {
        elements.push(...buttons.map((button) => ({ ...button })));
        continue;
      }
    }

    if (tag === 'note') {
      const notes = Array.isArray(element.elements) ? element.elements : [];
      const plainTexts = notes.map(record);
      const canConvert =
        hasOnlyKeys(element, ['tag', 'elements']) &&
        plainTexts.length > 0 &&
        plainTexts.every(
          (text) =>
            optionalString(text.tag) === 'plain_text' &&
            Boolean(optionalString(text.content)) &&
            hasOnlyKeys(text, ['tag', 'content']),
        );
      if (canConvert) {
        elements.push({
          tag: 'markdown',
          content: plainTexts
            .map((text) => optionalString(text.content)!)
            .join(' · '),
          text_size: 'notation',
        });
        continue;
      }
    }

    elements.push({ ...element });
  }

  card.body = { ...body, elements };
  return card;
}

function assertApiSuccess(operation: string, response: unknown): void {
  const result = record(response);
  if (typeof result.code === 'number' && result.code !== 0) {
    throw new DefinitiveFeishuCapabilityError(
      `${operation} failed (code=${result.code}, msg=${optionalString(result.msg) || 'unknown'})`,
    );
  }
}

/**
 * The Lark SDK throws Axios-style errors for HTTP-level 4xx responses before
 * `assertApiSuccess()` can inspect the Feishu body. A received 4xx response is
 * still authoritative evidence that the provider rejected the mutation; only
 * timeouts/disconnects without a response remain uncertain.
 */
export function definitiveFeishuHttpRejection(
  error: unknown,
): DefinitiveFeishuCapabilityError | null {
  if (error instanceof DefinitiveFeishuCapabilityError) return error;
  const response = record(record(error).response);
  const status =
    typeof response.status === 'number' ? response.status : undefined;
  // HTTP 408 is commonly synthesized by an intermediary after the upstream
  // may already have accepted the request, so it retains the uncertain fence.
  if (status === undefined || status < 400 || status >= 500 || status === 408) {
    return null;
  }

  const data = record(response.data);
  const code =
    typeof data.code === 'number' || typeof data.code === 'string'
      ? String(data.code)
      : 'unknown';
  const detail = (optionalString(data.msg) || 'request rejected').slice(
    0,
    1000,
  );
  return new DefinitiveFeishuCapabilityError(
    `Feishu rejected the request (http=${status}, code=${code}, msg=${detail})`,
    {
      cause: error,
      ...(status === 429
        ? { retryAfterMs: feishuRetryAfterMs(response, error) }
        : {}),
    },
  );
}

function currentChatId(context: ChannelTurnContext): string {
  if (!context.chat?.id) {
    throw new DefinitiveFeishuCapabilityError(
      'Current Feishu chat id is missing',
    );
  }
  return context.chat.id;
}

function currentMessageId(context: ChannelTurnContext): string {
  if (!context.message?.id) {
    throw new DefinitiveFeishuCapabilityError(
      'Current Feishu message id is missing',
    );
  }
  return context.message.id;
}

function sanitizeMessage(item: unknown): Record<string, unknown> {
  const message = record(item);
  const sender = record(message.sender);
  const body = record(message.body);
  const content = optionalString(body.content);
  return {
    messageId: optionalString(message.message_id),
    rootId: optionalString(message.root_id),
    parentId: optionalString(message.parent_id),
    threadId: optionalString(message.thread_id),
    chatId: optionalString(message.chat_id),
    messageType: optionalString(message.msg_type),
    createTime: optionalString(message.create_time),
    updateTime: optionalString(message.update_time),
    deleted: message.deleted === true,
    updated: message.updated === true,
    sender: {
      id: optionalString(sender.id),
      idType: optionalString(sender.id_type),
      type: optionalString(sender.sender_type),
      name: optionalString(sender.sender_name),
      tenantKey: optionalString(sender.tenant_key),
      openBotId: optionalString(sender.open_bot_id),
    },
    content: content ? content.slice(0, 20_000) : '',
  };
}

async function assertMessageInCurrentChat(
  client: lark.Client,
  context: ChannelTurnContext,
  messageId: string,
): Promise<Record<string, unknown>> {
  const response = await client.im.v1.message.get({
    path: { message_id: messageId },
    params: { user_id_type: 'open_id', with_sender_name: true },
  });
  assertApiSuccess('get_message', response);
  const items = Array.isArray(response.data?.items) ? response.data.items : [];
  const message = items.find((item) => item.message_id === messageId);
  if (!message || message.chat_id !== currentChatId(context)) {
    throw new DefinitiveFeishuCapabilityError(
      'Message does not belong to the current Feishu chat',
    );
  }
  return sanitizeMessage(message);
}

async function assertMessageOwnedByCurrentBot(
  client: lark.Client,
  context: ChannelTurnContext,
  messageId: string,
): Promise<void> {
  const message = await assertMessageInCurrentChat(client, context, messageId);
  const sender = record(message.sender);
  const expected = new Set(
    [context.bot?.openId, context.bot?.appId].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    ),
  );
  const actual = [
    optionalString(sender.id),
    optionalString(sender.openBotId),
  ].filter((value): value is string => !!value);
  if (
    optionalString(sender.type) !== 'app' ||
    expected.size === 0 ||
    !actual.some((identity) => expected.has(identity))
  ) {
    throw new DefinitiveFeishuCapabilityError(
      'Message was not sent by the current bound Feishu Bot',
    );
  }
}

function resolveUserTarget(context: ChannelTurnContext): {
  userId: string;
  userIdType: 'open_id' | 'user_id' | 'union_id';
} {
  const sender = context.sender;
  if (sender?.openId) {
    return { userId: sender.openId, userIdType: 'open_id' };
  }
  if (sender?.userId) {
    return { userId: sender.userId, userIdType: 'user_id' };
  }
  if (sender?.unionId) {
    return { userId: sender.unionId, userIdType: 'union_id' };
  }
  throw new DefinitiveFeishuCapabilityError(
    'Current sender identity is unavailable',
  );
}

/**
 * Wait out an explicit Feishu rate limit inside one capability call: the
 * platform did not accept the request, so resending it (with the same uuid)
 * is safe. Bounded so a broker request never stalls for long.
 */
async function withCapabilityRateLimitRetry<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const classified = classifyFeishuError(error);
      if (
        classified.kind !== 'rate_limited' ||
        attempt >= SEND_CARD_RATE_LIMIT_RETRIES
      )
        throw error;
      const delayMs =
        classified.retryAfterMs ??
        (classified.code === 230020 ? 1_000 : 250) * 2 ** attempt;
      if (delayMs > SEND_CARD_MAX_RETRY_AFTER_MS) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function sanitizeGenericResponse(response: unknown): unknown {
  if (response == null || typeof response !== 'object') return response;
  const json = JSON.stringify(response, (key, value) => {
    const normalized = key.toLowerCase().replace(/[_-]/g, '');
    if (
      normalized.includes('token') ||
      normalized.includes('secret') ||
      normalized === 'authorization' ||
      normalized === 'cookie'
    ) {
      return undefined;
    }
    return value;
  });
  if (json.length > 2_000_000) {
    throw new DefinitiveFeishuCapabilityError(
      'Feishu API response exceeded the 2 MB broker limit',
    );
  }
  return JSON.parse(json) as unknown;
}

function validateGenericApiRequest(params: Record<string, unknown>): {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
} {
  const rawMethod = optionalString(params.method)?.toUpperCase();
  const method =
    rawMethod === 'POST' ||
    rawMethod === 'PUT' ||
    rawMethod === 'PATCH' ||
    rawMethod === 'DELETE'
      ? rawMethod
      : 'GET';
  const path = optionalString(params.path);
  if (
    !path ||
    path.includes('?') ||
    path.includes('#') ||
    path.includes('..') ||
    !/^\/open-apis\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(path)
  ) {
    throw new DefinitiveFeishuCapabilityError('Feishu API path is invalid');
  }
  const policy = GENERIC_API_PREFIXES.find((entry) =>
    path.startsWith(entry.prefix),
  );
  if (!policy || !policy.methods.has(method)) {
    throw new DefinitiveFeishuCapabilityError(
      `Feishu API ${method} ${path} is not broker-allowlisted`,
    );
  }
  return {
    method,
    path,
    query:
      params.query && typeof params.query === 'object'
        ? record(params.query)
        : undefined,
    body: params.body,
  };
}

/**
 * Execute one operation using the already authenticated Client owned by the
 * exact inbound Bot connection. The runner receives data, never credentials.
 */
export async function executeFeishuCapability(
  client: lark.Client,
  context: ChannelTurnContext,
  request: FeishuCapabilityRequest,
): Promise<FeishuCapabilityResult> {
  if (context.provider !== 'feishu') {
    throw new DefinitiveFeishuCapabilityError(
      'Feishu capability requires a Feishu input turn',
    );
  }
  const params = record(request.params);
  const chatId = currentChatId(context);

  switch (request.operation) {
    case 'get_chat': {
      const response = await client.im.v1.chat.get({
        path: { chat_id: chatId },
        params: { user_id_type: 'open_id' },
      });
      assertApiSuccess('get_chat', response);
      const data = record(response.data);
      return {
        operation: request.operation,
        data: {
          chatId: optionalString(data.chat_id) || chatId,
          name: optionalString(data.name),
          avatar: optionalString(data.avatar),
          description: optionalString(data.description),
          ownerId: optionalString(data.owner_id),
          ownerIdType: optionalString(data.owner_id_type),
          chatMode: optionalString(data.chat_mode),
          chatType: optionalString(data.chat_type),
          groupMessageType: optionalString(data.group_message_type),
          userCount: optionalString(data.user_count),
        },
      };
    }

    case 'list_members': {
      const response = await client.im.v1.chatMembers.get({
        path: { chat_id: chatId },
        params: {
          member_id_type: 'open_id',
          page_size: boundedInt(params.pageSize, 50, 1, 100),
          page_token: optionalString(params.pageToken),
        },
      });
      assertApiSuccess('list_members', response);
      return {
        operation: request.operation,
        data: {
          items: (response.data?.items || []).map((member) => ({
            id: member.member_id,
            idType: member.member_id_type,
            name: member.name,
            tenantKey: member.tenant_key,
          })),
          hasMore: response.data?.has_more === true,
          pageToken: response.data?.page_token,
          memberTotal: response.data?.member_total,
        },
      };
    }

    case 'get_user': {
      const { userId, userIdType } = resolveUserTarget(context);
      try {
        const response = await client.contact.v3.user.get({
          path: { user_id: userId },
          params: { user_id_type: userIdType },
        });
        assertApiSuccess('get_user', response);
        const user = response.data?.user;
        const publicUser = user as
          | (typeof user & { tenant_key?: string })
          | undefined;
        return {
          operation: request.operation,
          data: publicUser
            ? {
                openId: publicUser.open_id,
                userId: publicUser.user_id,
                unionId: publicUser.union_id,
                name: publicUser.name,
                enName: publicUser.en_name,
                avatar: publicUser.avatar,
                tenantKey: publicUser.tenant_key,
                employeeNo: publicUser.employee_no,
                employeeType: publicUser.employee_type,
                status: publicUser.status,
                source: 'contact_api',
                enrichmentStatus: 'complete',
              }
            : {
                ...context.sender,
                source: 'turn_context',
                enrichmentStatus: 'not_found',
              },
        };
      } catch (error) {
        // Incoming message events already carry the sender's stable IDs and
        // display name. Contact directory access is optional in Feishu, so a
        // Bot without that scope must still be able to identify the trusted
        // current sender without accepting an arbitrary user ID from the
        // runner.
        return {
          operation: request.operation,
          data: {
            ...context.sender,
            source: 'turn_context',
            enrichmentStatus: 'unavailable',
            enrichmentErrorCode: feishuErrorCode(error),
          },
        };
      }
    }

    case 'get_history': {
      const threadId = context.message?.threadId;
      const rootId = context.message?.rootId;
      const response = await client.im.v1.message.list({
        params: {
          container_id_type: threadId ? 'thread' : 'chat',
          container_id: threadId || chatId,
          sort_type: 'ByCreateTimeDesc',
          page_size: boundedInt(params.pageSize, 20, 1, 50),
          page_token: optionalString(params.pageToken),
          start_time: optionalString(params.startTime),
          end_time: optionalString(params.endTime),
          with_sender_name: true,
        },
      });
      assertApiSuccess('get_history', response);
      let items = response.data?.items || [];
      if (!threadId && rootId) {
        items = items.filter(
          (message) =>
            message.message_id === rootId || message.root_id === rootId,
        );
      }
      return {
        operation: request.operation,
        data: {
          items: items.map(sanitizeMessage),
          hasMore: response.data?.has_more === true,
          pageToken: response.data?.page_token,
          scope: threadId ? 'thread' : rootId ? 'root' : 'chat',
        },
      };
    }

    case 'send_card': {
      const requestedMessageId = optionalString(params.replyToMessageId);
      const messageId =
        requestedMessageId ||
        context.message?.rootId ||
        currentMessageId(context);
      if (requestedMessageId) {
        await assertMessageInCurrentChat(client, context, requestedMessageId);
      }
      const card = normalizeFeishuCardForSend(record(params.card));
      if (Object.keys(card).length === 0) {
        throw new DefinitiveFeishuCapabilityError('Card is required');
      }
      const serialized = JSON.stringify(card);
      if (Buffer.byteLength(serialized, 'utf8') > FEISHU_SEND_CARD_MAX_BYTES) {
        throw new DefinitiveFeishuCapabilityError(
          'Feishu card exceeds the 30 KB broker limit',
        );
      }
      // The Outbox assigns a uuid from its durable identity. Direct callers
      // get one derived from the exact turn message, target and payload, so a
      // replay of the same request within an hour cannot post twice.
      const uuid =
        request.providerUuid ??
        feishuCapabilityUuid(
          `send_card:${chatId}:${context.message?.id ?? ''}:${messageId}:${serialized}`,
        );
      const send = () =>
        client.im.v1.message.reply({
          path: { message_id: messageId },
          data: {
            msg_type: 'interactive',
            content: serialized,
            reply_in_thread: Boolean(
              context.message?.threadId || context.message?.rootId,
            ),
            uuid,
          },
        });
      const sendChecked = async () => {
        const result = await send();
        // A resolved rate-limit envelope is retried like a thrown one, and
        // stays a definitive (not uncertain) failure once retries run out.
        if (classifyFeishuError(result).kind === 'rate_limited') {
          const code = feishuErrorCode(result);
          throw Object.assign(
            new DefinitiveFeishuCapabilityError(
              `send_card failed (code=${code}, msg=${optionalString(record(result).msg) || 'rate limited'})`,
            ),
            { code },
          );
        }
        return result;
      };
      let response: Awaited<ReturnType<typeof send>>;
      try {
        response = await withCapabilityRateLimitRetry(sendChecked);
      } catch (error) {
        // An ambiguous transport failure may hide an accepted reply. Feishu
        // dedupes the uuid for an hour, so one replay either returns that
        // reply or creates it; only a successful replay resolves the doubt.
        if (
          classifyFeishuError(error).kind !== 'transient' ||
          definitiveFeishuPreAcceptanceFailure(error)
        )
          throw error;
        try {
          response = await withCapabilityRateLimitRetry(sendChecked);
        } catch {
          throw error;
        }
      }
      assertApiSuccess('send_card', response);
      return {
        operation: request.operation,
        data: {
          messageId: response.data?.message_id,
          rootId: response.data?.root_id,
          threadId: response.data?.thread_id,
        },
      };
    }

    case 'add_reaction': {
      const messageId =
        optionalString(params.messageId) || currentMessageId(context);
      if (messageId !== context.message?.id) {
        await assertMessageInCurrentChat(client, context, messageId);
      }
      const emojiType = optionalString(params.emojiType);
      if (!emojiType) {
        throw new DefinitiveFeishuCapabilityError('emojiType is required');
      }
      const response = await client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      assertApiSuccess('add_reaction', response);
      return {
        operation: request.operation,
        data: { messageId, reactionId: response.data?.reaction_id },
      };
    }

    case 'remove_reaction': {
      const messageId =
        optionalString(params.messageId) || currentMessageId(context);
      if (messageId !== context.message?.id) {
        await assertMessageInCurrentChat(client, context, messageId);
      }
      const reactionId = optionalString(params.reactionId);
      if (!reactionId) {
        throw new DefinitiveFeishuCapabilityError('reactionId is required');
      }
      const response = await client.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
      assertApiSuccess('remove_reaction', response);
      return {
        operation: request.operation,
        data: { messageId, reactionId, removed: true },
      };
    }

    case 'edit_message': {
      const messageId = optionalString(params.messageId);
      const text = typeof params.text === 'string' ? params.text : undefined;
      if (!messageId || text === undefined) {
        throw new DefinitiveFeishuCapabilityError(
          'messageId and text are required',
        );
      }
      await assertMessageOwnedByCurrentBot(client, context, messageId);
      const response = await client.im.v1.message.update({
        path: { message_id: messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text }) },
      });
      assertApiSuccess('edit_message', response);
      return {
        operation: request.operation,
        data: { messageId: response.data?.message_id || messageId },
      };
    }

    case 'recall_message': {
      const messageId = optionalString(params.messageId);
      if (!messageId) {
        throw new DefinitiveFeishuCapabilityError('messageId is required');
      }
      await assertMessageOwnedByCurrentBot(client, context, messageId);
      const response = await client.im.v1.message.delete({
        path: { message_id: messageId },
      });
      assertApiSuccess('recall_message', response);
      return {
        operation: request.operation,
        data: { messageId, recalled: true },
      };
    }

    case 'api_request': {
      const generic = validateGenericApiRequest(params);
      const response = await client.request({
        method: generic.method,
        url: generic.path,
        params: generic.query,
        data: generic.body,
      });
      assertApiSuccess('api_request', response);
      return {
        operation: request.operation,
        data: sanitizeGenericResponse(response),
      };
    }
  }
}
