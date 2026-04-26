import { forwardRef, useMemo } from 'react';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { MarkdownRenderer } from './MarkdownRenderer';

interface ShareCardRendererProps {
  content: string;
  senderName: string;
  timestamp: string;
  groupJid?: string;
  aiEmoji?: string | null;
  aiColor?: string | null;
  aiImageUrl?: string | null;
}

/**
 * Fixed light-theme base variables (background, foreground, muted, etc.).
 * These do NOT change with the user's color scheme.
 */
const LIGHT_BASE_VARS: Record<string, string> = {
  '--background': '#ffffff',
  '--foreground': '#0f172a',
  '--card': '#ffffff',
  '--card-foreground': '#0f172a',
  '--popover': '#ffffff',
  '--popover-foreground': '#0f172a',
  '--primary-foreground': '#ffffff',
  '--secondary': '#f5f5f5',
  '--secondary-foreground': '#171717',
  '--muted': '#f5f5f5',
  '--muted-foreground': '#737373',
  '--accent': '#f5f5f5',
  '--accent-foreground': '#171717',
  '--destructive': '#dc2626',
  '--destructive-foreground': '#ffffff',
  '--border': '#e5e5e5',
  '--input': '#e5e5e5',
  '--ring': '#a3a3a3',
};

/** Default brand fallbacks (classic orange) in case CSS vars are unavailable. */
const BRAND_DEFAULTS: Record<string, string> = {
  '--brand-50': '#fff7ed',
  '--brand-100': '#ffedd5',
  '--brand-200': '#fed7aa',
  '--brand-300': '#fdba74',
  '--brand-400': '#fb923c',
  '--brand-500': '#f97316',
  '--brand-600': '#ea580c',
  '--brand-700': '#c2410c',
};

/**
 * Read current brand/primary colors from the live CSS custom properties.
 * Falls back to orange defaults when a variable is missing.
 */
function getCurrentBrandVars(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const get = (key: string) => style.getPropertyValue(key).trim();

  const brand: Record<string, string> = {};
  for (const [key, fallback] of Object.entries(BRAND_DEFAULTS)) {
    brand[key] = get(key) || fallback;
  }
  brand['--primary'] = get('--brand-500') || BRAND_DEFAULTS['--brand-500'];
  return brand;
}

const MAX_HEIGHT = 20000;
export const SHARE_CARD_DEFAULT_WIDTH = 720;
export const SHARE_CARD_MAX_WIDTH = 1200;
export const SHARE_CARD_PADDING = 48; // 24px * 2

/**
 * Override styles for the share card content area.
 * Tables are allowed to expand the card width (up to MAX_WIDTH).
 * Non-table content wraps at whatever the current card width is.
 */
const CONTENT_OVERRIDE_STYLE = `
  .share-card-content {
    overflow-wrap: break-word !important;
    word-break: break-word !important;
  }
  .share-card-content th,
  .share-card-content td {
    white-space: normal !important;
    word-break: break-word !important;
  }
  .share-card-content pre {
    white-space: pre-wrap !important;
    word-break: break-all !important;
  }
  .share-card-content code {
    word-break: break-all !important;
  }
  .share-card-content .overflow-x-auto {
    overflow: visible !important;
  }
`;

export const ShareCardRenderer = forwardRef<HTMLDivElement, ShareCardRendererProps>(
  function ShareCardRenderer(
    { content, senderName, timestamp, groupJid, aiEmoji, aiColor, aiImageUrl },
    ref,
  ) {
    // Merge fixed light-mode base vars with dynamic brand colors from current theme
    const themeVars = useMemo<React.CSSProperties>(() => {
      const brandVars = getCurrentBrandVars();
      return { ...LIGHT_BASE_VARS, ...brandVars } as React.CSSProperties;
    }, []);

    return (
      <div
        ref={ref}
        style={{
          ...themeVars,
          minWidth: SHARE_CARD_DEFAULT_WIDTH,
          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          background: '#ffffff',
          color: '#0f172a',
          borderRadius: 16,
          WebkitFontSmoothing: 'antialiased',
        }}
      >
        <style>{CONTENT_OVERRIDE_STYLE}</style>

        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 24px',
            borderBottom: '1px solid #e2e8f0',
            background: '#f8fafc',
            borderRadius: '16px 16px 0 0',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <EmojiAvatar
              imageUrl={aiImageUrl}
              emoji={aiEmoji}
              color={aiColor}
              fallbackChar={senderName[0]}
              size="md"
            />
            <span style={{ fontSize: 15, fontWeight: 600, color: '#0f172a' }}>{senderName}</span>
          </div>
          <span style={{ fontSize: 13, color: '#64748b', whiteSpace: 'nowrap', marginLeft: 16 }}>{timestamp}</span>
        </div>

        {/* Content */}
        <div
          style={{
            padding: '20px 24px',
            maxHeight: MAX_HEIGHT,
            position: 'relative',
          }}
        >
          <div className="share-card-content max-w-none">
            <MarkdownRenderer content={content} groupJid={groupJid} variant="chat" eagerImages />
          </div>
          {/* Gradient fade for extremely long content */}
          {content.length > 30000 && (
            <div
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: 80,
                background: 'linear-gradient(transparent, #ffffff)',
                pointerEvents: 'none',
              }}
            />
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '12px 24px',
            gap: '6px',
            borderTop: '1px solid #e2e8f0',
            background: '#f8fafc',
            borderRadius: '0 0 16px 16px',
          }}
        >
          <img
            src="/icons/icon-192.png"
            alt="HappyClaw"
            style={{ width: 16, height: 16, borderRadius: 3 }}
          />
          <span style={{ fontSize: 12, color: '#94a3b8' }}>
            HappyClaw · github.com/riba2534/happyclaw
          </span>
        </div>
      </div>
    );
  },
);
