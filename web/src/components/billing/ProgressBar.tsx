import { cn } from '@/lib/utils';

export function ProgressBar({
  value,
  max,
  className,
}: {
  value: number;
  max: number;
  className?: string;
}) {
  const percent = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const color =
    percent >= 90 ? 'bg-error' : percent >= 70 ? 'bg-warning' : 'bg-primary';
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      className={cn('h-1.5 overflow-hidden rounded-full bg-muted', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width]', color)}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
