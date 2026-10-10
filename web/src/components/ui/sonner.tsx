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

// Neutral toast surface; only the leading icon carries the status color, so
// stacked notifications do not flood the screen with tinted blocks.
const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme();

  return (
    <Sonner
      theme={resolvedTheme as ToasterProps['theme']}
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
