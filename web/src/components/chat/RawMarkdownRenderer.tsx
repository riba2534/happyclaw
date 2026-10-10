import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { MarkdownContent, type MarkdownRendererProps } from './MarkdownContent';
import { markdownSanitizeSchema } from './markdownSanitizeSchema';

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema] as const,
];

export function RawMarkdownRenderer(props: MarkdownRendererProps) {
  return (
    <MarkdownContent
      {...props}
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      pipeline="raw"
    />
  );
}
