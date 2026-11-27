/**
 * Markdown chunking that never leaves a fenced code block open across a
 * message boundary: a chunk split inside a fence is closed with the same
 * fence marker and the next chunk reopens it with the same info string.
 * Shared by the channels whose renderers need each message to stand alone
 * (Discord, Telegram).
 */

/** A fenced code block that is open at some point of the text. */
interface OpenFence {
  indent: string;
  /** The opening run: three or more backticks or tildes. */
  marker: string;
  info: string;
}

// CommonMark: up to three spaces of indentation, then a run of at least
// three backticks or tildes.
const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * The fence still open after `text`, scanning from outside any fence. A
 * fence closes only with a run of its own character at least as long and
 * nothing else on the line, so ~~~ inside ``` (or a shorter run) is content.
 */
function openFenceAfter(text: string): OpenFence | null {
  let open: OpenFence | null = null;
  for (const line of text.split('\n')) {
    const match = FENCE_LINE.exec(line);
    if (!match) continue;
    const [, indent, marker, rest] = match;
    if (!open) {
      // A backtick fence's info string cannot contain a backtick.
      if (marker[0] === '`' && rest.includes('`')) continue;
      open = { indent, marker, info: rest.trim() };
    } else if (
      marker[0] === open.marker[0] &&
      marker.length >= open.marker.length &&
      rest.trim() === ''
    ) {
      open = null;
    }
  }
  return open;
}

const MAX_REOPENED_FENCE_INFO = 32;

function fenceOpener(fence: OpenFence): string {
  return `${fence.indent}${fence.marker}${fence.info.slice(0, MAX_REOPENED_FENCE_INFO)}\n`;
}

/**
 * Split text into chunks of at most `limit` characters, preserving code fences.
 *
 * Every chunk is self-contained: a chunk cut inside a fenced block ends with
 * that block's closing fence, and the next chunk starts by reopening it, so
 * each chunk's fence state is read from its own text alone.
 */
export function splitMarkdownWithCodeFences(
  text: string,
  limit: number,
): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  // Length of the reopened fence line `remaining` starts with, if any.
  let reopened = 0;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let reserve = 0;
    let chunk = '';
    let splitAt = 0;
    let open: OpenFence | null = null;
    // Room for the closing fence is only known once the cut is chosen; a
    // chunk that would overflow with it is cut again with that much room.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      splitAt = chooseSplit(remaining, limit - reserve, reopened);
      chunk = remaining.slice(0, splitAt);
      open = openFenceAfter(chunk);
      if (!open) break;
      const closer = `${chunk.endsWith('\n') ? '' : '\n'}${open.marker}`;
      if (chunk.length + closer.length <= limit || attempt === 3) {
        chunk += closer;
        break;
      }
      reserve = closer.length;
    }

    chunks.push(chunk);
    remaining = remaining.slice(splitAt);
    reopened = 0;
    if (open && remaining.length > 0) {
      const opener = fenceOpener(open);
      remaining = opener + remaining;
      reopened = opener.length;
    }
  }

  return chunks;
}

/**
 * Where to cut `text` so the chunk holds at most `budget` characters: after
 * the last newline in the final 200 characters, else at the budget. The cut
 * always lands past a reopened fence line, so every chunk makes progress.
 */
function chooseSplit(text: string, budget: number, reopened: number): number {
  const minimum = reopened + 1;
  const effective = Math.max(budget, minimum);
  const searchStart = Math.max(minimum, effective - 200);
  const lastNewline = text.slice(searchStart, effective).lastIndexOf('\n');
  return lastNewline === -1 ? effective : searchStart + lastNewline + 1;
}
