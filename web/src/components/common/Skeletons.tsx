import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';

/**
 * GroupsPage - 2x3 grid of skeleton cards
 */
export function SkeletonCardGrid() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="space-y-3">
            <Skeleton className="h-5 w-2/3 rounded" />
            <Skeleton className="h-4 w-full rounded" />
            <Skeleton className="h-4 w-4/5 rounded" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/**
 * MonitorPage - 3-column stat cards
 */
export function SkeletonStatCards() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="space-y-3">
            <Skeleton className="h-8 w-1/3 rounded" />
            <Skeleton className="h-4 w-1/2 rounded" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/**
 * TasksPage - vertical card list
 */
export function SkeletonCardList({
  count = 4,
  compact = false,
}: {
  count?: number;
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'space-y-2 px-2' : 'space-y-3'}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={
            compact
              ? 'rounded-lg border border-border bg-card p-3 space-y-2'
              : 'rounded-xl border border-border bg-card p-5 space-y-3'
          }
        >
          <div className="flex items-center gap-3">
            {!compact && <Skeleton className="h-9 w-9 rounded-full" />}
            <div className="flex-1 space-y-1.5">
              <Skeleton className={`${compact ? 'h-3.5' : 'h-4'} w-2/3 rounded`} />
              <Skeleton className={`${compact ? 'h-3' : 'h-3.5'} w-1/2 rounded`} />
            </div>
          </div>
          {!compact && <Skeleton className="h-4 w-full rounded" />}
        </div>
      ))}
    </div>
  );
}

/**
 * MonitorPage - table skeleton (header + 5 rows x 4 cols)
 */
export function SkeletonTable() {
  return (
    <Card className="overflow-hidden">
      {/* header */}
      <div className="grid grid-cols-4 gap-4 px-4 py-3 border-b border-border bg-muted">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-3/4 rounded" />
        ))}
      </div>
      {/* rows */}
      {Array.from({ length: 5 }).map((_, row) => (
        <div
          key={row}
          className="grid grid-cols-4 gap-4 px-4 py-3 border-b border-border last:border-b-0"
        >
          {Array.from({ length: 4 }).map((_, col) => (
            <Skeleton
              key={col}
              className={`h-4 rounded ${col === 0 ? 'w-5/6' : 'w-2/3'}`}
            />
          ))}
        </div>
      ))}
    </Card>
  );
}
