/**
 * Enough for any upstream's own sentence about a failure; the host only
 * matches a gateway's wording in it and never shows it to users.
 */
export const PROVIDER_ERROR_TEXT_MAX_CHARS = 1000;

/**
 * The upstream's words for a provider failure as the output carries them:
 * trimmed and capped, or undefined when there are none.
 */
export function providerErrorText(
  text: string | null | undefined,
): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > PROVIDER_ERROR_TEXT_MAX_CHARS
    ? trimmed.slice(0, PROVIDER_ERROR_TEXT_MAX_CHARS).trimEnd()
    : trimmed;
}

/**
 * The text blocks of an SDK assistant message. On an assistant error Claude
 * Code writes the upstream's answer there (for example `API Error: Request
 * rejected (429) · usage limit reached: …`).
 */
export function assistantMessageText(message: unknown): string | undefined {
  const content = (message as { message?: { content?: unknown } } | null)
    ?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap((block) =>
    block &&
    typeof block === 'object' &&
    (block as { type?: unknown }).type === 'text' &&
    typeof (block as { text?: unknown }).text === 'string'
      ? [(block as { text: string }).text]
      : [],
  );
  return texts.length > 0 ? texts.join('\n') : undefined;
}
