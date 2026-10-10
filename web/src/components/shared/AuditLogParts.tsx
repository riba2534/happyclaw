import { Braces, ChevronLeft, ChevronRight, ChevronsLeft } from 'lucide-react';
import { IconButton } from '@/components/common';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

/** `{}` trigger that shows an audit entry's JSON details in a popover. */
export function AuditDetailsPopover({
  details,
  open,
  onOpenChange,
}: {
  details: unknown;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <IconButton
          label="查看详情"
          icon={<Braces />}
          className="text-muted-foreground"
        />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)] p-0">
        <pre className="max-h-64 overflow-auto p-3 font-mono text-caption whitespace-pre-wrap text-muted-foreground">
          {JSON.stringify(details, null, 2)}
        </pre>
      </PopoverContent>
    </Popover>
  );
}

/**
 * First / previous / next pager for the audit log tables. Without a known
 * total it shows the page number and relies on `hasNext`.
 */
export function AuditPagination({
  page,
  totalPages,
  hasNext,
  onPageChange,
  disabled = false,
}: {
  page: number;
  totalPages?: number;
  hasNext: boolean;
  onPageChange: (page: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-end gap-1">
      <IconButton
        label="第一页"
        variant="outline"
        icon={<ChevronsLeft />}
        onClick={() => onPageChange(0)}
        disabled={disabled || page === 0}
      />
      <IconButton
        label="上一页"
        variant="outline"
        icon={<ChevronLeft />}
        onClick={() => onPageChange(Math.max(0, page - 1))}
        disabled={disabled || page === 0}
      />
      <span className="min-w-16 text-center text-caption text-muted-foreground tabular-nums">
        {totalPages ? `${page + 1} / ${totalPages}` : `第 ${page + 1} 页`}
      </span>
      <IconButton
        label="下一页"
        variant="outline"
        icon={<ChevronRight />}
        onClick={() => onPageChange(page + 1)}
        disabled={disabled || !hasNext}
      />
    </div>
  );
}
