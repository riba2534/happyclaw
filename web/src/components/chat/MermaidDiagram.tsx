import { useEffect, useRef, useState } from 'react';
import { Copy, Check, Maximize2, X } from 'lucide-react';
import DOMPurify from 'dompurify';
import { PreviewDialog } from './PreviewDialog';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/common/IconButton';

/** 对 mermaid 渲染的 SVG 进行消毒，防止 XSS */
function sanitizeSvg(raw: string): string {
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['foreignObject'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
  });
}

let mermaidPromise: Promise<typeof import('mermaid')> | null = null;
let idCounter = 0;

/**
 * Rendered diagrams by source. The transcript is virtualized, so a diagram
 * scrolled back into view used to mount fresh: placeholder, 300ms debounce
 * and a full Mermaid render (a long task of 100-200ms at 4x CPU throttle)
 * every time. Least recently used entries are dropped past the cap.
 */
type MermaidResult =
  | { svg: string; error: null }
  | { svg: null; error: string };
const MERMAID_CACHE_LIMIT = 50;
const mermaidCache = new Map<string, MermaidResult>();

function cachedResult(code: string): MermaidResult | undefined {
  const hit = mermaidCache.get(code);
  if (hit) {
    mermaidCache.delete(code);
    mermaidCache.set(code, hit);
  }
  return hit;
}

function cacheResult(code: string, result: MermaidResult) {
  mermaidCache.delete(code);
  mermaidCache.set(code, result);
  if (mermaidCache.size > MERMAID_CACHE_LIMIT) {
    mermaidCache.delete(mermaidCache.keys().next().value!);
  }
}

function isRetryableMermaidLoadError(error: unknown): boolean {
  const raw =
    error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const text = raw.toLowerCase();
  return (
    text.includes('failed to fetch dynamically imported module') ||
    text.includes('importing a module script failed') ||
    text.includes('chunkloaderror') ||
    (text.includes('chunk') && text.includes('failed'))
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid')
      .then((mod) => {
        mod.default.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'default',
        });
        return mod;
      })
      .catch((error) => {
        // Import failure should not poison subsequent retries.
        mermaidPromise = null;
        throw error;
      });
  }
  return mermaidPromise;
}

interface MermaidDiagramProps {
  code: string;
  /**
   * Show the placeholder without rendering: a diagram still being streamed is
   * incomplete, and the final message renders it once complete.
   */
  deferred?: boolean;
}

export function MermaidDiagram({
  code,
  deferred = false,
}: MermaidDiagramProps) {
  const idRef = useRef(`mermaid-${++idCounter}`);
  const [initial] = useState(() => cachedResult(code));
  const [svg, setSvg] = useState<string | null>(initial?.svg ?? null);
  const [error, setError] = useState<string | null>(initial?.error ?? null);
  const [loading, setLoading] = useState(!initial);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const codeRef = useRef(code);
  codeRef.current = code;
  // The first render of a diagram starts at once; only later changes of the
  // source (a diagram still being streamed) wait out the debounce.
  const renderedOnceRef = useRef(false);

  useEffect(() => {
    if (deferred) return;
    const cached = cachedResult(code);
    if (cached) {
      renderedOnceRef.current = true;
      setSvg(cached.svg);
      setError(cached.error);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    clearTimeout(debounceRef.current);
    let disposed = false;

    const renderWithRetry = async (
      diagramCode: string,
      attempt: number,
    ): Promise<string> => {
      try {
        const mermaid = await loadMermaid();
        const { svg: rendered } = await mermaid.default.render(
          `${idRef.current}-${attempt}`,
          diagramCode,
        );
        return rendered;
      } catch (error) {
        if (attempt === 0 && isRetryableMermaidLoadError(error)) {
          mermaidPromise = null;
          await sleep(300);
          return renderWithRetry(diagramCode, 1);
        }
        throw error;
      }
    };

    debounceRef.current = setTimeout(
      async () => {
        const currentCode = codeRef.current;
        try {
          const rendered = sanitizeSvg(await renderWithRetry(currentCode, 0));
          cacheResult(currentCode, { svg: rendered, error: null });
          if (!disposed && codeRef.current === currentCode) {
            setSvg(rendered);
            setError(null);
            setLoading(false);
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          // Chunk-load failures are retried on the next mount, syntax errors
          // are not.
          if (!isRetryableMermaidLoadError(e)) {
            cacheResult(currentCode, { svg: null, error: message });
          }
          if (!disposed && codeRef.current === currentCode) {
            setError(message);
            setSvg(null);
            setLoading(false);
          }
        }
      },
      renderedOnceRef.current ? 300 : 0,
    );
    renderedOnceRef.current = true;

    return () => {
      disposed = true;
      clearTimeout(debounceRef.current);
    };
  }, [code, deferred]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copyButton = (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={handleCopy}
      className="-mr-1.5 font-normal text-muted-foreground [.share-card-content_&]:hidden"
    >
      {copied ? <Check /> : <Copy />}
      {copied ? '已复制' : error ? '复制' : '源码'}
    </Button>
  );

  // The diagram canvas keeps `bg-card`: Mermaid's default theme assumes a
  // light canvas, and the share card pins --card to white for its export.
  if (loading || deferred) {
    return (
      <div className="my-4 flex items-center justify-center rounded-lg bg-card p-8 ring-1 ring-surface-border">
        <div className="flex animate-pulse flex-col items-center gap-2">
          <div className="h-24 w-48 rounded bg-surface-selected" />
          <span className="text-caption text-muted-foreground">
            Mermaid 图表渲染中...
          </span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="my-4 overflow-hidden rounded-lg bg-(--code-block-bg) font-sans ring-1 ring-surface-border">
        <div className="flex h-8 items-center justify-between gap-2 border-b border-surface-border px-3">
          <span className="truncate text-caption text-warning">
            Mermaid 语法错误，已降级为代码展示
          </span>
          {copyButton}
        </div>
        <pre className="overflow-x-auto bg-transparent! px-3.5 py-3 font-mono text-caption leading-5">
          <code className="language-mermaid text-foreground">{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <>
      {/* Inside an exported share card, drop the toolbar and use the card's
          fixed light border so the frame stays visible in dark mode. */}
      <div className="my-4 overflow-hidden rounded-lg bg-card font-sans ring-1 ring-surface-border [.share-card-content_&]:ring-border">
        <div className="flex h-8 items-center justify-between gap-2 border-b border-surface-border px-3 [.share-card-content_&]:hidden">
          <span className="font-mono text-micro tracking-wide text-muted-foreground lowercase">
            mermaid
          </span>
          <div className="flex items-center gap-0.5">
            <IconButton
              label="放大查看"
              icon={<Maximize2 />}
              size="icon-xs"
              onClick={() => setExpanded(true)}
              className="text-muted-foreground"
            />
            {copyButton}
          </div>
        </div>
        <div
          className="flex cursor-zoom-in justify-center overflow-x-auto p-4 [&>svg]:!h-auto [&>svg]:!max-w-full"
          onClick={() => setExpanded(true)}
          dangerouslySetInnerHTML={{ __html: svg! }}
        />
      </div>
      {expanded && (
        <PreviewDialog
          title="Mermaid 图表预览"
          onClose={() => setExpanded(false)}
          layer="nested"
          className="left-1/2 top-1/2 h-[95dvh] w-[95vw] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-card p-6 shadow-floating ring-1 ring-foreground/10"
        >
          <IconButton
            label="关闭图表预览"
            hideTooltip
            icon={<X />}
            size="icon"
            onClick={() => setExpanded(false)}
            className="absolute top-3 right-3 z-20 text-muted-foreground"
          />
          <div
            className="flex h-full w-full items-center justify-center overflow-auto [touch-action:pan-x_pan-y_pinch-zoom] [&>svg]:!h-auto [&>svg]:!max-h-[90vh] [&>svg]:!w-[90vw] [&>svg]:!max-w-none"
            dangerouslySetInnerHTML={{ __html: svg! }}
          />
        </PreviewDialog>
      )}
    </>
  );
}
