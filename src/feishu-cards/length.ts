import { countMarkdownTables, findMarkdownBlocks } from './pagination.js';

/**
 * Lossless sections for independently rendered Markdown components.
 * 4K is a layout target, not a provider limit. Keep larger paragraphs, tables
 * and fenced blocks intact; the delivery layer owns continuation card sizes.
 */
export const SECTION_SOFT_LIMIT = 2000;
export const SECTION_HARD_LIMIT = 4000;
/** Feishu renders at most four tables in one Markdown component. */
export const SECTION_MAX_TABLES = 4;

export interface BodySection {
  text: string;
  expanded: boolean;
}

export function splitIntoBodySections(text: string): BodySection[] {
  if (!text.trim()) return [];
  const tableCount = countMarkdownTables(text);
  if (text.length <= SECTION_SOFT_LIMIT && tableCount <= SECTION_MAX_TABLES)
    return [{ text, expanded: true }];

  const blocks: string[] = [];
  let block = '';
  let fence: string | undefined;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? [text]) {
    block += line;
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
    if (marker) {
      if (!fence) {
        if (marker[1][0] !== '`' || !marker[2].includes('`')) fence = marker[1];
      } else if (
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      ) {
        fence = undefined;
      }
    }
    if (!fence && !line.trim()) {
      blocks.push(block);
      block = '';
    }
  }
  if (block) blocks.push(block);

  const limitTables = tableCount > SECTION_MAX_TABLES;
  const bounded = limitTables ? blocks.flatMap(splitBlockByTables) : blocks;
  const sections: BodySection[] = [];
  let current = '';
  let currentTables = 0;
  for (const next of bounded) {
    const nextTables = limitTables ? countMarkdownTables(next) : 0;
    if (
      current &&
      (current.length + next.length > SECTION_HARD_LIMIT ||
        currentTables + nextTables > SECTION_MAX_TABLES)
    ) {
      sections.push({ text: current, expanded: sections.length === 0 });
      current = '';
      currentTables = 0;
    }
    current += next;
    currentTables += nextTables;
  }
  if (current)
    sections.push({ text: current, expanded: sections.length === 0 });
  return sections;
}

/** Cut a block (no blank lines) before every fifth table it contains. */
function splitBlockByTables(block: string): string[] {
  const starts = findMarkdownBlocks(block)
    .filter((entry) => entry.kind === 'table')
    .map((entry) => entry.start);
  if (starts.length <= SECTION_MAX_TABLES) return [block];
  const pieces: string[] = [];
  let cursor = 0;
  for (let i = SECTION_MAX_TABLES; i < starts.length; i += SECTION_MAX_TABLES) {
    pieces.push(block.slice(cursor, starts[i]));
    cursor = starts[i];
  }
  pieces.push(block.slice(cursor));
  return pieces;
}
