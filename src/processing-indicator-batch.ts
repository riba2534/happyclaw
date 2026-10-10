import { getChannelType } from './im-channel.js';

export interface ProcessingIndicatorInput {
  id: string;
  sourceJid?: string | null;
}

export interface ProcessingIndicatorOwner {
  inputTurnId: string;
  transportJid: string;
}

/**
 * Host-minted input ids (scheduled group prompts, Web/UUID ids, plugin
 * replies) are not provider messages; a reaction on them is a guaranteed
 * provider error (Feishu 99992354 "Invalid ids").
 */
const SYNTHETIC_INPUT_ID_PREFIXES = ['scheduled-task-prompt:'];

/**
 * Whether `id` can be the target of a provider acknowledgement on
 * `transportJid`. Feishu reactions need a real `om_…` message id.
 */
export function isProviderAcknowledgeableInputId(
  transportJid: string,
  id: string,
): boolean {
  const trimmed = id.trim();
  if (!trimmed) return false;
  if (SYNTHETIC_INPUT_ID_PREFIXES.some((prefix) => trimmed.startsWith(prefix)))
    return false;
  if (getChannelType(transportJid) === 'feishu') {
    return /^om_[A-Za-z0-9_-]+$/.test(trimmed);
  }
  return true;
}

/**
 * Select provider acknowledgement owners for one executing batch.
 *
 * Feishu reactions are created only when a batch starts, so the latest Feishu
 * input is the batch's single visible owner. Other providers still attach at
 * ingress and therefore retain every exact input until they migrate to the
 * same lifecycle independently.
 */
export function selectBatchProcessingIndicatorOwners(
  inputs: ProcessingIndicatorInput[],
  fallbackTransportJid?: string | null,
): ProcessingIndicatorOwner[] {
  const resolved: ProcessingIndicatorOwner[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const explicit = input.sourceJid?.trim();
    const transportJid = explicit
      ? getChannelType(explicit)
        ? explicit
        : null
      : fallbackTransportJid && getChannelType(fallbackTransportJid)
        ? fallbackTransportJid
        : null;
    if (!transportJid) continue;
    if (!isProviderAcknowledgeableInputId(transportJid, input.id)) continue;
    const key = `${transportJid}\0${input.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ inputTurnId: input.id, transportJid });
  }

  let lastFeishuIndex = -1;
  for (let index = resolved.length - 1; index >= 0; index -= 1) {
    if (getChannelType(resolved[index].transportJid) === 'feishu') {
      lastFeishuIndex = index;
      break;
    }
  }
  return resolved.filter(
    (owner, index) =>
      getChannelType(owner.transportJid) !== 'feishu' ||
      index === lastFeishuIndex,
  );
}
