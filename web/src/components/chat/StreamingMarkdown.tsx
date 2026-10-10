import { memo, useMemo, useRef } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import {
  canRenderBlockwise,
  endsInOpenFence,
  extendMarkdownBlocks,
  findMarkdownDefinitions,
  splitMarkdownBlocks,
} from '../../lib/markdown-blocks';

const MarkdownBlock = memo(function MarkdownBlock({
  content,
  open,
  groupJid,
  variant,
}: {
  content: string;
  open: boolean;
  groupJid?: string;
  variant: 'chat' | 'docs';
}) {
  return (
    <MarkdownRenderer
      content={content}
      groupJid={groupJid}
      variant={variant}
      streaming={open}
      // Margins between blocks must collapse as in one document.
      trimEdges={false}
    />
  );
});

/**
 * Only the reply's first element loses its top margin and its last element
 * its bottom margin, as `trimEdges` does for a whole document (a block may
 * sit inside a Suspense fallback wrapper while its renderer loads).
 */
const BLOCKS_CLASS =
  '[&>:first-child_[data-markdown-root]>*:first-child]:!mt-0 [&>[data-markdown-root]:first-child>*:first-child]:!mt-0 [&>:last-child_[data-markdown-root]>*:last-child]:!mb-0 [&>[data-markdown-root]:last-child>*:last-child]:!mb-0';

const FOOTNOTE_DEFINITION_LINE = /^( {0,3})\[\^/gm;
const HAS_FENCE = /^ {0,3}(?:`{3,}|~{3,})/m;
const TABLE_ROW_LINE = /^ {0,3}\|/;
const TABLE_DELIMITER_LINE = /^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * An open table re-parses in full on every update (85ms for 60 rows at 4x
 * CPU). Show its rows as they complete: while the last row is still being
 * written the block's text, and so its memoized render, stays the same.
 */
function stableOpenTable(block: string): string {
  if (block.endsWith('\n')) return block;
  const cut = block.lastIndexOf('\n');
  if (cut < 0) return block;
  const lines = block.slice(0, cut).split('\n');
  const partial = block.slice(cut + 1);
  if (!TABLE_ROW_LINE.test(partial)) return block;
  const delimiter = lines.findIndex((line) => TABLE_DELIMITER_LINE.test(line));
  // The header and delimiter must be complete for it to be a table yet.
  if (delimiter < 1 || !TABLE_ROW_LINE.test(lines[delimiter - 1])) return block;
  return block.slice(0, cut + 1);
}

/**
 * While streaming, each block is parsed on its own, so a reference link
 * (`[文档][ref]`) cannot see a definition in another block. Append the link
 * definitions found so far to each block (they render nothing), and show
 * footnote definitions as plain text until the final message renders the
 * whole document with its footnote section.
 */
function withStreamingDefinitions(
  blocks: string[],
  definitions: string[],
  footnotes: boolean,
): string[] {
  if (definitions.length === 0 && !footnotes) return blocks;
  const suffix = definitions.length > 0 ? `\n\n${definitions.join('\n')}` : '';
  return blocks.map((block) => {
    if (endsInOpenFence(block)) return block;
    // Code keeps its text verbatim.
    const shown =
      footnotes && !HAS_FENCE.test(block)
        ? block.replace(FOOTNOTE_DEFINITION_LINE, '$1\\[^')
        : block;
    return suffix && shown.includes('][') ? shown + suffix : shown;
  });
}

function MarkdownBlocks({
  content,
  groupJid,
  variant,
  streaming,
  caret = false,
}: {
  content: string;
  groupJid?: string;
  variant: 'chat' | 'docs';
  /** The last block is still open and re-parses as text arrives. */
  streaming: boolean;
  caret?: boolean;
}) {
  // Streamed text only grows: extend the previous split instead of
  // re-scanning a long reply on every render.
  const splitRef = useRef<{ text: string; blocks: string[] } | null>(null);
  const blocks = useMemo(() => {
    const split = streaming
      ? extendMarkdownBlocks(splitRef.current, content)
      : splitMarkdownBlocks(content);
    if (streaming) splitRef.current = { text: content, blocks: split.slice() };
    if (!streaming) return split;
    if (split.length > 0) {
      split[split.length - 1] = stableOpenTable(split[split.length - 1]);
    }
    const { links, footnotes } = findMarkdownDefinitions(content);
    return withStreamingDefinitions(split, links, footnotes);
  }, [content, streaming]);
  return (
    <div
      className={BLOCKS_CLASS}
      data-streaming-caret={caret ? 'true' : undefined}
    >
      {blocks.map((block, index) => (
        <MarkdownBlock
          // Blocks only ever append, so the index is a stable identity.
          key={index}
          content={block}
          open={streaming && index === blocks.length - 1}
          groupJid={groupJid}
          variant={variant}
        />
      ))}
    </div>
  );
}

/**
 * A streamed Markdown reply rendered in full. Finished blocks are memoized and
 * rendered as final Markdown (so their code, math and diagrams settle as soon
 * as they close); only the open last block re-parses as text arrives. This
 * keeps per-update cost bounded without hiding the start of long replies.
 */
export function StreamingMarkdown({
  content,
  groupJid,
  variant = 'chat',
  caret = false,
}: {
  content: string;
  groupJid?: string;
  variant?: 'chat' | 'docs';
  /** Show the trailing "still writing" indicator after the last text. */
  caret?: boolean;
}) {
  return (
    <MarkdownBlocks
      content={content}
      groupJid={groupJid}
      variant={variant}
      streaming
      caret={caret}
    />
  );
}

/**
 * A finished reply, laid out exactly like its stream was: block by block,
 * each block memoized and its rendered tree shared with the block the stream
 * already rendered, so finalizing a long reply no longer re-parses and
 * re-highlights the whole document in one long task. Text whose meaning
 * spans blocks (reference links, footnotes, raw HTML) renders as one
 * document.
 */
export const FinalMarkdown = memo(function FinalMarkdown({
  content,
  groupJid,
  variant = 'chat',
}: {
  content: string;
  groupJid?: string;
  variant?: 'chat' | 'docs';
}) {
  const blockwise = useMemo(() => canRenderBlockwise(content), [content]);
  if (!blockwise) {
    return (
      <MarkdownRenderer
        content={content}
        groupJid={groupJid}
        variant={variant}
      />
    );
  }
  return (
    <MarkdownBlocks
      content={content}
      groupJid={groupJid}
      variant={variant}
      streaming={false}
    />
  );
});
