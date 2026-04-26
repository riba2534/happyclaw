import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import React, { useState, useMemo, memo } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Check } from 'lucide-react';
import { MermaidDiagram } from './MermaidDiagram';
import { toBase64Url } from '../../stores/files';
import { withBasePath } from '../../utils/url';
import 'highlight.js/styles/github.css';
import 'katex/dist/katex.min.css';

interface MarkdownRendererProps {
  content: string;
  groupJid?: string;
  variant?: 'chat' | 'docs';
  /** When true, skip expensive plugins (KaTeX, sanitize) for faster streaming render */
  streaming?: boolean;
  /** When true, force images to load eagerly. Required for offscreen render contexts (e.g. share-image export) where lazy-loaded images would otherwise never start fetching. */
  eagerImages?: boolean;
}

/** Resolve relative image paths to the file download API */
function resolveImageSrc(src: string, groupJid?: string): string {
  if (!groupJid || !src) return src;
  if (/^(https?:\/\/|data:|\/\/)/.test(src) || src.startsWith('/')) return src;
  // Strip #agent:xxx suffix — file API uses the base group JID
  const baseJid = groupJid.replace(/#agent:.*$/, '');
  const encoded = toBase64Url(src);
  return withBasePath(`/api/groups/${encodeURIComponent(baseJid)}/files/download/${encoded}`);
}

/** Image lightbox for markdown images */
function MarkdownImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-pointer"
      onClick={onClose}
    >
      <img
        src={src}
        alt="放大查看"
        className="max-w-[90vw] max-h-[90vh] object-contain cursor-default"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body
  );
}

/** Inline image component with lightbox support */
function MarkdownImage({ src, alt, loading }: { src?: string; alt?: string; loading?: 'lazy' | 'eager' }) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(false);

  if (!src) return null;

  if (error) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 bg-muted text-muted-foreground rounded text-sm">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
        </svg>
        {alt || '图片加载失败'}
      </span>
    );
  }

  return (
    <>
      <img
        src={src}
        alt={alt || ''}
        loading={loading}
        className="my-3 max-w-full rounded-lg border border-border cursor-pointer hover:shadow-md transition-shadow"
        style={{ maxHeight: '400px', objectFit: 'contain' }}
        onClick={() => setExpanded(true)}
        onError={() => setError(true)}
      />
      {expanded && <MarkdownImageLightbox src={src} onClose={() => setExpanded(false)} />}
    </>
  );
}

/** Allow class names on code/span elements so rehype-highlight and KaTeX styles survive sanitization */
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code || []), 'class', 'className'],
    span: [...(defaultSchema.attributes?.span || []), 'class', 'className', 'style', 'aria-hidden'],
    div: [...(defaultSchema.attributes?.div || []), 'class', 'className', 'style'],
    img: ['src', 'alt', 'width', 'height', 'loading', 'longDesc', 'title'],
    math: ['xmlns', 'display'],
    annotation: ['encoding'],
  },
  tagNames: [
    ...(defaultSchema.tagNames || []),
    // MathML tags for KaTeX accessibility layer
    'math', 'semantics', 'mrow', 'mi', 'mn', 'mo', 'msup', 'msub',
    'mfrac', 'mover', 'munder', 'msqrt', 'mroot', 'mtable', 'mtr', 'mtd',
    'mtext', 'mspace', 'mstyle', 'menclose', 'annotation',
    'msubsup', 'munderover', 'mpadded', 'mphantom',
  ],
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src || []), 'data'],
  },
};

function extractText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (React.isValidElement(node)) return extractText((node.props as { children?: React.ReactNode }).children);
  return '';
}

/** Code block / inline code renderer extracted from MarkdownRenderer */
function CodeBlock({
  className,
  children,
  variant = 'chat',
  ...props
}: React.ComponentPropsWithoutRef<'code'> & { className?: string; variant?: 'chat' | 'docs' }) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const lang = match?.[1];
  const codeString = extractText(children).replace(/\n$/, '');
  const isBlock = Boolean(match) || codeString.includes('\n');

  if (lang === 'mermaid') {
    return <MermaidDiagram code={codeString} />;
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(codeString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isBlock) {
    return (
      <div className="relative group my-4 overflow-hidden">
        <div className="absolute right-2 top-2 opacity-70 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity">
          <button
            onClick={handleCopy}
            className="p-2 rounded-lg bg-muted hover:bg-muted/80 text-muted-foreground text-xs flex items-center gap-1"
          >
            {copied ? (
              <>
                <Check size={14} />
                已复制
              </>
            ) : (
              <>
                <Copy size={14} />
                复制
              </>
            )}
          </button>
        </div>
        <pre className="!bg-[var(--code-block-bg)] rounded-lg p-3.5 overflow-x-auto font-mono text-sm">
          <code className={className} {...props}>
            {children}
          </code>
        </pre>
      </div>
    );
  }

  return (
    <code
      className={
        variant === 'chat'
          ? 'bg-[var(--inline-code-bg)] text-[var(--inline-code-text)] px-1 py-px rounded-md text-[0.9em] leading-relaxed font-mono break-all'
          : 'bg-[var(--inline-code-bg)] text-[var(--inline-code-text)] px-1 py-px rounded-md text-sm font-mono break-all'
      }
      {...props}
    >
      {children}
    </code>
  );
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, groupJid, variant = 'chat', streaming = false, eagerImages = false }: MarkdownRendererProps) {
  const textSizeClass = variant === 'chat'
    ? 'text-base leading-[1.65] text-foreground'
    : 'text-sm leading-6 text-foreground';
  const tableTextClass = variant === 'chat' ? 'text-[0.95em]' : 'text-sm';

  // Streaming mode: skip expensive KaTeX + sanitize for faster renders
  const remarkPluginsList = useMemo(() =>
    streaming ? [remarkGfm, remarkBreaks] : [remarkGfm, remarkBreaks, remarkMath],
    [streaming]
  );
  const rehypePluginsList = useMemo(() =>
    streaming
      ? [[rehypeHighlight, { plainText: ['mermaid'] }] as const]
      : [
          rehypeRaw,
          [rehypeHighlight, { plainText: ['mermaid'] }] as const,
          [rehypeKatex, { throwOnError: false, strict: false }] as const,
          [rehypeSanitize, sanitizeSchema] as const,
        ],
    [streaming]
  );

  return (
    <div className={textSizeClass}>
      <ReactMarkdown
        remarkPlugins={remarkPluginsList as any}
        rehypePlugins={rehypePluginsList as any}
        components={{
          code: (props) => <CodeBlock {...props} variant={variant} />,
          img: ({ src, alt }) => <MarkdownImage src={src ? resolveImageSrc(src, groupJid) : undefined} alt={alt} loading={eagerImages ? 'eager' : 'lazy'} />,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary underline break-all"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div
              className="my-4 max-w-full overflow-x-auto overflow-y-hidden overscroll-x-contain [-webkit-overflow-scrolling:touch] [touch-action:pan-x_pan-y]"
              data-swipe-back-ignore="true"
            >
              <table className="min-w-full border-collapse border border-border">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-muted">{children}</thead>
          ),
          tbody: ({ children }) => <tbody className="divide-y divide-border">{children}</tbody>,
          tr: ({ children }) => (
            <tr className="even:bg-surface odd:bg-muted/30">
              {children}
            </tr>
          ),
          th: ({ children }) => (
            <th className={`px-4 py-2 text-left font-semibold text-foreground border border-border whitespace-nowrap align-top ${tableTextClass}`}>
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className={`px-4 py-2 text-foreground border border-border whitespace-nowrap align-top ${tableTextClass}`}>
              {children}
            </td>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-6 my-2 space-y-1">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-6 my-2 space-y-1">{children}</ol>
          ),
          li: ({ children }) => (
            <li className="[&>p]:inline [&>p]:my-0">{children}</li>
          ),
          p: ({ children }) => <p className="my-2">{children}</p>,
          h1: ({ children }) => (
            <h1 className="text-2xl font-bold mt-6 mb-4 leading-tight">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-xl font-bold mt-5 mb-3 leading-tight">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-lg font-semibold mt-4 mb-2 leading-snug">{children}</h3>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-border pl-4 my-4 text-muted-foreground italic">
              {children}
            </blockquote>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
