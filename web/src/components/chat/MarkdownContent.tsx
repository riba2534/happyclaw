import React, {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactMarkdown, {
  defaultUrlTransform,
  type ExtraProps,
  type UrlTransform,
} from 'react-markdown';
import { Check, Copy } from 'lucide-react';
import { PreviewDialog } from './PreviewDialog';
import {
  resolveMarkdownImageSrc,
  resolveMarkdownLinkHref,
} from '../../utils/markdownImageSrc';
import { cn } from '@/lib/utils';
import { REMARK_REHYPE_OPTIONS } from '../../lib/markdown/pipeline';
import { useCopyFeedback } from '../../lib/markdown/use-copy-feedback';
import {
  RENDERED_CACHE_MAX_CHARS,
  rememberRendered,
  renderedCost,
} from '../../lib/markdown/rendered-cache';

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
  /**
   * Drop the top margin of the first block and the bottom margin of the last
   * (default), so the content sits flush in its container. A reply rendered
   * as several consecutive renderers passes `false` to keep the margins
   * between its parts.
   */
  trimEdges?: boolean;
}

interface MarkdownContentProps extends MarkdownRendererProps {
  remarkPlugins: readonly unknown[];
  rehypePlugins: readonly unknown[];
  /** Names the plugin set; part of the rendered-tree cache key. */
  pipeline: string;
}

/** Look `key` up in an insertion-ordered LRU, creating it on a miss. */
function rememberRecent<V>(
  cache: Map<string, V>,
  limit: number,
  key: string,
  create: () => V,
): V {
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const value = create();
  cache.set(key, value);
  if (cache.size > limit) cache.delete(cache.keys().next().value!);
  return value;
}

const COMPONENTS_CACHE_LIMIT = 50;
const componentsCache = new Map<string, MarkdownComponents>();

/**
 * Whether the surrounding Markdown is still streaming. Read through context
 * so element renderers don't depend on it: a block closing kept its DOM (and
 * the reader's selection and copy-button state) instead of rebuilding it.
 */
const MarkdownStreamingContext = createContext(false);

/** Inline raster and SVG images; SVG in `<img>` cannot run script. */
const DATA_IMAGE_URL =
  /^data:image\/(?:avif|bmp|gif|jpeg|jpg|png|svg\+xml|webp)[;,]/i;

/**
 * react-markdown's default drops every `data:` URL, while the sanitize
 * schema keeps `data:` image sources; allow exactly inline images.
 */
const markdownUrlTransform: UrlTransform = (url, key, node) =>
  key === 'src' && node.tagName === 'img' && DATA_IMAGE_URL.test(url)
    ? url
    : defaultUrlTransform(url);

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
  title,
  width,
  height,
  loading,
}: {
  src?: string;
  alt?: string;
  title?: string;
  width?: number | string;
  height?: number | string;
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
        title={title}
        width={width}
        height={height}
        loading={loading}
        role="button"
        tabIndex={0}
        aria-label={alt ? `放大图片：${alt}` : '放大图片'}
        className="my-3 h-auto max-w-full cursor-zoom-in rounded-lg border border-surface-border transition-colors hover:border-foreground/25"
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

type ScrollFade = 'none' | 'start' | 'end' | 'both';

/**
 * A horizontal scroller (wide table, long code line) that fades the edge
 * hiding more content, so it reads as scrollable (globals.css
 * `[data-scroll-fade]`). Swipes on it never trigger swipe-back.
 */
function HorizontalScroll({
  as: Tag,
  className,
  children,
}: {
  as: 'div' | 'pre';
  className: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement & HTMLPreElement>(null);
  const [fade, setFade] = useState<ScrollFade>('none');

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const hiddenStart = element.scrollLeft > 1;
      const hiddenEnd =
        element.scrollWidth - element.clientWidth - element.scrollLeft > 1;
      setFade(
        hiddenStart && hiddenEnd
          ? 'both'
          : hiddenStart
            ? 'start'
            : hiddenEnd
              ? 'end'
              : 'none',
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    element.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => {
      element.removeEventListener('scroll', schedule);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <Tag
      ref={ref}
      className={className}
      data-scroll-fade={fade}
      data-swipe-back-ignore="true"
    >
      {children}
    </Tag>
  );
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

/** Fenced code languages include `c++`, `c#` and `objective-c`. */
const CODE_LANGUAGE = /language-([\w+#.-]+)/;

function CodeBlock({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const streaming = useContext(MarkdownStreamingContext);
  const { copied, copy } = useCopyFeedback();
  const lang = CODE_LANGUAGE.exec(className || '')?.[1];
  const codeString = extractText(children).replace(/\n$/, '');
  const diff = lang === 'diff';

  if (lang === 'mermaid') {
    return (
      <Suspense fallback={<MermaidFallback code={codeString} />}>
        <MermaidDiagram code={codeString} deferred={streaming} />
      </Suspense>
    );
  }

  return (
    <div className="group/code my-4 overflow-hidden rounded-lg border border-surface-border bg-(--code-block-bg) font-sans">
      <div className="flex h-8 items-center justify-between border-b border-surface-border px-3 text-caption text-muted-foreground select-none pointer-coarse:h-10">
        <span className="font-mono text-micro tracking-wide lowercase">
          {lang || 'text'}
        </span>
        <button
          type="button"
          onClick={() => copy(codeString)}
          aria-label={copied ? '已复制代码' : '复制代码'}
          className="-mr-1.5 inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-surface-hover hover:text-foreground pointer-coarse:-mr-2.5 pointer-coarse:h-10 pointer-coarse:px-2.5"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <HorizontalScroll
        as="pre"
        className={cn(
          'overflow-x-auto overscroll-x-contain bg-transparent! py-3 font-mono text-[13px] leading-5',
          diff ? 'px-0' : 'px-3.5',
        )}
      >
        {/* A diff's code element holds the inline padding instead, so its
            line tints reach the block edges (globals.css). */}
        <code className={className}>{children}</code>
      </HorizontalScroll>
    </div>
  );
}

interface CodeElementProps {
  className?: string;
  children?: React.ReactNode;
  node?: { tagName?: string };
}

/** The `<code>` element a `<pre>` wraps, as react-markdown rendered it. */
function codeElementProps(children: React.ReactNode): CodeElementProps | null {
  const nodes = React.Children.toArray(children);
  if (nodes.length !== 1) return null;
  const [only] = nodes;
  if (!React.isValidElement<CodeElementProps>(only)) return null;
  return only.props.node?.tagName === 'code' ? only.props : null;
}

/**
 * Jump to an in-page target (footnotes) inside the same Markdown root
 * instead of navigating: footnote ids repeat across messages, sanitized HTML
 * gains a `user-content-` prefix that the link lacks, and a link such as
 * `#root` must never reach the app's own elements. Content that uses
 * footnotes renders as one root.
 */
function scrollToMarkdownAnchor(event: React.MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  const href = event.currentTarget.getAttribute('href') ?? '';
  let id: string;
  try {
    id = decodeURIComponent(href.slice(1));
  } catch {
    id = href.slice(1);
  }
  const scope = event.currentTarget.closest('[data-markdown-root]');
  if (!id || !scope) return;
  for (const candidate of [id, `user-content-${id}`]) {
    const target = scope.querySelector(`[id="${CSS.escape(candidate)}"]`);
    if (!target) continue;
    const reduceMotion = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    target.scrollIntoView({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'center',
    });
    return;
  }
}

type MarkdownOptions = React.ComponentProps<typeof ReactMarkdown>;
type MarkdownComponents = NonNullable<MarkdownOptions['components']>;

/**
 * Element renderers for react-markdown, shared per variant and group. A
 * fresh object of inline components on every render gave every element a
 * new component type, so React tore down and rebuilt the whole rendered
 * Markdown on each streaming update (losing text selection and copy-button
 * state, and recreating ~1,000 DOM nodes per second). Sharing them across
 * mounts also keeps cached trees and fresh renders on the same types.
 */
function sharedMarkdownComponents(
  variant: 'chat' | 'docs',
  groupJid: string | undefined,
  eagerImages: boolean,
): MarkdownComponents {
  return rememberRecent(
    componentsCache,
    COMPONENTS_CACHE_LIMIT,
    [variant, groupJid ?? '', eagerImages].join('\0'),
    () => markdownComponents(variant, groupJid, eagerImages),
  );
}

const TASK_LIST_ITEM =
  'relative pl-6 [&_input]:absolute [&_input]:top-[0.4em] [&_input]:left-0 [&_input]:m-0 [&_input]:size-3.5 [&_input]:accent-primary';
const LIST_ITEM_PARAGRAPHS =
  '[&>p]:my-1 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0';
const MINOR_HEADING =
  'mt-3 mb-1 text-[0.95em] leading-snug font-semibold text-foreground/75';

function markdownComponents(
  variant: 'chat' | 'docs',
  groupJid: string | undefined,
  eagerImages: boolean,
): MarkdownComponents {
  const tableTextClass = variant === 'chat' ? 'text-[0.95em]' : 'text-sm';
  const inlineCodeClass =
    variant === 'chat'
      ? 'bg-[var(--inline-code-bg)] text-[var(--inline-code-text)] px-1 py-px rounded-md text-[0.9em] leading-relaxed font-mono [overflow-wrap:anywhere]'
      : 'bg-[var(--inline-code-bg)] text-[var(--inline-code-text)] px-1 py-px rounded-md text-sm font-mono [overflow-wrap:anywhere]';
  return {
    // Block code is rendered from its `<pre>`, so a one-line fence without a
    // language is still a block; `code` only ever renders inline code.
    pre: ({ children }) => {
      const code = codeElementProps(children);
      return (
        <CodeBlock className={code?.className}>
          {code ? code.children : children}
        </CodeBlock>
      );
    },
    code: ({ children }) => <code className={inlineCodeClass}>{children}</code>,
    img: ({ src, alt, title, width, height }) => (
      <MarkdownImage
        src={
          typeof src === 'string'
            ? resolveMarkdownImageSrc(src, groupJid)
            : undefined
        }
        alt={alt}
        title={title}
        width={width}
        height={height}
        loading={eagerImages ? 'eager' : 'lazy'}
      />
    ),
    a: ({
      node: _node,
      href,
      children,
      className: _className,
      ...rest
    }: React.ComponentPropsWithoutRef<'a'> & ExtraProps) => {
      const inPage = href?.startsWith('#') ?? false;
      return (
        <a
          {...rest}
          href={
            href && !inPage ? resolveMarkdownLinkHref(href, groupJid) : href
          }
          {...(inPage
            ? { onClick: scrollToMarkdownAnchor }
            : { target: '_blank', rel: 'noopener noreferrer' })}
          className="text-primary-text underline [overflow-wrap:anywhere] hover:text-primary-text"
        >
          {children}
        </a>
      );
    },
    table: ({ children }) => (
      <HorizontalScroll
        as="div"
        className="my-4 max-w-full overflow-x-auto overflow-y-hidden overscroll-x-contain rounded-lg border border-surface-border [-webkit-overflow-scrolling:touch] [touch-action:pan-x_pan-y]"
      >
        <table className="min-w-full border-separate border-spacing-0 font-sans">
          {children}
        </table>
      </HorizontalScroll>
    ),
    thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => (
      <tr className="[&:not(:last-child)>td]:border-b [&>td]:border-surface-border">
        {children}
      </tr>
    ),
    // GFM column alignment arrives as an inline `text-align` style.
    th: ({ children, style }) => (
      <th
        style={style}
        className="border-b border-surface-border px-3 py-2 text-start align-top text-caption font-medium whitespace-nowrap text-foreground/75"
      >
        {children}
      </th>
    ),
    td: ({ children, style }) => (
      <td
        style={style}
        className={cn(
          'min-w-[6rem] max-w-[28rem] px-3 py-2 text-start align-top whitespace-normal text-foreground [overflow-wrap:anywhere]',
          tableTextClass,
        )}
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
            : 'my-2 list-disc space-y-1 pl-6 [ul_&]:list-[circle] [ul_ul_&]:list-[square]'
        }
      >
        {children}
      </ul>
    ),
    ol: ({ children, className, start }) => (
      <ol
        start={start}
        className={
          className?.includes('contains-task-list')
            ? 'my-2 list-none space-y-1 pl-1'
            : 'my-2 list-decimal space-y-1 pl-6'
        }
      >
        {children}
      </ol>
    ),
    // The checkbox sits in its own column, so wrapped text and nested lists
    // align with the item text instead of starting under the checkbox.
    li: ({ children, className, id }) => (
      <li
        id={id}
        className={cn(
          LIST_ITEM_PARAGRAPHS,
          className?.includes('task-list-item') && TASK_LIST_ITEM,
        )}
      >
        {children}
      </li>
    ),
    p: ({ children }) => <p className="my-2">{children}</p>,
    h1: ({ children, id }) => (
      <h1
        id={id}
        className="mt-6 mb-3 text-[1.35em] leading-tight font-semibold tracking-tight"
      >
        {children}
      </h1>
    ),
    // The footnote section's heading is visually hidden but kept for
    // screen readers.
    h2: ({ children, id, className }) =>
      className?.includes('sr-only') ? (
        <h2 id={id} className="sr-only">
          {children}
        </h2>
      ) : (
        <h2
          id={id}
          className="mt-5 mb-2.5 text-[1.2em] leading-tight font-semibold tracking-tight"
        >
          {children}
        </h2>
      ),
    h3: ({ children, id }) => (
      <h3
        id={id}
        className="mt-4 mb-2 text-[1.05em] leading-snug font-semibold"
      >
        {children}
      </h3>
    ),
    h4: ({ children, id }) => (
      <h4 id={id} className="mt-4 mb-1.5 text-[1em] leading-snug font-semibold">
        {children}
      </h4>
    ),
    h5: ({ children, id }) => (
      <h5 id={id} className={MINOR_HEADING}>
        {children}
      </h5>
    ),
    h6: ({ children, id }) => (
      <h6 id={id} className={MINOR_HEADING}>
        {children}
      </h6>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-4 border-l-2 border-foreground/15 pl-4 text-foreground/80">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-6 border-surface-border" />,
    kbd: ({ children }) => (
      <kbd className="rounded border border-b-2 border-surface-border bg-muted px-1.5 py-px font-mono text-[0.85em] text-foreground">
        {children}
      </kbd>
    ),
    details: ({ children, open }) => (
      <details
        open={open}
        className="my-3 rounded-lg border border-surface-border px-3 py-2 [&>*:last-child]:mb-0 [&[open]>summary]:mb-2"
      >
        {children}
      </details>
    ),
    summary: ({ children }) => (
      <summary className="cursor-pointer font-medium select-none marker:text-muted-foreground">
        {children}
      </summary>
    ),
    section: ({ children, className }) =>
      className?.includes('footnotes') ? (
        <section
          data-footnotes=""
          className="mt-6 border-t border-surface-border pt-3 text-caption text-foreground/75 [&>ol]:my-0 [&>ol]:pl-5"
        >
          {children}
        </section>
      ) : (
        <section>{children}</section>
      ),
  };
}

export function MarkdownContent({
  content,
  groupJid,
  variant = 'chat',
  eagerImages = false,
  streaming = false,
  trimEdges = true,
  remarkPlugins,
  rehypePlugins,
  pipeline,
}: MarkdownContentProps) {
  const textSizeClass =
    variant === 'chat'
      ? 'text-body-lg leading-[1.7] text-foreground'
      : 'text-sm leading-6 text-foreground';
  const components = useMemo(
    () => sharedMarkdownComponents(variant, groupJid, eagerImages),
    [variant, groupJid, eagerImages],
  );
  const rendered = useMemo(() => {
    // react-markdown's sync renderer is a plain function of its options.
    const render = () =>
      ReactMarkdown({
        remarkPlugins: remarkPlugins as MarkdownOptions['remarkPlugins'],
        rehypePlugins: rehypePlugins as MarkdownOptions['rehypePlugins'],
        remarkRehypeOptions: REMARK_REHYPE_OPTIONS,
        urlTransform: markdownUrlTransform,
        components,
        children: content,
      });
    if (streaming || content.length > RENDERED_CACHE_MAX_CHARS) return render();
    return rememberRendered(
      [pipeline, variant, groupJid ?? '', eagerImages, content].join('\0'),
      renderedCost(content, pipeline.includes('code')),
      render,
    );
  }, [
    content,
    components,
    remarkPlugins,
    rehypePlugins,
    pipeline,
    streaming,
    variant,
    groupJid,
    eagerImages,
  ]);

  return (
    <div
      data-markdown-root=""
      className={cn(
        textSizeClass,
        // Chat prose keeps a readable line length in full-width (compact)
        // layouts; the bubble layout is narrower than this already.
        variant === 'chat' &&
          'max-w-[46rem] [.share-card-content_&]:max-w-none',
        // Contain whatever paints outside the flow, such as a KaTeX
        // `\kern{-500em}` or `\raisebox`, without a new formatting context
        // (margins between block-rendered parts still collapse). The share
        // card lets wide tables overflow so it can grow to fit them.
        'overflow-clip [overflow-clip-margin:0.25rem] [.share-card-content_&]:overflow-visible',
        trimEdges && '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
      )}
    >
      <MarkdownStreamingContext.Provider value={streaming}>
        {rendered}
      </MarkdownStreamingContext.Provider>
    </div>
  );
}
