import { optimizeMarkdownStyle } from './feishu-markdown-style.js';

// Feishu documents a generous total post limit, but large single `md` elements
// have produced provider-side 2200 errors in real threads. Keep one physical
// message/Outbox row while using smaller rich-text nodes inside that message.
export const FEISHU_POST_MD_NODE_MAX_BYTES = 2_400;

function takeUtf8Prefix(
  value: string,
  maxBytes: number,
): { prefix: string; rest: string } {
  let bytes = 0;
  let consumedCodeUnits = 0;
  for (const character of value) {
    const nextBytes = Buffer.byteLength(character);
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    consumedCodeUnits += character.length;
  }
  return {
    prefix: value.slice(0, consumedCodeUnits),
    rest: value.slice(consumedCodeUnits),
  };
}

interface MarkdownFence {
  marker: string;
  opener: string;
}

function nextMarkdownFence(
  line: string,
  current: MarkdownFence | null,
): MarkdownFence | null {
  const trimmed = line.trim();
  if (!current) {
    const opener = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (!opener) return null;
    return {
      marker: opener[1],
      // Language identifiers are short in valid Markdown. Bounding an
      // adversarial opener keeps continuation overhead below the node budget.
      opener: Buffer.byteLength(trimmed) <= 128 ? trimmed : opener[1],
    };
  }
  const closingPattern = new RegExp(
    `^${current.marker[0]}{${current.marker.length},}\\s*$`,
  );
  return closingPattern.test(trimmed) ? null : current;
}

function stripLineEnding(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = stripLineEnding(line).trim();
  return trimmed.startsWith('|') && trimmed.includes('|', 1);
}

function isMarkdownTableSeparator(line: string): boolean {
  const trimmed = stripLineEnding(line).trim();
  return /^\|?[\t :|-]+\|[\t :|-]*\|?$/.test(trimmed) && /[-:]/.test(trimmed);
}

function collectMarkdownTable(
  lines: string[],
  start: number,
): string[] | undefined {
  const header = lines[start];
  const separator = lines[start + 1];
  if (!header || !separator) return undefined;
  if (!isMarkdownTableRow(header) || !isMarkdownTableSeparator(separator)) {
    return undefined;
  }
  const block = [header, separator];
  for (let index = start + 2; index < lines.length; index++) {
    const line = lines[index];
    if (!isMarkdownTableRow(line)) break;
    block.push(line);
  }
  return block;
}

function collectFenceBlock(
  lines: string[],
  start: number,
): string[] | undefined {
  const opener = nextMarkdownFence(lines[start] ?? '', null);
  if (!opener) return undefined;
  const block = [lines[start]];
  let fence: MarkdownFence | null = opener;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    block.push(line);
    fence = nextMarkdownFence(line, fence);
    if (!fence) break;
  }
  return block;
}

/**
 * Split optimized Markdown into several `md` elements without creating
 * additional provider messages. Each node is independently parsed by Feishu,
 * so tables and fenced blocks must stay syntactically complete inside a node:
 * whole lines are preferred, tables that fit stay together, oversized tables
 * replay header + separator on each continuation, and fenced blocks are
 * closed/reopened at node boundaries.
 */
export function splitFeishuPostMarkdown(
  markdown: string,
  maxBytes = FEISHU_POST_MD_NODE_MAX_BYTES,
): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 256) {
    throw new Error(
      'Feishu post Markdown node budget must be at least 256 bytes',
    );
  }
  if (!markdown) return [''];

  const chunks: string[] = [];
  let current = '';
  let fence: MarkdownFence | null = null;

  const closingReserve = (): number =>
    fence ? Buffer.byteLength(`\n${fence.marker}`) : 0;

  const availableBytes = (): number =>
    maxBytes - Buffer.byteLength(current) - closingReserve();

  const flush = (): void => {
    if (!current) return;
    const closing = fence ? `\n${fence.marker}` : '';
    chunks.push(`${current}${closing}`);
    current = fence ? `${fence.opener}\n` : '';
  };

  const appendFitting = (piece: string): boolean => {
    if (Buffer.byteLength(piece) <= availableBytes()) {
      current += piece;
      return true;
    }
    return false;
  };

  const appendPiece = (piece: string): void => {
    if (!piece) return;
    if (appendFitting(piece)) return;
    if (current) flush();
    if (appendFitting(piece)) return;
    let remaining = piece;
    while (remaining) {
      if (availableBytes() <= 0) {
        flush();
        continue;
      }
      if (appendFitting(remaining)) {
        remaining = '';
        continue;
      }
      const { prefix, rest } = takeUtf8Prefix(remaining, availableBytes());
      if (!prefix) {
        flush();
        continue;
      }
      current += prefix;
      remaining = rest;
      flush();
    }
  };

  const appendTable = (block: string[]): void => {
    const joined = block.join('');
    if (Buffer.byteLength(joined) <= maxBytes) {
      appendPiece(joined);
      return;
    }
    const header = `${block[0]}${block[1]}`;
    const rows = block.slice(2);
    if (rows.length === 0) {
      appendPiece(joined);
      return;
    }
    if (current) flush();
    let section = header;
    for (const row of rows) {
      const candidate = `${section}${row}`;
      if (Buffer.byteLength(candidate) <= maxBytes) {
        section = candidate;
        continue;
      }
      if (section !== header) appendPiece(section);
      else if (current) flush();
      section = `${header}${row}`;
      if (Buffer.byteLength(section) > maxBytes) {
        appendPiece(header);
        appendPiece(row);
        section = header;
      }
    }
    if (section !== header) appendPiece(section);
  };

  const appendFence = (block: string[]): void => {
    const joined = block.join('');
    const opener = nextMarkdownFence(block[0], null);
    if (
      opener &&
      Buffer.byteLength(`${opener.opener}\n\n${opener.marker}`) + 4 > maxBytes
    ) {
      // Reopening this fence would leave no room for one Unicode code point.
      // Emit raw source nodes instead of repeatedly flushing an oversized
      // opener forever. Preserve even unusually long markers verbatim.
      if (current) flush();
      let remaining = joined;
      while (remaining) {
        const { prefix, rest } = takeUtf8Prefix(remaining, maxBytes);
        chunks.push(prefix);
        remaining = rest;
      }
      return;
    }
    if (Buffer.byteLength(joined) <= maxBytes) {
      appendPiece(joined);
      return;
    }
    for (const line of block) {
      appendPiece(line);
      fence = nextMarkdownFence(line, fence);
    }
  };

  const lines = markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [markdown];
  for (let index = 0; index < lines.length; ) {
    if (!fence) {
      const table = collectMarkdownTable(lines, index);
      if (table) {
        appendTable(table);
        index += table.length;
        continue;
      }
      const fenced = collectFenceBlock(lines, index);
      if (fenced) {
        appendFence(fenced);
        index += fenced.length;
        continue;
      }
    }
    const line = lines[index];
    appendPiece(line);
    fence = nextMarkdownFence(line, fence);
    index += 1;
  }
  flush();
  return chunks.length > 0 ? chunks : [''];
}

/** Build a post+md fallback content string for when interactive card send fails. */
export function buildPostMdFallback(text: string): string {
  const optimized = optimizeMarkdownStyle(text, 1);
  return JSON.stringify({
    zh_cn: {
      content: splitFeishuPostMarkdown(optimized).map((chunk) => [
        { tag: 'md', text: chunk },
      ]),
    },
  });
}
