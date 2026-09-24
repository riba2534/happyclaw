/**
 * Non-empty SDK Assistant text emitted after a Proactive final delivery.
 *
 * Claude Code treats a tool-only turn with no Assistant text as incomplete and
 * injects a synthetic "no visible output" companion, which starts another API
 * call. An HTML comment is non-empty to the CLI but invisible when a transient
 * Web stream happens to render it. The Host suppresses all Proactive SDK-final
 * text, so this is control-plane data only.
 */
export const PROACTIVE_FINAL_DELIVERED_SENTINEL =
  '<!--HAPPYCLAW_PROACTIVE_FINAL_DELIVERED-->';

export const CLI_NO_VISIBLE_OUTPUT_COMPANION =
  '[Your previous response had no visible output. Please continue and produce a user-visible response.]';

export function isProactiveFinalDeliveredSentinel(
  value: string | null | undefined,
): boolean {
  return value?.trim() === PROACTIVE_FINAL_DELIVERED_SENTINEL;
}

function userMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const envelope = message as Record<string, unknown>;
  const body = envelope.message;
  if (!body || typeof body !== 'object') return '';
  const content = (body as Record<string, unknown>).content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        !!block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).type === 'text' &&
        typeof (block as Record<string, unknown>).text === 'string',
    )
    .map((block) => block.text)
    .join('')
    .trim();
}

/**
 * Match only the CLI-owned synthetic companion. A user can legitimately type
 * the same sentence, so text alone is never sufficient to consume a turn.
 * `isMeta`/turnCompanion are accepted for forward/backward-compatible CLI
 * builds; Claude Code 2.1.280 (like 2.1.238) exposes `isSynthetic` only.
 */
export function isCliNoVisibleOutputCompanion(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const envelope = message as Record<string, unknown>;
  if (envelope.type !== 'user') return false;
  const origin = envelope.origin as Record<string, unknown> | undefined;
  const markedByCli =
    envelope.isSynthetic === true ||
    envelope.isMeta === true ||
    envelope.turnCompanion === true ||
    envelope.turn_companion === true ||
    origin?.kind === 'auto-continuation';
  return (
    markedByCli && userMessageText(envelope) === CLI_NO_VISIBLE_OUTPUT_COMPANION
  );
}

export function proactiveFinalWasDeliveredForInput(
  deliveredInputTurnId: string | null | undefined,
  currentInputTurnId: string | null | undefined,
): boolean {
  const delivered = deliveredInputTurnId?.trim();
  const current = currentInputTurnId?.trim();
  return !!delivered && !!current && delivered === current;
}
