import type * as lark from '@larksuiteoapi/node-sdk';

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
}

export interface FeishuCapabilityResult {
  operation: FeishuCapabilityOperation;
  data: unknown;
}

/**
 * The broker or Feishu explicitly rejected a capability request before any
 * visible mutation could be accepted. The durable Outbox may safely record a
 * definitive failure instead of fencing the whole turn as uncertain.
 */
export class DefinitiveFeishuCapabilityError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'DefinitiveFeishuCapabilityError';
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

function assertApiSuccess(operation: string, response: unknown): void {
  const result = record(response);
  if (typeof result.code === 'number' && result.code !== 0) {
    throw new DefinitiveFeishuCapabilityError(
      `${operation} failed (code=${result.code}, msg=${optionalString(result.msg) || 'unknown'})`,
    );
  }
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

function feishuErrorCode(error: unknown): number | undefined {
  const response = record(record(error).response);
  const data = record(response.data);
  return typeof data.code === 'number' ? data.code : undefined;
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
      const card = record(params.card);
      if (Object.keys(card).length === 0) {
        throw new DefinitiveFeishuCapabilityError('Card is required');
      }
      const serialized = JSON.stringify(card);
      if (serialized.length > 30_000) {
        throw new DefinitiveFeishuCapabilityError(
          'Feishu card exceeds the 30 KB broker limit',
        );
      }
      const response = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'interactive',
          content: serialized,
          reply_in_thread: Boolean(
            context.message?.threadId || context.message?.rootId,
          ),
        },
      });
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
