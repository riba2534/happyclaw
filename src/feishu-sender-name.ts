/**
 * Feishu `im.message.receive_v1` events identify the sender only by IDs; they
 * carry no display name. Without a lookup every inbound message is persisted
 * and shown to the Agent with the raw open_id as its sender name, which makes
 * group members indistinguishable in transcripts.
 *
 * Two optional sources can name a sender:
 *
 * - The group member list (`im.v1.chatMembers.get`) names every member of a
 *   group in one paged request, using the chat read scope the Bot already
 *   needs for chat info. Groups ask it first.
 * - The contact directory (`contact.v3.user.get`) names one user, but needs a
 *   contact scope and the user inside the app's contact range. It covers
 *   private chats and group senders the member list did not return.
 *
 * Every failure degrades to "no name" instead of blocking the inbound
 * pipeline: callers wait at most `timeoutMs` (a slow request keeps filling the
 * cache in the background), a source whose scope the app lacks is skipped for
 * a while instead of failing once per sender, and concurrent lookups share
 * one request.
 */

export type FeishuSenderNameSource = 'contact' | 'chat_members';

/**
 * - `missing_scope`: the app lacks the permission for this source; stop
 *   asking it for `missingScopeBackoffMs`.
 * - `transient`: timeout, rate limit, 5xx; retry after `transientTtlMs`.
 * - `definitive`: this sender or chat cannot be named by this source.
 */
export type FeishuSenderNameErrorKind =
  | 'missing_scope'
  | 'transient'
  | 'definitive';

export interface FeishuChatMemberPage {
  members: Array<{ openId: string; name?: string }>;
  hasMore: boolean;
  pageToken?: string;
}

export interface FeishuSenderNameResolverOptions {
  /** Contact directory lookup of one open_id. */
  lookup: (openId: string) => Promise<string | undefined>;
  /** One page of a group's member list. */
  listChatMembers?: (
    chatId: string,
    pageToken: string | undefined,
  ) => Promise<FeishuChatMemberPage>;
  classifyError?: (error: unknown) => FeishuSenderNameErrorKind;
  now?: () => number;
  /** How long a caller waits for a name before falling back. */
  timeoutMs?: number;
  /** Upper bound for one provider request, so a hung call cannot pin dedup. */
  requestTimeoutMs?: number;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  transientTtlMs?: number;
  missingScopeBackoffMs?: number;
  /** A sender missing from a member list older than this refetches it. */
  memberListRefreshMs?: number;
  maxMemberPages?: number;
  maxEntries?: number;
  maxChats?: number;
  onLookupError?: (
    source: FeishuSenderNameSource,
    target: string,
    error: unknown,
  ) => void;
  /** Called once each time a source is suspended for a missing scope. */
  onMissingScope?: (source: FeishuSenderNameSource, error: unknown) => void;
}

export interface FeishuSenderNameResolver {
  /**
   * Resolve a display name, or `undefined` when none is available. Pass the
   * chat id for group messages so the member list can be used.
   */
  resolve(openId: string, groupChatId?: string): Promise<string | undefined>;
  /** Return a fresh cached name without issuing a request. */
  peek(openId: string): string | undefined;
}

export const FEISHU_SENDER_NAME_TIMEOUT_MS = 3_000;
export const FEISHU_SENDER_NAME_REQUEST_TIMEOUT_MS = 10_000;
export const FEISHU_SENDER_NAME_POSITIVE_TTL_MS = 6 * 60 * 60 * 1000;
export const FEISHU_SENDER_NAME_NEGATIVE_TTL_MS = 10 * 60 * 1000;
export const FEISHU_SENDER_NAME_TRANSIENT_TTL_MS = 60 * 1000;
export const FEISHU_SENDER_NAME_MISSING_SCOPE_BACKOFF_MS = 30 * 60 * 1000;
export const FEISHU_SENDER_NAME_MEMBER_LIST_REFRESH_MS = 60 * 1000;
export const FEISHU_SENDER_NAME_MAX_MEMBER_PAGES = 5;
export const FEISHU_SENDER_NAME_MAX_ENTRIES = 2_000;
export const FEISHU_SENDER_NAME_MAX_CHATS = 64;

interface NameEntry {
  name: string | undefined;
  expiresAt: number;
}

interface MemberListEntry {
  /** open_id -> name; empty when the fetch failed. */
  members: Map<string, string>;
  fetchedAt: number;
  expiresAt: number;
  failed: boolean;
}

/** Insert as most recent and evict the oldest entries beyond `max`. */
function touch<V>(map: Map<string, V>, key: string, value: V, max: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    timer.unref?.();
    promise.then(
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

/** Resolve to `undefined` after `ms`, leaving the underlying work running. */
function waitAtMost<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

function cleanName(value: unknown): string | undefined {
  const name = typeof value === 'string' ? value.trim() : '';
  return name || undefined;
}

export function createFeishuSenderNameResolver(
  options: FeishuSenderNameResolverOptions,
): FeishuSenderNameResolver {
  const now = options.now ?? Date.now;
  const classifyError = options.classifyError ?? (() => 'definitive');
  const timeoutMs = options.timeoutMs ?? FEISHU_SENDER_NAME_TIMEOUT_MS;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? FEISHU_SENDER_NAME_REQUEST_TIMEOUT_MS;
  const positiveTtlMs =
    options.positiveTtlMs ?? FEISHU_SENDER_NAME_POSITIVE_TTL_MS;
  const negativeTtlMs =
    options.negativeTtlMs ?? FEISHU_SENDER_NAME_NEGATIVE_TTL_MS;
  const transientTtlMs =
    options.transientTtlMs ?? FEISHU_SENDER_NAME_TRANSIENT_TTL_MS;
  const missingScopeBackoffMs =
    options.missingScopeBackoffMs ??
    FEISHU_SENDER_NAME_MISSING_SCOPE_BACKOFF_MS;
  const memberListRefreshMs =
    options.memberListRefreshMs ?? FEISHU_SENDER_NAME_MEMBER_LIST_REFRESH_MS;
  const maxMemberPages = Math.max(
    1,
    options.maxMemberPages ?? FEISHU_SENDER_NAME_MAX_MEMBER_PAGES,
  );
  const maxEntries = Math.max(
    1,
    options.maxEntries ?? FEISHU_SENDER_NAME_MAX_ENTRIES,
  );
  const maxChats = Math.max(
    1,
    options.maxChats ?? FEISHU_SENDER_NAME_MAX_CHATS,
  );

  const names = new Map<string, NameEntry>();
  const memberLists = new Map<string, MemberListEntry>();
  const inFlight = new Map<string, Promise<string | undefined>>();
  const memberListsInFlight = new Map<
    string,
    Promise<MemberListEntry | undefined>
  >();
  const suspendedUntil: Record<FeishuSenderNameSource, number> = {
    contact: 0,
    chat_members: 0,
  };

  function freshName(openId: string): NameEntry | undefined {
    const entry = names.get(openId);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      names.delete(openId);
      return undefined;
    }
    return entry;
  }

  function rememberName(openId: string, name: string | undefined, ttl: number) {
    touch(names, openId, { name, expiresAt: now() + ttl }, maxEntries);
  }

  function isSuspended(source: FeishuSenderNameSource): boolean {
    return now() < suspendedUntil[source];
  }

  /**
   * How long to remember a failure. A missing scope suspends the whole source
   * instead and returns `undefined`: it says nothing about this sender.
   */
  function failureTtl(
    source: FeishuSenderNameSource,
    target: string,
    error: unknown,
  ): number | undefined {
    const kind = classifyError(error);
    if (kind === 'missing_scope') {
      if (!isSuspended(source)) {
        suspendedUntil[source] = now() + missingScopeBackoffMs;
        options.onMissingScope?.(source, error);
      }
      return undefined;
    }
    options.onLookupError?.(source, target, error);
    return kind === 'transient' ? transientTtlMs : negativeTtlMs;
  }

  async function fetchMemberList(chatId: string): Promise<MemberListEntry> {
    const listChatMembers = options.listChatMembers!;
    const members = new Map<string, string>();
    try {
      let pageToken: string | undefined;
      for (let page = 0; page < maxMemberPages; page += 1) {
        const result = await withTimeout(
          listChatMembers(chatId, pageToken),
          requestTimeoutMs,
          'Feishu chat member list',
        );
        for (const member of result.members) {
          const name = cleanName(member.name);
          if (member.openId && name) members.set(member.openId, name);
        }
        pageToken = result.pageToken;
        if (!result.hasMore || !pageToken) break;
      }
    } catch (error) {
      // A partial list is still useful; only an empty one counts as failed.
      if (members.size === 0) {
        const ttl =
          failureTtl('chat_members', chatId, error) ?? missingScopeBackoffMs;
        return {
          members,
          fetchedAt: now(),
          expiresAt: now() + ttl,
          failed: true,
        };
      }
      options.onLookupError?.('chat_members', chatId, error);
    }
    return {
      members,
      fetchedAt: now(),
      expiresAt: now() + positiveTtlMs,
      failed: false,
    };
  }

  function memberList(
    chatId: string,
    openId: string,
    allowRefresh: boolean,
  ): Promise<MemberListEntry | undefined> {
    const cached = memberLists.get(chatId);
    if (cached && cached.expiresAt > now()) {
      const stale = now() - cached.fetchedAt >= memberListRefreshMs;
      // A failed fetch waits for its TTL; a sender who joined after the
      // last fetch triggers at most one refetch per refresh interval.
      if (
        cached.failed ||
        cached.members.has(openId) ||
        !stale ||
        !allowRefresh
      ) {
        return Promise.resolve(cached);
      }
    }
    if (isSuspended('chat_members')) return Promise.resolve(undefined);
    const pending = memberListsInFlight.get(chatId);
    if (pending) return pending;
    const request = fetchMemberList(chatId)
      .then((entry) => {
        touch(memberLists, chatId, entry, maxChats);
        return entry;
      })
      .finally(() => {
        memberListsInFlight.delete(chatId);
      });
    memberListsInFlight.set(chatId, request);
    return request;
  }

  async function contactName(openId: string): Promise<string | undefined> {
    if (isSuspended('contact')) return undefined;
    try {
      const name = cleanName(
        await withTimeout(
          options.lookup(openId),
          requestTimeoutMs,
          'Feishu contact lookup',
        ),
      );
      rememberName(openId, name, name ? positiveTtlMs : negativeTtlMs);
      return name;
    } catch (error) {
      const ttl = failureTtl('contact', openId, error);
      if (ttl !== undefined) rememberName(openId, undefined, ttl);
      return undefined;
    }
  }

  async function lookupName(
    openId: string,
    groupChatId: string | undefined,
  ): Promise<string | undefined> {
    // A remembered miss still checks the member list it already has (the
    // sender may be named in this group), but never refetches it or asks the
    // contact directory again before the miss expires.
    const knownMiss = freshName(openId) !== undefined;
    if (groupChatId && options.listChatMembers) {
      const list = await memberList(groupChatId, openId, !knownMiss);
      const name = list?.members.get(openId);
      if (name) {
        rememberName(openId, name, positiveTtlMs);
        return name;
      }
    }
    return knownMiss ? undefined : contactName(openId);
  }

  return {
    peek(openId) {
      return openId ? freshName(openId)?.name : undefined;
    },

    resolve(openId, groupChatId) {
      if (!openId) return Promise.resolve(undefined);
      const cached = freshName(openId);
      if (cached?.name) return Promise.resolve(cached.name);
      if (cached && !(groupChatId && options.listChatMembers)) {
        return Promise.resolve(undefined);
      }
      const key = `${openId}\n${groupChatId ?? ''}`;
      let request = inFlight.get(key);
      if (!request) {
        request = lookupName(openId, groupChatId)
          .catch(() => undefined)
          .finally(() => {
            inFlight.delete(key);
          });
        inFlight.set(key, request);
      }
      return waitAtMost(request, timeoutMs);
    },
  };
}
