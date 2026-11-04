import {
  DEFAULT_WORK_MODE,
  parseWorkMode,
  type WorkItemOrigin,
  type WorkItemView,
  type WorkMode,
} from '../work-items';

// Multi-task mode (多任务模式) on the Web: a workspace's work mode and the
// tasks a session delegated to a worker. Their stage words live with the
// team's in team-mode.ts.

export function normalizeWorkMode(value: unknown): WorkMode {
  return parseWorkMode(value) ?? DEFAULT_WORK_MODE;
}

export function isDelegated(item: { origin?: WorkItemOrigin | null }): boolean {
  return item.origin === 'delegated';
}

/** Inputs the host composed: a report, an automation's prompt. */
const SYNTHETIC_INPUTS: ReadonlySet<string> = new Set([
  'work_item_input',
  'automation_prompt',
]);

interface TranscriptMessage {
  sender: string;
  timestamp: string;
  is_from_me: boolean;
  source_kind?: string | null;
}

/** When a person last wrote in the session, in ms; 0 when never. */
export function lastPersonMessageAt(
  messages: readonly TranscriptMessage[],
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      message.is_from_me ||
      message.sender === '__system__' ||
      (message.source_kind && SYNTHETIC_INPUTS.has(message.source_kind))
    )
      continue;
    const at = Date.parse(message.timestamp);
    if (Number.isFinite(at)) return at;
  }
  return 0;
}

/**
 * The tasks a session's chat shows: those it delegated that are still open,
 * and those that ended since the person last wrote there (the next message
 * clears them; the 工作项 page keeps them all).
 */
export function sessionDelegations(
  items: Iterable<WorkItemView>,
  sessionId: string,
  personWroteAt: number,
): WorkItemView[] {
  const shown: WorkItemView[] = [];
  for (const item of items) {
    if (!isDelegated(item) || item.originAgentId !== sessionId) continue;
    if (item.status === 'ended') {
      const endedAt = Date.parse(item.endedAt ?? item.updatedAt);
      if (!(endedAt > personWroteAt)) continue;
    }
    shown.push(item);
  }
  return shown.sort((a, b) => a.seq - b.seq);
}
