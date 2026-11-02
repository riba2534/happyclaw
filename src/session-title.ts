import { markdownToPlainText } from './im-utils.js';

/** Extract a short title from the first user message content. */
export function generateAutoTitle(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed || trimmed.startsWith('/')) return null;

  const text = markdownToPlainText(trimmed).replace(/\n+/g, ' ').trim();

  if (!text) return null;

  const firstLine = text.split('\n')[0].trim();
  if (!firstLine) return null;

  if (firstLine.length <= 20) return firstLine;
  return firstLine.slice(0, 20) + '…';
}
