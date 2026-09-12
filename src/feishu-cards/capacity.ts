/**
 * Unsent CardKit probes accepted 100,000 Unicode code points per streaming
 * Markdown update, and approximately 300KB of serialized card JSON. Leave
 * room below those observed boundaries; provider-rendered Markdown may still
 * exceed its internal limit and require a smaller retry page.
 * A sent card also accepted 99,000 CJK code points (297KB), then closed and
 * updated successfully in the research group during production verification.
 */
export const CARDKIT_JSON_MAX_BYTES = 300_000;
export const CARDKIT_MARKDOWN_MAX_CHARS = 99_000;
export const CARDKIT_MAX_ELEMENTS = 200;
export const CARDKIT_MAX_TABLES = 5;

export function unicodeCodePointLength(text: string): number {
  if (!/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(text)) return text.length;
  let length = 0;
  for (const _point of text) length++;
  return length;
}

export interface CardCapacityOptions {
  maxBytes?: number;
  maxMarkdownChars?: number;
  maxElements?: number;
  maxTables?: number;
}

/** Count actual nested components, rather than only body.elements entries. */
export function fitsCardCapacity(
  card: object,
  options: CardCapacityOptions = {},
): boolean {
  if (
    Buffer.byteLength(JSON.stringify(card)) >
    (options.maxBytes ?? CARDKIT_JSON_MAX_BYTES)
  )
    return false;
  let elements = 0;
  let tables = 0;
  let markdownFits = true;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
    } else if (value && typeof value === 'object') {
      const node = value as Record<string, unknown>;
      if (typeof node.tag === 'string') elements++;
      if (node.tag === 'table') tables++;
      if (
        options.maxMarkdownChars !== undefined &&
        node.tag === 'markdown' &&
        typeof node.content === 'string' &&
        unicodeCodePointLength(node.content) > options.maxMarkdownChars
      )
        markdownFits = false;
      for (const child of Object.values(node)) visit(child);
    }
  };
  visit(card);
  return (
    markdownFits &&
    elements <= (options.maxElements ?? CARDKIT_MAX_ELEMENTS) &&
    tables <= (options.maxTables ?? CARDKIT_MAX_TABLES)
  );
}
