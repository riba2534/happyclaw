import type * as React from 'react';
import { useTheme } from '@/hooks/useTheme';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from 'lucide-react';

// Sonner's own defaults (24px, 16px under 600px wide) plus the safe area, so
// toasts clear the notch and home indicator; bottom toasts also ride above
// the software keyboard. env() is 0 on desktop, which keeps it unchanged.
const safeOffset = (gap: number) => ({
  top: `calc(env(safe-area-inset-top, 0px) + ${gap}px)`,
  right: `calc(env(safe-area-inset-right, 0px) + ${gap}px)`,
  bottom: `calc(var(--safe-bottom, 0px) + var(--keyboard-inset, 0px) + ${gap}px)`,
  left: `calc(env(safe-area-inset-left, 0px) + ${gap}px)`,
});
const OFFSET = safeOffset(24);
const MOBILE_OFFSET = safeOffset(16);

// Neutral toast surface; only the leading icon carries the status color, so
// stacked notifications do not flood the screen with tinted blocks.
const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme();

  return (
    <Sonner
      theme={resolvedTheme as ToasterProps['theme']}
      offset={OFFSET}
      mobileOffset={MOBILE_OFFSET}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4 text-success" />,
        info: <InfoIcon className="size-4 text-muted-foreground" />,
        warning: <TriangleAlertIcon className="size-4 text-warning" />,
        error: <OctagonXIcon className="size-4 text-error" />,
        loading: (
          <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        ),
      }}
      style={
        {
          '--normal-bg': 'var(--surface-raised)',
          '--normal-text': 'var(--foreground)',
          '--normal-border': 'var(--surface-border)',
          '--border-radius': 'calc(var(--radius) + 2px)',
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: 'cn-toast shadow-menu! text-body! gap-2.5!',
          description: 'text-muted-foreground! text-caption!',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
