import { jidNormalizedUser } from 'baileys';

import {
  channelConversationJid,
  parseChannelAddress,
} from './channel-address.js';
import { channelTurnScope } from './channel-turn-registry.js';

export interface AgentBuilderTurnContext {
  chatJid: string;
  messageId: string;
  /** Host-issued identity used by the runner for this cold/warm input turn. */
  runtimeTurnId: string;
  /** automation_runs.id when the input is an automation run's prompt. */
  automationRunId: string | null;
}

/**
 * Keep owner-turn authorization isolated per session, so concurrent chats of
 * one workspace cannot borrow each other's confirmations.
 */
export function agentBuilderTurnScope(
  folder: string,
  runtimeAgentId: string,
): string {
  return channelTurnScope(folder, runtimeAgentId);
}

export function getAgentBuilderRuntimeRejection(input: {
  runtimeAgentKind?: 'task' | 'conversation' | 'spawn' | null;
  runtimeAgentFolder?: string | null;
  sourceFolder: string;
  sourceProfileIsDefault: boolean;
}): string | null {
  if (
    input.runtimeAgentKind !== 'conversation' ||
    input.runtimeAgentFolder !== input.sourceFolder
  ) {
    return 'Agent Builder is only available to ordinary main-Agent conversations';
  }
  if (!input.sourceProfileIsDefault) {
    return 'Only the main HappyClaw may use Agent Builder';
  }
  return null;
}

function isCanonicalImOwnerSender(
  sourceJid: string,
  ownerImId: string,
  sender: string,
): boolean {
  const address = parseChannelAddress(sourceJid);
  if (!address || !ownerImId || !sender) return false;

  const senderOwnerImId = ownerImIdFromPersistedSender(sourceJid, sender);
  if (!senderOwnerImId) return false;

  if (address.provider === 'whatsapp') {
    const canonicalOwner = jidNormalizedUser(ownerImId);
    return canonicalOwner === senderOwnerImId;
  }
  return ownerImId === senderOwnerImId;
}

/** Decide whether a durable message from an already-admitted direct chat may
 * establish or upgrade its owner provenance. Existing strong provenance needs
 * no write, while historical, explicit/automatic claims and credential-transfer
 * quarantine never gain Builder trust from an ordinary message. Only a new,
 * ownerless admitted direct chat may establish trusted provenance this way. */
export function resolveTrustedDirectOwnerUpgrade(
  sourceJid: string,
  sender: string,
  currentOwnerImId?: string,
  currentSource?: string,
): string | null {
  // A pre-provenance owner may have crossed a credential transfer under an
  // older HappyClaw version. Never convert such a historical anchor into
  // Builder trust merely because the same external sender speaks again.
  if (currentOwnerImId) return null;
  if (
    currentSource === 'configured' ||
    currentSource === 'trusted_direct' ||
    currentSource === 'explicit' ||
    currentSource === 'auto_feishu' ||
    currentSource === 'transfer_reset'
  ) {
    return null;
  }
  const ownerImId = ownerImIdFromPersistedSender(sourceJid, sender);
  if (!ownerImId) return null;
  return ownerImId;
}

/** A successful pairing code authenticates the direct conversation itself.
 * Recover the provider-native owner id from that structurally direct JID so
 * pairing can deliberately replace a credential-transfer quarantine. */
export function ownerImIdFromDirectConversationJid(
  conversationJid: string,
): string | null {
  const address = parseChannelAddress(conversationJid);
  if (!address) return null;
  const id = address.externalChatId;
  switch (address.provider) {
    case 'telegram': {
      const value = Number(id);
      return Number.isFinite(value) && value > 0 ? id : null;
    }
    case 'discord':
      return /^dm:[1-9]\d*$/.test(id) ? id.slice('dm:'.length) : null;
    case 'dingtalk':
      return id.startsWith('c2c:') && id.length > 'c2c:'.length
        ? id.slice('c2c:'.length)
        : null;
    case 'wechat':
      return id || null;
    case 'wecom':
      return id.startsWith('c2c:') && id.length > 'c2c:'.length
        ? id.slice('c2c:'.length)
        : null;
    case 'qq':
      return id.startsWith('c2c:') && id.length > 'c2c:'.length ? id : null;
    case 'whatsapp': {
      const canonical = jidNormalizedUser(id);
      return /^[^@]+@(s\.whatsapp\.net|lid)$/.test(canonical)
        ? canonical
        : null;
    }
    default:
      return null;
  }
}

/** Convert the provider-specific persisted message sender back to the exact
 * representation used by registered_groups.owner_im_id. Unknown or malformed
 * formats fail closed; callers must never use suffix matching. */
export function ownerImIdFromPersistedSender(
  sourceJid: string,
  sender: string,
): string | null {
  const address = parseChannelAddress(sourceJid);
  if (!address || !sender) return null;

  switch (address.provider) {
    case 'feishu':
      return sender;
    case 'telegram': {
      const match = sender.match(/^tg:([1-9]\d*)$/);
      return match?.[1] ?? null;
    }
    case 'discord': {
      const match = sender.match(/^discord:([1-9]\d*)$/);
      return match?.[1] ?? null;
    }
    case 'dingtalk': {
      const subject = sender.startsWith('dingtalk:')
        ? sender.slice('dingtalk:'.length)
        : '';
      return subject || null;
    }
    case 'wechat': {
      const subject = sender.startsWith('wechat:')
        ? sender.slice('wechat:'.length)
        : '';
      return subject || null;
    }
    case 'wecom': {
      const subject = sender.startsWith('wecom:')
        ? sender.slice('wecom:'.length)
        : '';
      return subject || null;
    }
    case 'qq': {
      const namespace = address.externalChatId.startsWith('c2c:')
        ? 'c2c'
        : address.externalChatId.startsWith('group:')
          ? 'group'
          : null;
      const subject = sender.startsWith('qq:')
        ? sender.slice('qq:'.length)
        : '';
      return namespace && subject ? `${namespace}:${subject}` : null;
    }
    case 'whatsapp': {
      if (!sender.startsWith('whatsapp:')) return null;
      const canonicalSender = jidNormalizedUser(
        sender.slice('whatsapp:'.length),
      );
      return /^[^@]+@(s\.whatsapp\.net|lid)$/.test(canonicalSender)
        ? canonicalSender
        : null;
    }
    default:
      return null;
  }
}

export interface AgentBuilderPersistedInput {
  content: string;
  sender: string | null;
  source_jid: string | null;
  is_from_me: number;
  source_kind: string | null;
  automation_run_id: string | null;
}

/**
 * An automation run's input: unattended, never the owner speaking, whatever
 * sender it carries. Decided from host-persisted fields only.
 */
export function isAutomationTurnInput(
  turn: Pick<AgentBuilderTurnContext, 'automationRunId'>,
  input: Pick<AgentBuilderPersistedInput, 'source_kind' | 'automation_run_id'>,
): boolean {
  return (
    !!turn.automationRunId ||
    !!input.automation_run_id ||
    input.source_kind === 'automation_prompt'
  );
}

/**
 * An input no person typed in this turn: an automation run's, or one the host
 * composed for a team-mode session (assignment, follow-up copy, report). It
 * never counts as the owner speaking, so Skill changes are refused and
 * Workspace Memory writes become proposals.
 */
export function isUnattendedTurnInput(
  turn: Pick<AgentBuilderTurnContext, 'automationRunId'>,
  input: Pick<AgentBuilderPersistedInput, 'source_kind' | 'automation_run_id'>,
): boolean {
  return (
    isAutomationTurnInput(turn, input) ||
    input.source_kind === 'work_item_input'
  );
}

export function isAgentBuilderOwnerInput(
  input: Pick<AgentBuilderPersistedInput, 'sender' | 'source_jid'>,
  ownerUserId: string,
  getSourceGroup: (jid: string) =>
    | {
        created_by?: string;
        owner_im_id?: string;
        owner_claim_source?: string;
      }
    | undefined,
): boolean {
  const sourceJid = input.source_jid;
  if (!sourceJid || sourceJid.startsWith('web:')) {
    return input.sender === ownerUserId;
  }
  const source = getSourceGroup(channelConversationJid(sourceJid));
  return (
    source?.created_by === ownerUserId &&
    !!source.owner_im_id &&
    !!input.sender &&
    (source.owner_claim_source === 'configured' ||
      source.owner_claim_source === 'trusted_direct') &&
    isCanonicalImOwnerSender(sourceJid, source.owner_im_id, input.sender)
  );
}

/**
 * Owner Profile trusts these claim sources as identity anchors. Unlike Agent
 * Builder mutations, `auto_feishu` qualifies: it is recorded by the host from
 * the Feishu API when the owner deliberately binds a group into their Home
 * workspace, not from any message content. `explicit` stays excluded because
 * any member may first-claim an unowned group via /owner_mention.
 */
export const OWNER_PROFILE_TRUSTED_CLAIM_SOURCES: readonly string[] = [
  'configured',
  'trusted_direct',
  'auto_feishu',
];

/**
 * Owner Profile sender verification. The owner's IM identity is anchored at
 * the Home-workspace level: any Home registration of the same provider with a
 * host-verified claim source vouches for the sender, so Home chats registered
 * before owner capture (e.g. legacy topic groups with a NULL owner_im_id)
 * still authorize the same human. The source conversation itself must remain
 * a registration of the same owner; unknown chats fail closed.
 */
export function isOwnerProfileOwnerInput(
  input: Pick<AgentBuilderPersistedInput, 'sender' | 'source_jid'>,
  ownerUserId: string,
  getSourceGroup: (jid: string) => { created_by?: string } | undefined,
  resolveHomeOwnerImIds: (provider: string) => readonly string[],
): boolean {
  const sourceJid = input.source_jid;
  if (!sourceJid || sourceJid.startsWith('web:')) {
    return input.sender === ownerUserId;
  }
  if (!input.sender) return false;
  const address = parseChannelAddress(sourceJid);
  if (!address) return false;
  const source = getSourceGroup(channelConversationJid(sourceJid));
  if (source?.created_by !== ownerUserId) return false;
  const senderImId = ownerImIdFromPersistedSender(sourceJid, input.sender);
  if (!senderImId) return false;
  return resolveHomeOwnerImIds(address.provider).some((ownerImId) =>
    address.provider === 'whatsapp'
      ? jidNormalizedUser(ownerImId) === senderImId
      : ownerImId === senderImId,
  );
}

/**
 * Host-owned authorization state for the conversational Agent Builder.
 * Runner-supplied chat/turn/task claims are not authorization inputs because
 * Agents intentionally have full Bash and write access to their IPC mount.
 */
/** The (non-empty) batch whose every turn carries this runtimeTurnId. */
function batchNamedBy(
  runtimeTurnId: string,
): (batch: AgentBuilderTurnContext[]) => boolean {
  return (batch) => batch.every((turn) => turn.runtimeTurnId === runtimeTurnId);
}

export class AgentBuilderTurnRegistry {
  private readonly active = new Map<string, AgentBuilderTurnContext[]>();
  private readonly queued = new Map<string, AgentBuilderTurnContext[][]>();

  set(
    folder: string,
    chatJid: string,
    messageId: string,
    automationRunId?: string | null,
  ): void {
    this.startBatch(folder, [
      {
        chatJid,
        messageId,
        runtimeTurnId: messageId,
        automationRunId: automationRunId ?? null,
      },
    ]);
  }

  startBatch(folder: string, batch: AgentBuilderTurnContext[]): void {
    if (batch.length === 0) {
      this.delete(folder);
      return;
    }
    this.active.set(
      folder,
      batch.map((turn) => ({ ...turn })),
    );
    this.queued.delete(folder);
  }

  enqueueBatch(folder: string, batch: AgentBuilderTurnContext[]): void {
    if (batch.length === 0) return;
    if (!this.active.has(folder)) {
      this.active.set(
        folder,
        batch.map((turn) => ({ ...turn })),
      );
      return;
    }
    const queued = this.queued.get(folder) ?? [];
    queued.push(batch.map((turn) => ({ ...turn })));
    this.queued.set(folder, queued);
  }

  /** Returns the batch promoted to active by this call (a copy), else []. */
  clearCompleted(
    folder: string,
    completed: Array<{ chatJid: string; messageId: string }>,
  ): AgentBuilderTurnContext[] {
    const key = (item: { chatJid: string; messageId: string }) =>
      `${item.chatJid}\u0000${item.messageId}`;
    const completedKeys = new Set(completed.map(key));
    const active = this.active.get(folder) ?? [];
    const queued = this.queued.get(folder) ?? [];
    const recognized =
      active.some((turn) => completedKeys.has(key(turn))) ||
      queued.some((batch) =>
        batch.some((turn) => completedKeys.has(key(turn))),
      );
    if (!recognized) return [];

    this.active.delete(folder);
    const remaining = queued
      .map((batch) => batch.filter((turn) => !completedKeys.has(key(turn))))
      .filter((batch) => batch.length > 0);
    const next = remaining.shift();
    if (next) this.active.set(folder, next);
    if (remaining.length > 0) this.queued.set(folder, remaining);
    else this.queued.delete(folder);
    return (next ?? []).map((turn) => ({ ...turn }));
  }

  delete(folder: string): void {
    this.active.delete(folder);
    this.queued.delete(folder);
  }

  /**
   * Every turn handed to the runner up to and including the batch with this
   * runtimeTurnId (the active batch or one already piped behind it), or []
   * when no delivered batch carries it. A runner answers a piped batch
   * before the host promotes it, and that answer's context holds every
   * batch before it.
   */
  deliveredTurnsThrough(
    folder: string,
    runtimeTurnId: string | null | undefined,
  ): AgentBuilderTurnContext[] {
    if (!runtimeTurnId) return [];
    const batches = this.deliveredBatches(folder);
    const through = batches.findIndex(batchNamedBy(runtimeTurnId));
    if (through < 0) return [];
    return batches
      .slice(0, through + 1)
      .flat()
      .map((turn) => ({ ...turn }));
  }

  private deliveredBatches(folder: string): AgentBuilderTurnContext[][] {
    return [
      this.active.get(folder) ?? [],
      ...(this.queued.get(folder) ?? []),
    ].filter((batch) => batch.length > 0);
  }

  /** The batch executing right now in this runtime scope (a copy). */
  activeBatch(folder: string): AgentBuilderTurnContext[] {
    return (this.active.get(folder) ?? []).map((turn) => ({ ...turn }));
  }

  /**
   * Classify only the host-owned batch currently executing in this runtime.
   * Queued turns must not affect the authorization of the active turn.
   * Missing durable input fails closed because runner-supplied task flags are
   * intentionally not authorization inputs.
   */
  classifyActiveTurn(
    folder: string,
    runtimeTurnId: string | null | undefined,
    loadPersistedInput: (
      chatJid: string,
      messageId: string,
    ) => AgentBuilderPersistedInput | null,
  ): 'interactive' | 'automation' | 'unknown' {
    const active = this.active.get(folder);
    if (
      !active?.length ||
      !runtimeTurnId ||
      active.some((turn) => turn.runtimeTurnId !== runtimeTurnId)
    ) {
      return 'unknown';
    }
    const observed = active.map((turn) => ({
      turn,
      input: loadPersistedInput(turn.chatJid, turn.messageId),
    }));
    if (observed.some(({ input }) => !input)) return 'unknown';
    if (
      observed.some(({ turn, input }) => isUnattendedTurnInput(turn, input!))
    ) {
      return 'automation';
    }
    return 'interactive';
  }

  requireOwnerHumanTurn(
    folder: string,
    loadPersistedInput: (
      chatJid: string,
      messageId: string,
    ) => AgentBuilderPersistedInput | null,
    isOwnerInput: (input: AgentBuilderPersistedInput) => boolean,
  ): AgentBuilderTurnContext & { content: string } {
    const active = this.active.get(folder);
    if (!active?.length) {
      throw new Error(
        'Agent Builder requires an active owner conversation turn',
      );
    }
    const allObservedTurns = [
      ...active,
      ...(this.queued.get(folder) ?? []).flat(),
    ];
    const inputs = allObservedTurns.map((turn) => ({
      turn,
      input: loadPersistedInput(turn.chatJid, turn.messageId),
    }));
    for (const { turn, input } of inputs) {
      if (
        !input ||
        input.is_from_me !== 0 ||
        isUnattendedTurnInput(turn, input)
      ) {
        throw new Error(
          'Agent Builder is unavailable for automation or non-human turns',
        );
      }
      if (!isOwnerInput(input)) {
        throw new Error('Only the Agent owner may use Agent Builder');
      }
    }
    const current = inputs[active.length - 1];
    if (!current?.input) {
      throw new Error(
        'Agent Builder requires an active owner conversation turn',
      );
    }
    return { ...current.turn, content: current.input.content };
  }

  /**
   * Authorize only the host-owned batch executing right now. Unlike Agent
   * Builder confirmation, Owner Profile IPC must never let a future queued
   * owner turn lend authority to the current runner call.
   */
  requireExactActiveOwnerHumanTurn(
    folder: string,
    runtimeTurnId: string | null | undefined,
    loadPersistedInput: (
      chatJid: string,
      messageId: string,
    ) => AgentBuilderPersistedInput | null,
    isOwnerInput: (input: AgentBuilderPersistedInput) => boolean,
  ): AgentBuilderTurnContext & { content: string } {
    const active = this.active.get(folder);
    if (
      !active?.length ||
      !runtimeTurnId ||
      active.some((turn) => turn.runtimeTurnId !== runtimeTurnId)
    ) {
      throw new Error(
        'Owner Profile requires the exact active conversation turn',
      );
    }
    const observed = active.map((turn) => ({
      turn,
      input: loadPersistedInput(turn.chatJid, turn.messageId),
    }));
    for (const { turn, input } of observed) {
      if (
        !input ||
        input.is_from_me !== 0 ||
        isUnattendedTurnInput(turn, input)
      ) {
        throw new Error(
          'Owner Profile is unavailable for automation or non-human turns',
        );
      }
      if (!isOwnerInput(input)) {
        throw new Error(
          'Only the actual workspace owner may use Owner Profile',
        );
      }
    }
    const current = observed[observed.length - 1];
    if (!current?.input) {
      throw new Error(
        'Owner Profile requires the exact active conversation turn',
      );
    }
    return { ...current.turn, content: current.input.content };
  }

  /**
   * Read-only per-turn projection resolver. It may address an already
   * host-admitted queued batch, but only by that batch's exact runtimeTurnId;
   * its owner identity can never authorize a mutation for another turn.
   */
  requireExactOwnerHumanTurn(
    folder: string,
    runtimeTurnId: string | null | undefined,
    loadPersistedInput: (
      chatJid: string,
      messageId: string,
    ) => AgentBuilderPersistedInput | null,
    isOwnerInput: (input: AgentBuilderPersistedInput) => boolean,
  ): AgentBuilderTurnContext & { content: string } {
    if (!runtimeTurnId) {
      throw new Error('Owner Profile requires an admitted conversation turn');
    }
    const exact = this.deliveredBatches(folder).find(
      batchNamedBy(runtimeTurnId),
    );
    if (!exact) {
      throw new Error('Owner Profile requires an admitted conversation turn');
    }
    const observed = exact.map((turn) => ({
      turn,
      input: loadPersistedInput(turn.chatJid, turn.messageId),
    }));
    for (const { turn, input } of observed) {
      if (
        !input ||
        input.is_from_me !== 0 ||
        isUnattendedTurnInput(turn, input) ||
        !isOwnerInput(input)
      ) {
        throw new Error(
          'Owner Profile projection is unavailable for this turn',
        );
      }
    }
    const current = observed[observed.length - 1];
    return { ...current.turn, content: current.input!.content };
  }
}
