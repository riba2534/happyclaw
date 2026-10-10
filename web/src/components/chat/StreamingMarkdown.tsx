import { memo, useMemo } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { splitMarkdownBlocks } from '../../lib/markdown-blocks';

const StreamingBlock = memo(function StreamingBlock({
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
 * A streamed Markdown reply rendered in full. Finished blocks are memoized and
 * rendered as final Markdown (so their code, math and diagrams settle as soon
 * as they close); only the open last block re-parses as text arrives. This
 * keeps per-update cost bounded without hiding the start of long replies.
 */
export function StreamingMarkdown({
  content,
  groupJid,
  variant = 'chat',
}: {
  content: string;
  groupJid?: string;
  variant?: 'chat' | 'docs';
}) {
  const blocks = useMemo(() => splitMarkdownBlocks(content), [content]);
  return (
    // Only the reply's first element loses its top margin (the block may sit
    // inside a Suspense fallback wrapper while its renderer loads).
    <div className="[&>:first-child_[data-markdown-root]>*:first-child]:!mt-0 [&>[data-markdown-root]:first-child>*:first-child]:!mt-0">
      {blocks.map((block, index) => (
        <StreamingBlock
          // Blocks only ever append, so the index is a stable identity.
          key={index}
          content={block}
          open={index === blocks.length - 1}
          groupJid={groupJid}
          variant={variant}
        />
      ))}
    </div>
  );
}
