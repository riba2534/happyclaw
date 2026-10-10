import type { Key, ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
  headerClassName?: string;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => Key;
  loading?: boolean;
  /** Skeleton row count while loading with no rows yet. */
  skeletonRows?: number;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  className?: string;
  /** Render inside a rounded bordered surface (default) or bare. */
  framed?: boolean;
}

const alignClass = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
} as const;

/** Column-driven table on the shared table primitive. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  skeletonRows = 5,
  empty,
  onRowClick,
  rowClassName,
  className,
  framed = true,
}: DataTableProps<T>) {
  const showSkeleton = loading && rows.length === 0;
  const showEmpty = !loading && rows.length === 0 && empty;

  return (
    <div
      data-slot="data-table"
      aria-busy={loading || undefined}
      className={cn(
        framed &&
          'overflow-hidden rounded-xl bg-surface-raised ring-1 ring-surface-border',
        className,
      )}
    >
      <Table>
        <TableHeader className={cn(framed && 'bg-muted/40')}>
          <TableRow>
            {columns.map((column) => (
              <TableHead
                key={column.key}
                className={cn(
                  alignClass[column.align ?? 'left'],
                  column.headerClassName,
                )}
              >
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {showSkeleton &&
            Array.from({ length: skeletonRows }, (_, index) => (
              <TableRow key={`skeleton-${index}`}>
                {columns.map((column) => (
                  <TableCell key={column.key}>
                    <Skeleton className="h-4 w-full max-w-32" />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          {rows.map((row, index) => (
            <TableRow
              key={rowKey(row, index)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                onRowClick && 'cursor-pointer',
                rowClassName?.(row),
              )}
            >
              {columns.map((column) => (
                <TableCell
                  key={column.key}
                  className={cn(
                    alignClass[column.align ?? 'left'],
                    column.className,
                  )}
                >
                  {column.cell(row, index)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {showEmpty && (
        <div className="border-t border-surface-border">{empty}</div>
      )}
    </div>
  );
}
