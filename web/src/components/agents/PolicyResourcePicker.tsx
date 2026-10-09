import { Check, Loader2, Search } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface PolicyResourceOption {
  id: string;
  name: string;
  description?: string;
  sourceLabel?: string;
  unavailable?: boolean;
}

interface PolicyResourcePickerProps {
  label: string;
  options: PolicyResourceOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  emptyText: string;
}

export function PolicyResourcePicker({
  label,
  options,
  selectedIds,
  onChange,
  loading,
  error,
  disabled,
  emptyText,
}: PolicyResourcePickerProps) {
  const searchId = useId();
  const [query, setQuery] = useState('');
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter(
      (option) =>
        option.name.toLowerCase().includes(normalized) ||
        option.id.toLowerCase().includes(normalized) ||
        option.description?.toLowerCase().includes(normalized),
    );
  }, [options, query]);

  const toggle = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  };

  return (
    <div className={disabled ? 'opacity-60' : undefined}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label
          htmlFor={searchId}
          className="text-caption font-medium text-muted-foreground"
        >
          {label}
        </label>
        {!loading && !error && selectedIds.length > 0 && (
          <span
            aria-live="polite"
            className="inline-flex items-center gap-1 text-caption text-foreground"
          >
            <Check className="size-3 text-primary" />
            已选 {selectedIds.length}
          </span>
        )}
      </div>
      <div className="overflow-hidden rounded-lg bg-background ring-1 ring-surface-border">
        <div className="relative border-b border-surface-border">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint-foreground" />
          <Input
            id={searchId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称或 ID"
            disabled={disabled || loading}
            aria-label={`搜索${label}`}
            className="h-9 rounded-none border-0 bg-transparent pl-8 shadow-none focus-visible:ring-2 focus-visible:ring-inset dark:bg-transparent"
          />
        </div>
        <div className="max-h-[min(48vh,28rem)] overflow-y-auto p-1">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-caption text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              正在加载目录
            </div>
          ) : error ? (
            <div className="px-2 py-5 text-center text-caption text-error">
              {error}
            </div>
          ) : visible.length === 0 ? (
            <div className="px-2 py-5 text-center text-caption text-muted-foreground">
              {query ? '没有匹配项' : emptyText}
            </div>
          ) : (
            visible.map((option) => (
              <label
                key={option.id}
                className={cn(
                  'flex items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-100',
                  disabled
                    ? 'cursor-not-allowed'
                    : 'cursor-pointer hover:bg-surface-hover',
                )}
              >
                <Checkbox
                  checked={selected.has(option.id)}
                  onCheckedChange={() => toggle(option.id)}
                  disabled={disabled}
                  className="mt-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5 text-label text-foreground">
                    <span className="truncate">{option.name}</span>
                    {option.sourceLabel && (
                      <Badge variant="neutral">{option.sourceLabel}</Badge>
                    )}
                    {option.unavailable && (
                      <Badge variant="warning">当前不可用</Badge>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-micro text-faint-foreground">
                    {option.id}
                  </span>
                  {option.description && (
                    <span className="mt-0.5 line-clamp-2 block text-caption text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </span>
              </label>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
