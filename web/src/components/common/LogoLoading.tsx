import { APP_BASE } from '../../utils/url';

interface LogoLoadingProps {
  /** Show full animated logo with wordmark */
  full?: boolean;
  /** Size of the icon-only variant (default 64) */
  size?: number;
  /** Optional label below the logo */
  label?: string;
}

/**
 * Animated loading screen with the HappyClaw logo.
 * - `full` mode: shows the complete animated wordmark SVG via <object> so currentColor inherits from CSS
 * - default: shows the icon with a subtle pulse animation
 */
export function LogoLoading({ full, size = 64, label }: LogoLoadingProps) {
  if (full) {
    return (
      <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center">
        <object
          data={`${APP_BASE}icons/loading-logo.svg`}
          type="image/svg+xml"
          aria-label="HappyClaw"
          className="w-[min(80vw,500px)] h-auto"
          style={{ color: 'var(--foreground)' }}
        />
        {label && <p className="mt-6 text-sm text-muted-foreground">{label}</p>}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
      <img
        src={`${APP_BASE}icons/icon-192.png`}
        alt="HappyClaw"
        className="animate-pulse rounded-2xl"
        style={{ width: size, height: size }}
      />
      {label && <p className="text-sm text-muted-foreground">{label}</p>}
    </div>
  );
}
