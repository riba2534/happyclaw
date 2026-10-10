import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Copy, Check, Maximize2, X } from 'lucide-react';
import DOMPurify from 'dompurify';
import { PreviewDialog } from './PreviewDialog';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/common/IconButton';
import { useCopyFeedback } from '../../lib/markdown/use-copy-feedback';

/** 对 mermaid 渲染的 SVG 进行消毒，防止 XSS */
function sanitizeSvg(raw: string): string {
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['foreignObject'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
  });
}

type MermaidTheme = 'default' | 'dark';

/**
 * Labels are drawn as SVG text: HTML labels live in `<foreignObject>`, whose
 * content the SVG sanitizer empties (edge labels lost their background and
 * node labels their wrapping).
 */
const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: 'strict',
  htmlLabels: false,
} as const;

let mermaidPromise: Promise<typeof import('mermaid')> | null = null;
let initializedTheme: MermaidTheme | null = null;
/** Renders run one at a time, each right after selecting its theme. */
let renderQueue: Promise<unknown> = Promise.resolve();
let idCounter = 0;

function subscribeToDarkMode(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });
  return () => observer.disconnect();
}

function isDarkMode() {
  return document.documentElement.classList.contains('dark');
}

/** Whether the app is in dark mode (the `.dark` class on `<html>`). */
function useDarkMode() {
  return useSyncExternalStore(subscribeToDarkMode, isDarkMode, () => false);
}

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

function cacheKey(theme: MermaidTheme, code: string) {
  return `${theme}\0${code}`;
}

function cachedResult(key: string): MermaidResult | undefined {
  const hit = mermaidCache.get(key);
  if (hit) {
    mermaidCache.delete(key);
    mermaidCache.set(key, hit);
  }
  return hit;
}

function cacheResult(key: string, result: MermaidResult) {
  mermaidCache.delete(key);
  mermaidCache.set(key, result);
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
        mod.default.initialize({ ...MERMAID_CONFIG, theme: 'default' });
        initializedTheme = 'default';
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

/**
 * Mermaid's theme is global configuration, so select it and render in one
 * step, never interleaved with another diagram's render.
 */
function renderMermaid(
  id: string,
  code: string,
  theme: MermaidTheme,
): Promise<string> {
  const render = renderQueue.then(async () => {
    const mermaid = (await loadMermaid()).default;
    if (initializedTheme !== theme) {
      mermaid.initialize({ ...MERMAID_CONFIG, theme });
      initializedTheme = theme;
    }
    const { svg } = await mermaid.render(id, code);
    return svg;
  });
  renderQueue = render.catch(() => undefined);
  return render;
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
  const darkMode = useDarkMode();
  // An exported share card is always light, whatever the app theme.
  const [inShareCard, setInShareCard] = useState(false);
  const theme: MermaidTheme = darkMode && !inShareCard ? 'dark' : 'default';
  const [initial] = useState(() => cachedResult(cacheKey(theme, code)));
  const [svg, setSvg] = useState<string | null>(initial?.svg ?? null);
  const [error, setError] = useState<string | null>(initial?.error ?? null);
  const [loading, setLoading] = useState(!initial);
  const { copied, copy } = useCopyFeedback();
  const [expanded, setExpanded] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const renderKeyRef = useRef(cacheKey(theme, code));
  renderKeyRef.current = cacheKey(theme, code);
  // The first render of a diagram starts at once; only later changes of the
  // source (a diagram still being streamed) wait out the debounce.
  const renderedCodeRef = useRef<string | null>(null);

  const rootRef = useCallback((node: HTMLDivElement | null) => {
    if (node) setInShareCard(Boolean(node.closest('.share-card-content')));
  }, []);

  useEffect(() => {
    if (deferred) return;
    const key = cacheKey(theme, code);
    const cached = cachedResult(key);
    if (cached) {
      renderedCodeRef.current = code;
      setSvg(cached.svg);
      setError(cached.error);
      setLoading(false);
      return;
    }
    // A theme switch keeps what is shown (diagram or syntax error) until the
    // new render is ready; only new source shows the placeholder.
    if (renderedCodeRef.current !== code) {
      setLoading(true);
      setError(null);
    }
    clearTimeout(debounceRef.current);
    let disposed = false;

    const renderWithRetry = async (
      diagramCode: string,
      attempt: number,
    ): Promise<string> => {
      try {
        return await renderMermaid(
          `${idRef.current}-${attempt}`,
          diagramCode,
          theme,
        );
      } catch (error) {
        if (attempt === 0 && isRetryableMermaidLoadError(error)) {
          mermaidPromise = null;
          await sleep(300);
          return renderWithRetry(diagramCode, 1);
        }
        throw error;
      }
    };

    const delay =
      renderedCodeRef.current !== null && renderedCodeRef.current !== code
        ? 300
        : 0;
    renderedCodeRef.current = code;
    debounceRef.current = setTimeout(async () => {
      try {
        const rendered = sanitizeSvg(await renderWithRetry(code, 0));
        cacheResult(key, { svg: rendered, error: null });
        if (!disposed && renderKeyRef.current === key) {
          setSvg(rendered);
          setError(null);
          setLoading(false);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Chunk-load failures are retried on the next mount, syntax errors
        // are not.
        if (!isRetryableMermaidLoadError(e)) {
          cacheResult(key, { svg: null, error: message });
        }
        if (!disposed && renderKeyRef.current === key) {
          setError(message);
          setSvg(null);
          setLoading(false);
        }
      }
    }, delay);

    return () => {
      disposed = true;
      clearTimeout(debounceRef.current);
    };
  }, [code, deferred, theme]);

  const copyButton = (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={() => copy(code)}
      className="-mr-1.5 font-normal text-muted-foreground pointer-coarse:h-10 pointer-coarse:px-2.5 [.share-card-content_&]:hidden"
    >
      {copied ? <Check /> : <Copy />}
      {copied ? '已复制' : error ? '复制' : '源码'}
    </Button>
  );

  // The canvas is `bg-card`, which follows the app theme like the diagram
  // does; the share card pins --card to white and renders the light theme.
  if (loading || deferred) {
    return (
      <div
        ref={rootRef}
        className="my-4 flex items-center justify-center rounded-lg border border-surface-border bg-card p-8"
      >
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
      <div
        ref={rootRef}
        className="my-4 overflow-hidden rounded-lg border border-surface-border bg-(--code-block-bg) font-sans"
      >
        <div className="flex h-8 items-center justify-between gap-2 border-b border-surface-border px-3 select-none pointer-coarse:h-10">
          <span className="truncate text-caption text-warning">
            Mermaid 语法错误，已降级为代码展示
          </span>
          {copyButton}
        </div>
        <pre
          className="overflow-x-auto bg-transparent! px-3.5 py-3 font-mono text-caption leading-5"
          data-swipe-back-ignore="true"
        >
          <code className="language-mermaid text-foreground">{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <>
      {/* Inside an exported share card, drop the toolbar and use the card's
          fixed light border so the frame stays visible in dark mode. */}
      <div
        ref={rootRef}
        className="my-4 overflow-hidden rounded-lg border border-surface-border bg-card font-sans [.share-card-content_&]:border-border"
      >
        <div className="flex h-8 items-center justify-between gap-2 border-b border-surface-border px-3 select-none pointer-coarse:h-10 [.share-card-content_&]:hidden">
          <span className="font-mono text-micro tracking-wide text-muted-foreground lowercase">
            mermaid
          </span>
          <div className="flex items-center gap-0.5">
            <IconButton
              label="放大查看"
              icon={<Maximize2 />}
              size="icon-xs"
              onClick={() => setExpanded(true)}
              className="text-muted-foreground pointer-coarse:size-10"
            />
            {copyButton}
          </div>
        </div>
        <div
          className="flex cursor-zoom-in justify-center overflow-x-auto p-4 [&>svg]:!h-auto [&>svg]:!max-w-full"
          data-swipe-back-ignore="true"
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
