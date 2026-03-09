/**
 * Utility functions for filtering agent output before sending to IM channels.
 *
 * Agents may include internal-only markup in their output that should never
 * be exposed to end users. This module provides a single, tested entry-point
 * for stripping those tags.
 */

/**
 * Strip all tags that must not appear in IM messages:
 *
 * - `<internal>…</internal>` – agent-internal reasoning / scratchpad
 * - `<process>…</process>`   – in-progress tool / skill trace text
 *
 * The regexes use `[\s\S]*?` (non-greedy dot-all) so that multi-line
 * content inside the tags is consumed correctly.
 *
 * @param text Raw agent output string.
 * @returns The text with all filtered tags removed, trimmed of surrounding whitespace.
 */
export function stripImTags(text: string): string {
  return text
    .replace(/<internal>[\s\S]*?<\/internal>/g, '')
    .replace(/<process>[\s\S]*?<\/process>/g, '')
    .trim();
}
