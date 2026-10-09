import React, { lazy, Suspense, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Check, Copy } from 'lucide-react';
import { PreviewDialog } from './PreviewDialog';
import { resolveMarkdownImageSrc } from '../../utils/markdownImageSrc';

const MermaidDiagram = lazy(() =>
  import('./MermaidDiagram').then((module) => ({
    default: module.MermaidDiagram,
  })),
);

export interface MarkdownRendererProps {
  content: string;
  groupJid?: string;
  variant?: 'chat' | 'docs';
  /** During streaming, keep the parser deliberately lightweight. */
  streaming?: boolean;
  /** Force images to load in offscreen export contexts. */
  eagerImages?: boolean;
}

interface MarkdownContentProps extends MarkdownRendererProps {
  remarkPlugins: readonly unknown[];
  rehypePlugins: readonly unknown[];
}

function MarkdownImageLightbox({
  src,
  onClose,
}: {
  src: string;
  onClose: () => void;
}) {
  return (
    <PreviewDialog
      title="图片预览"
      onClose={onClose}
      layer="nested"
      className="left-1/2 top-1/2 max-h-[90dvh] max-w-[90vw] -translate-x-1/2 -translate-y-1/2"
    >
      <img
        src={src}
        alt="放大查看"
        className="max-w-[90vw] max-h-[90vh] object-contain cursor-default"
      />
    </PreviewDialog>
  );
}

function MarkdownImage({
  src,
  alt,
  loading,
}: {
  src?: string;
  alt?: string;
  loading?: 'lazy' | 'eager';
}) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(false);

  if (!src) return null;
  if (error) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 bg-muted text-muted-foreground rounded text-sm">
        <svg
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5Z"
          />
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
        role="button"
        tabIndex={0}
        aria-label={alt ? `放大图片：${alt}` : '放大图片'}
        className="my-3 max-w-full cursor-zoom-in rounded-lg ring-1 ring-surface-border transition-shadow hover:ring-foreground/25"
        style={{ maxHeight: '400px', objectFit: 'contain' }}
        onClick={() => setExpanded(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setExpanded(true);
          }
        }}
        onError={() => setError(true)}
      />
      {expanded && (
        <MarkdownImageLightbox src={src} onClose={() => setExpanded(false)} />
      )}
    </>
  );
}

function extractText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (React.isValidElement(node)) {
    return extractText((node.props as { children?: React.ReactNode }).children);
  }
  return '';
}

function MermaidFallback({ code }: { code: string }) {
  return (
    <div
      className="my-4 animate-pulse rounded-lg border border-border bg-muted p-4"
      data-markdown-pending="true"
    >
      <div className="mb-2 text-xs text-muted-foreground">正在加载图表…</div>
      <pre className="overflow-x-auto text-sm">
        <code className="language-mermaid">{code}</code>
      </pre>
    </div>
  );
}

function CodeBlock({
  className,
  children,
  variant = 'chat',
  ...props
}: React.ComponentPropsWithoutRef<'code'> & {
  className?: string;
  variant?: 'chat' | 'docs';
}) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const lang = match?.[1];
  const codeString = extractText(children).replace(/\n$/, '');
  const isBlock = Boolean(match) || codeString.includes('\n');

  if (lang === 'mermaid') {
    return (
      <Suspense fallback={<MermaidFallback code={codeString} />}>
        <MermaidDiagram code={codeString} />
      </Suspense>
    );
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(codeString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isBlock) {
    return (
      <div className="group/code my-4 overflow-hidden rounded-lg bg-(--code-block-bg) font-sans ring-1 ring-surface-border">
        <div className="flex h-8 items-center justify-between border-b border-surface-border px-3 text-caption text-muted-foreground">
          <span className="font-mono text-micro tracking-wide lowercase">
            {lang || 'text'}
          </span>
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? '已复制代码' : '复制代码'}
            className="-mr-1.5 inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
        <pre className="overflow-x-auto bg-transparent! px-3.5 py-3 font-mono text-[13px] leading-5">
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

type MarkdownComponents = NonNullable<
  React.ComponentProps<typeof ReactMarkdown>['components']
>;

/**
 * Element renderers for react-markdown, memoized per variant and group. A
 * fresh object of inline components on every render gave every element a
 * new component type, so React tore down and rebuilt the whole rendered
 * Markdown on each streaming update (losing text selection and copy-button
 * state, and recreating ~1,000 DOM nodes per second).
 */
function markdownComponents(
  variant: 'chat' | 'docs',
  groupJid: string | undefined,
  eagerImages: boolean,
): MarkdownComponents {
  const tableTextClass = variant === 'chat' ? 'text-[0.95em]' : 'text-sm';
  return {
    code: (props) => <CodeBlock {...props} variant={variant} />,
    img: ({ src, alt }) => (
      <MarkdownImage
        src={src ? resolveMarkdownImageSrc(src, groupJid) : undefined}
        alt={alt}
        loading={eagerImages ? 'eager' : 'lazy'}
      />
    ),
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary-text hover:text-primary-text underline break-all"
      >
        {children}
      </a>
    ),
    table: ({ children }) => (
      <div
        className="my-4 max-w-full overflow-x-auto overflow-y-hidden overscroll-x-contain [-webkit-overflow-scrolling:touch] [touch-action:pan-x_pan-y]"
        data-swipe-back-ignore="true"
      >
        <table className="min-w-full border-separate border-spacing-0 overflow-hidden rounded-lg font-sans ring-1 ring-surface-border">
          {children}
        </table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => (
      <tr className="[&:not(:last-child)>td]:border-b [&>td]:border-surface-border">
        {children}
      </tr>
    ),
    th: ({ children }) => (
      <th className="border-b border-surface-border px-3 py-2 text-left align-top text-caption font-medium whitespace-nowrap text-muted-foreground">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td
        className={`px-3 py-2 align-top whitespace-nowrap text-foreground ${tableTextClass}`}
      >
        {children}
      </td>
    ),
    // GFM task lists: no bullet, a small themed checkbox instead.
    ul: ({ children, className }) => (
      <ul
        className={
          className?.includes('contains-task-list')
            ? 'my-2 list-none space-y-1 pl-1'
            : 'my-2 list-disc space-y-1 pl-6'
        }
      >
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal pl-6 my-2 space-y-1">{children}</ol>
    ),
    li: ({ children, className }) => (
      <li
        className={
          className?.includes('task-list-item')
            ? 'flex items-start gap-2 [&>input]:mt-[0.45em] [&>input]:size-3.5 [&>input]:shrink-0 [&>input]:accent-primary [&>p]:my-0'
            : '[&>p]:inline [&>p]:my-0'
        }
      >
        {children}
      </li>
    ),
    p: ({ children }) => <p className="my-2">{children}</p>,
    h1: ({ children }) => (
      <h1 className="mt-6 mb-3 text-[1.35em] leading-tight font-semibold tracking-tight">
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className="mt-5 mb-2.5 text-[1.2em] leading-tight font-semibold tracking-tight">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="mt-4 mb-2 text-[1.05em] leading-snug font-semibold">
        {children}
      </h3>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-4 border-l-2 border-foreground/15 pl-4 text-muted-foreground">
        {children}
      </blockquote>
    ),
  };
}

export function MarkdownContent({
  content,
  groupJid,
  variant = 'chat',
  eagerImages = false,
  remarkPlugins,
  rehypePlugins,
}: MarkdownContentProps) {
  const textSizeClass =
    variant === 'chat'
      ? 'text-body-lg leading-[1.7] text-foreground'
      : 'text-sm leading-6 text-foreground';
  const components = useMemo(
    () => markdownComponents(variant, groupJid, eagerImages),
    [variant, groupJid, eagerImages],
  );

  return (
    <div className={textSizeClass}>
      <ReactMarkdown
        remarkPlugins={
          remarkPlugins as React.ComponentProps<
            typeof ReactMarkdown
          >['remarkPlugins']
        }
        rehypePlugins={
          rehypePlugins as React.ComponentProps<
            typeof ReactMarkdown
          >['rehypePlugins']
        }
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
