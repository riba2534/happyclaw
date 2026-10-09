import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

export interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  label?: string;
  fullPage?: boolean;
  className?: string;
}

const sizeMap = {
  sm: 'size-4',
  md: 'size-5',
  lg: 'size-6',
} as const;

export function LoadingSpinner({
  size = 'md',
  label,
  fullPage = false,
  className,
}: LoadingSpinnerProps) {
  const content = (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2',
        className,
      )}
    >
      <Spinner className={cn('text-muted-foreground', sizeMap[size])} />
      {label && <p className="text-caption text-muted-foreground">{label}</p>}
    </div>
  );

  if (fullPage) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        {content}
      </div>
    );
  }

  return content;
}
