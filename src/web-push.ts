/**
 * Web Push: system notifications for a finished reply or a failed run, for
 * the owner of a conversation whose browser or Home Screen app is in the
 * background or closed.
 *
 * Three concerns live here:
 *  - the VAPID identity, generated on first start and kept in a 0600 file;
 *  - the decision whether a turn outcome is pushed (see `notifyWebTurn`);
 *  - delivery to the owner's subscriptions, dropping those the push service
 *    reports gone.
 *
 * The worker that shows the notification is `web/public/push-sw.js`; the
 * payload built by `buildPushPayload` is its contract.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import webpush from 'web-push';

import { DATA_DIR } from './config.js';
import {
  deleteWebPushSubscriptionByEndpoint,
  listWebPushSubscriptions,
  markWebPushSuccess,
  type WebPushSubscription,
} from './web-push-store.js';
import { logger } from './logger.js';
import { wsClients, type WsClientInfo } from './web-context.js';

// ─── VAPID identity ────────────────────────────────────────────────────

const VAPID_FILE = path.join(DATA_DIR, 'config', 'web-push-vapid.json');
/** Contact claim of the VAPID token; the push services want a URL or mailto. */
const DEFAULT_VAPID_SUBJECT = 'https://github.com/riba2534/happyclaw';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let cachedKeys: VapidKeys | null | undefined;

function parseVapidKeys(raw: string): VapidKeys | null {
  try {
    const parsed = JSON.parse(raw) as Partial<VapidKeys>;
    if (
      typeof parsed.publicKey === 'string' &&
      typeof parsed.privateKey === 'string' &&
      parsed.publicKey &&
      parsed.privateKey
    ) {
      return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * The server's VAPID keys. The first call creates them; the file is written
 * exclusively (`wx`) so two starts cannot disagree on the key. An unreadable
 * file disables push instead of being replaced: a new key would silently
 * orphan every existing subscription.
 */
export function getVapidKeys(file = VAPID_FILE): VapidKeys | null {
  if (file === VAPID_FILE && cachedKeys !== undefined) return cachedKeys;
  let keys: VapidKeys | null = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (let attempt = 0; attempt < 2 && !keys; attempt++) {
      try {
        const generated = webpush.generateVAPIDKeys();
        fs.writeFileSync(
          file,
          JSON.stringify(
            { ...generated, created_at: new Date().toISOString() },
            null,
            2,
          ) + '\n',
          { encoding: 'utf-8', mode: 0o600, flag: 'wx' },
        );
        keys = generated;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        keys = parseVapidKeys(fs.readFileSync(file, 'utf-8'));
        if (!keys) {
          logger.error(
            'Web Push is disabled: the VAPID key file exists but is unreadable; fix or remove it',
          );
          break;
        }
      }
    }
    if (keys) {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // best effort
      }
    }
  } catch (err) {
    logger.error({ err }, 'Web Push is disabled: VAPID keys are unavailable');
    keys = null;
  }
  if (file === VAPID_FILE) cachedKeys = keys;
  return keys;
}

/** Forget the cached keys (tests only). */
export function resetVapidKeyCacheForTests(): void {
  cachedKeys = undefined;
}

export function getVapidPublicKey(): string | null {
  return getVapidKeys()?.publicKey ?? null;
}

// ─── Subscription endpoints ────────────────────────────────────────────

/**
 * Hosts of the push services browsers use. The server posts to whatever
 * endpoint a client registers, so anything else would let an account make it
 * send requests to an arbitrary address.
 */
const PUSH_SERVICE_HOST_SUFFIXES = [
  '.googleapis.com', // FCM: Chrome, Edge, Brave, Samsung Internet, Android
  '.push.services.mozilla.com', // Firefox
  '.push.apple.com', // Safari and Home Screen apps
  '.notify.windows.com', // Windows Notification Service
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** A short stable id for an endpoint, safe to show and log. */
export function endpointId(endpoint: string): string {
  return crypto
    .createHash('sha256')
    .update(endpoint)
    .digest('hex')
    .slice(0, 12);
}

// ─── Payload ───────────────────────────────────────────────────────────

export const PUSH_BODY_MAX_CHARS = 80;

export type WebPushKind = 'reply' | 'error' | 'test';

export interface WebPushPayload {
  title: string;
  body: string;
  /** Notifications with one tag replace each other: one per conversation. */
  tag: string;
  /** In-app route (relative to the app base) the click opens. */
  path: string;
  kind: WebPushKind;
}

/**
 * Plain text from a Markdown reply: no code fences, link targets, emphasis
 * marks, headings, list or quote markers, tables or tags; whitespace
 * collapsed and cut to `max` characters (not UTF-16 units).
 */
export function plainTextPreview(
  markdown: string,
  max = PUSH_BODY_MAX_CHARS,
): string {
  const text = markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/```/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>+\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, '')
    .replace(/\|/g, ' ')
    .replace(/(\*\*|__|~~)/g, '')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') + '…' : text;
}

/** Title of a conversation's notification: 「workspace · session」. */
export function conversationTitle(
  workspaceName: string | null | undefined,
  sessionName: string | null | undefined,
): string {
  const workspace = workspaceName?.trim() || '';
  const session = sessionName?.trim() || '';
  if (workspace && session && workspace !== session) {
    return `${workspace} · ${session}`;
  }
  return session || workspace || 'HappyClaw';
}

export interface ConversationRef {
  /** The workspace's JID, `web:…`. */
  chatJid: string;
  /** The workspace's folder: the Web route addresses workspaces by it. */
  folder: string;
  agentId: string;
}

export function conversationTag(
  ref: Pick<ConversationRef, 'chatJid' | 'agentId'>,
): string {
  return `conv:${ref.chatJid}#${ref.agentId}`;
}

/** The in-app route of a conversation, relative to the app base. */
export function conversationPath(
  ref: Pick<ConversationRef, 'folder' | 'agentId'>,
): string {
  return `/chat/${encodeURIComponent(ref.folder)}?agent=${encodeURIComponent(ref.agentId)}`;
}

export function buildPushPayload(input: {
  kind: Exclude<WebPushKind, 'test'>;
  workspaceName?: string | null;
  sessionName?: string | null;
  text: string;
  conversation: ConversationRef;
}): WebPushPayload {
  const preview = plainTextPreview(input.text);
  const fallback = input.kind === 'error' ? '运行出错' : '收到新回复';
  return {
    title: conversationTitle(input.workspaceName, input.sessionName),
    body:
      input.kind === 'error'
        ? `⚠️ ${preview || fallback}`
        : preview || fallback,
    tag: conversationTag(input.conversation),
    path: conversationPath(input.conversation),
    kind: input.kind,
  };
}

// ─── Who is looking ────────────────────────────────────────────────────

/** A page's presence report goes stale this long after its last refresh. */
export const PRESENCE_TTL_MS = 60_000;

export interface ClientPresence {
  visible: boolean;
  /** The workspace the page has open, or null off the chat page. */
  chatJid: string | null;
  /** The session the page has open in it. */
  agentId: string | null;
  at: number;
}

/**
 * Whether one of the user's visible pages has this conversation open. A page
 * reports its presence on every change and every ~25 seconds while visible,
 * so a report older than PRESENCE_TTL_MS (a frozen background tab, a phone
 * that dropped the socket) counts as not looking.
 */
export function isConversationBeingViewed(
  clients: Iterable<Pick<WsClientInfo, 'userId' | 'presence'>>,
  userId: string,
  conversation: Pick<ConversationRef, 'chatJid' | 'agentId'>,
  now = Date.now(),
): boolean {
  for (const client of clients) {
    const presence = client.presence;
    if (client.userId !== userId || !presence?.visible) continue;
    if (now - presence.at > PRESENCE_TTL_MS) continue;
    if (
      presence.chatJid === conversation.chatJid &&
      presence.agentId === conversation.agentId
    ) {
      return true;
    }
  }
  return false;
}

// ─── Which turns are pushed ────────────────────────────────────────────

export interface TurnOriginFacts {
  /** The IM chat the input arrived from; IM apps notify on their own. */
  imSourceJid: string | null;
  /** The input is an automation run's prompt. */
  automationRunId: string | null;
  /** The session is a team-mode lane (router or worker). */
  teamLane: boolean;
  /** The session's kind and how it was created. */
  sessionKind: string;
  sessionSourceKind: string | null | undefined;
}

/**
 * Only a conversation the person typed in on the Web is pushed. An input from
 * an IM chat is announced by that IM, an automation run is not a request the
 * person is waiting on, and team lanes speak through the team tools.
 */
export function isWebOriginTurn(facts: TurnOriginFacts): boolean {
  return (
    facts.imSourceJid === null &&
    facts.automationRunId === null &&
    !facts.teamLane &&
    facts.sessionKind === 'conversation' &&
    facts.sessionSourceKind !== 'automation' &&
    facts.sessionSourceKind !== 'team_router' &&
    facts.sessionSourceKind !== 'work_item'
  );
}

// ─── Delivery ──────────────────────────────────────────────────────────

const PUSH_TTL_SECONDS = 4 * 60 * 60;
const PUSH_REQUEST_TIMEOUT_MS = 10_000;

export type PushSendResult =
  | { ok: true }
  | { ok: false; gone: boolean; statusCode?: number; error: string };

export type PushSender = (
  subscription: WebPushSubscription,
  payload: WebPushPayload,
) => Promise<PushSendResult>;

function pushProxy(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    undefined
  );
}

/** Send one payload with the server's VAPID identity. */
export const sendWebPush: PushSender = async (subscription, payload) => {
  const keys = getVapidKeys();
  if (!keys) return { ok: false, gone: false, error: 'vapid_unavailable' };
  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
      {
        TTL: PUSH_TTL_SECONDS,
        urgency: 'normal',
        // A later push for the same conversation replaces one the push
        // service still holds for an offline device.
        topic: crypto
          .createHash('sha256')
          .update(payload.tag)
          .digest('base64url')
          .slice(0, 32),
        timeout: PUSH_REQUEST_TIMEOUT_MS,
        proxy: pushProxy(),
        vapidDetails: {
          subject: process.env.WEB_PUSH_SUBJECT || DEFAULT_VAPID_SUBJECT,
          publicKey: keys.publicKey,
          privateKey: keys.privateKey,
        },
      },
    );
    return { ok: true };
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    return {
      ok: false,
      // The push service no longer knows the subscription.
      gone: statusCode === 404 || statusCode === 410,
      statusCode,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

export interface PushDeliveryDeps {
  send: PushSender;
  listSubscriptions: (userId: string) => WebPushSubscription[];
  deleteSubscription: (endpoint: string) => void;
  markSuccess: (endpoint: string) => void;
}

const defaultDeliveryDeps: PushDeliveryDeps = {
  send: sendWebPush,
  listSubscriptions: listWebPushSubscriptions,
  deleteSubscription: (endpoint) =>
    void deleteWebPushSubscriptionByEndpoint(endpoint),
  markSuccess: markWebPushSuccess,
};

export interface PushDeliverySummary {
  attempted: number;
  delivered: number;
  removed: number;
}

/** Deliver to every subscription of the user; a 404 / 410 deletes the row. */
export async function deliverToUser(
  userId: string,
  payload: WebPushPayload,
  deps: PushDeliveryDeps = defaultDeliveryDeps,
): Promise<PushDeliverySummary> {
  const subscriptions = deps.listSubscriptions(userId);
  const summary: PushDeliverySummary = {
    attempted: subscriptions.length,
    delivered: 0,
    removed: 0,
  };
  await Promise.all(
    subscriptions.map(async (subscription) => {
      const result = await deps.send(subscription, payload);
      if (result.ok) {
        summary.delivered += 1;
        deps.markSuccess(subscription.endpoint);
        return;
      }
      if (result.gone) {
        summary.removed += 1;
        deps.deleteSubscription(subscription.endpoint);
        return;
      }
      logger.warn(
        {
          userId,
          endpoint: endpointId(subscription.endpoint),
          statusCode: result.statusCode,
          error: result.error,
        },
        'Web push delivery failed',
      );
    }),
  );
  return summary;
}

export interface WebTurnNotice {
  /** Owner of the workspace: the person the push goes to. */
  ownerUserId: string | null | undefined;
  kind: Exclude<WebPushKind, 'test'>;
  workspaceName?: string | null;
  sessionName?: string | null;
  text: string;
  conversation: ConversationRef;
}

export interface WebTurnNotifyDeps extends PushDeliveryDeps {
  clients: () => Iterable<Pick<WsClientInfo, 'userId' | 'presence'>>;
  now: () => number;
}

const defaultNotifyDeps: WebTurnNotifyDeps = {
  ...defaultDeliveryDeps,
  clients: () => wsClients.values(),
  now: () => Date.now(),
};

/**
 * Push a Web turn's outcome to the conversation's owner, unless they have no
 * subscription or are looking at that conversation right now. The caller has
 * already established the turn is Web-origin (`isWebOriginTurn`). Never
 * throws: a notification must not disturb the turn.
 */
export async function notifyWebTurn(
  notice: WebTurnNotice,
  deps: WebTurnNotifyDeps = defaultNotifyDeps,
): Promise<PushDeliverySummary | null> {
  try {
    const userId = notice.ownerUserId;
    if (!userId) return null;
    if (
      isConversationBeingViewed(
        deps.clients(),
        userId,
        notice.conversation,
        deps.now(),
      )
    ) {
      return null;
    }
    if (deps.listSubscriptions(userId).length === 0) return null;
    return await deliverToUser(userId, buildPushPayload(notice), deps);
  } catch (err) {
    logger.warn({ err }, 'Web push notification failed');
    return null;
  }
}
