/**
 * Lossless sections for independently rendered Markdown components.
 * 4K is a layout target, not a provider limit. Keep larger paragraphs, tables
 * and fenced blocks intact; the delivery layer owns continuation card sizes.
 */
export const SECTION_SOFT_LIMIT = 2000;
export const SECTION_HARD_LIMIT = 4000;

export interface BodySection {
  text: string;
  expanded: boolean;
}

export function splitIntoBodySections(text: string): BodySection[] {
  if (!text.trim()) return [];
  if (text.length <= SECTION_SOFT_LIMIT) return [{ text, expanded: true }];

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

  const sections: BodySection[] = [];
  let current = '';
  for (const next of blocks) {
    if (current && current.length + next.length > SECTION_HARD_LIMIT) {
      sections.push({ text: current, expanded: sections.length === 0 });
      current = '';
    }
    current += next;
  }
  if (current)
    sections.push({ text: current, expanded: sections.length === 0 });
  return sections;
}
