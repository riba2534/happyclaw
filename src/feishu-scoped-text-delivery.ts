import {
  FEISHU_POST_MAX_BYTES,
  prepareFeishuPostTextPages,
} from './feishu-message-capacity.js';

export interface FeishuScopedPage {
  text: string;
  slot: string;
  index: number;
}

export interface FeishuScopedTextResult {
  delivered: boolean;
  deliveredOutputs: number;
  totalOutputs: number;
  error?: unknown;
}

/** The durable outbox classified this exact physical send as rejected.
 * A timeout mentioning the same provider code is still unsafe to repartition. */
function replacementBudget(
  error: unknown,
  currentBudget: number,
): number | null {
  const failure = error as { status?: unknown; message?: unknown } | undefined;
  if (typeof failure?.message !== 'string') return null;
  if (failure.status === 'failed' && /\b230025\b/.test(failure.message)) {
    return currentBudget > 1024
      ? Math.max(1024, Math.floor(currentBudget * 0.8))
      : null;
  }
  if (failure.status === 'cancelled') {
    try {
      const marker = JSON.parse(failure.message);
      if (
        marker.kind === 'feishu_capacity_replaced' &&
        marker.code === 230025 &&
        typeof marker.payloadHash === 'string' &&
        Number.isInteger(marker.replacementBudget) &&
        marker.replacementBudget >= 256
      ) {
        return marker.replacementBudget;
      }
    } catch {
      /* An ordinary cancellation cannot authorize another send. */
    }
  }
  return null;
}

/** One deterministic outbox slot per physical post. Failed size parents stay
 * in the ledger: recovery observes their rejection and follows the same child
 * slots, reusing every previously acknowledged page without sending it again. */
export async function deliverFeishuScopedText(
  text: string,
  options: {
    slot?: 'text' | 'caption';
    maxBytes?: number;
    onCapacityResolved?: (failure: unknown, budget: number) => Promise<void>;
    send: (
      page: FeishuScopedPage,
    ) => Promise<{ delivered: boolean; error?: unknown }>;
  },
): Promise<FeishuScopedTextResult> {
  const budget = options.maxBytes ?? FEISHU_POST_MAX_BYTES;
  const pages = prepareFeishuPostTextPages(text, { maxBytes: budget });
  const root = options.slot ?? 'text';
  const result: FeishuScopedTextResult = {
    delivered: true,
    deliveredOutputs: 0,
    totalOutputs: pages.length,
  };
  const sendPage = async (
    page: string,
    slot: string,
    maxBytes: number,
    depth: number,
  ): Promise<boolean> => {
    const sent = await options.send({
      text: page,
      slot,
      index: result.deliveredOutputs,
    });
    if (sent.delivered) {
      result.deliveredOutputs++;
      return true;
    }
    const smallerBudget = replacementBudget(sent.error, maxBytes);
    if (smallerBudget !== null && depth < 10) {
      const children = prepareFeishuPostTextPages(page, {
        maxBytes: smallerBudget,
      });
      result.totalOutputs += children.length - 1;
      for (let index = 0; index < children.length; index++) {
        if (
          !(await sendPage(
            children[index],
            `${slot}:capacity:${smallerBudget}:${index}`,
            smallerBudget,
            depth + 1,
          ))
        )
          return false;
      }
      await options.onCapacityResolved?.(sent.error, smallerBudget);
      return true;
    }
    result.error = sent.error;
    return false;
  };
  for (let index = 0; index < pages.length; index++) {
    // Retain the historical single-text slot for already delivered short
    // replies. Captions and genuinely multipart replies use explicit indexes.
    const slot =
      root === 'text' && pages.length === 1 ? root : `${root}:${index}`;
    if (!(await sendPage(pages[index], slot, budget, 0))) {
      result.delivered = false;
      break;
    }
  }
  return result;
}
