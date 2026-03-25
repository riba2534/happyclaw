export function ProgressBar({ value, max, className }: { value: number; max: number; className?: string }) {
  const percent = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const color = percent >= 90 ? 'bg-red-500' : percent >= 70 ? 'bg-yellow-500' : 'bg-brand-500';
  return (
    <div className={`h-2 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden ${className ?? ''}`}>
      <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${percent}%` }} />
    </div>
  );
}
