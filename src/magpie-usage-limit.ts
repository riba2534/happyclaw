/**
 * When a magpie connection's turn ends on magpie's usage limit, find out
 * when the model can run again, so the input waits for it (usage-limit-wait)
 * instead of failing.
 *
 * magpie answers a spent model with 429 and `usage limit reached: every
 * account that serves "<model>" …`, and names the renewal in its
 * Retry-After and X-Magpie-Resets-At headers. Claude Code reports none of
 * the headers (no rate_limit_event; only `API Error: Request rejected (429)
 * · <message>`), so the host asks magpie itself: `/v1/magpie/quotas` lists
 * each account's windows, and the model's provider (`<provider>/<model>`)
 * is waited for until its earliest spent window renews. Anything that does
 * not say so outright (a routing group, `auto/`, an unreadable answer, no
 * spent window) leaves the failure as it was.
 */
import type { ContainerOutput } from './agent-runtime-contracts.js';
import { logger } from './logger.js';
import { storedConnectionAccess } from './model-catalog-sync.js';
import {
  isMagpieUsageLimitMessage,
  magpieUsageLimitResetAt,
} from './model-providers.js';
import {
  fetchMagpieQuotas,
  type MagpieQuotasResult,
} from './provider-connectivity.js';
import { getProviderById } from './runtime-config.js';
import { normalizeUsageLimitResetAt } from './usage-limit-wait.js';

/** The model magpie's refusal names (`serves "<model>"`), if it does. */
export function magpieRefusedModel(text: string | undefined): string | null {
  const match = /\bserves\s+"([^"\s]{1,200})"/i.exec(text ?? '');
  return match ? match[1] : null;
}

/**
 * How long a failed turn waits for magpie's quotas before it is settled
 * without them. The read runs before the failure is decided (and the input
 * parked or ended), so it is kept short: magpie answers on the same machine
 * or network in well under a second, and a slow answer only costs the wait,
 * never the input.
 */
export const MAGPIE_LIMIT_QUOTAS_TIMEOUT_MS = 3_000;

/**
 * Give a provider failure the reset time magpie's quotas name, when the
 * failure is magpie's usage limit on a magpie connection and nothing else
 * named a reset. `model` is the model the launch ran; the refusal's own
 * model name wins (a sub-agent may run another).
 */
export async function attachMagpieUsageLimitReset(
  output: ContainerOutput,
  providerId: string | null,
  model: string | null | undefined,
  readQuotas: typeof fetchMagpieQuotas = fetchMagpieQuotas,
): Promise<void> {
  if (!output.providerFailure || !providerId) return;
  if (
    output.providerFailureClass === 'transient' ||
    output.providerFailureClass === 'config'
  ) {
    return;
  }
  if (normalizeUsageLimitResetAt(output.providerRateLimitResetsAt) !== null) {
    return;
  }
  const text = output.providerErrorText ?? output.providerFailureNotice;
  if (!isMagpieUsageLimitMessage(text)) return;
  const provider = getProviderById(providerId);
  if (provider?.gateway !== 'magpie') return;
  const access = storedConnectionAccess(provider);
  const refused = magpieRefusedModel(text) ?? model ?? '';
  if (!access || !refused) return;
  let quotas: MagpieQuotasResult;
  try {
    quotas = await readQuotas(access, {
      timeoutMs: MAGPIE_LIMIT_QUOTAS_TIMEOUT_MS,
    });
  } catch (err) {
    logger.warn({ err, providerId }, 'magpie quotas read threw');
    return;
  }
  if (!quotas.ok) {
    logger.warn(
      { providerId, code: quotas.code, status: quotas.status },
      'magpie usage limit: quotas unreadable; the failure stands',
    );
    return;
  }
  const resetAt = magpieUsageLimitResetAt(quotas.accounts, refused);
  if (resetAt === null) {
    logger.warn(
      { providerId, model: refused },
      'magpie usage limit: no spent window names a renewal; the failure stands',
    );
    return;
  }
  output.providerRateLimitResetsAt = resetAt;
  logger.info(
    { providerId, model: refused, resetsAt: new Date(resetAt).toISOString() },
    'magpie usage limit: waiting for the renewal its quotas name',
  );
}
