interface LoadErrorNoticeProps {
  title: string;
  message: string;
  /** Load the failed part again without reloading the page. */
  onRetry?: () => void;
}

// The outline Button look without the Button primitive: this notice is part
// of the entry chunk, and Button would pull class-variance-authority and
// tailwind-merge into it.
const buttonClass =
  'inline-flex h-8 items-center rounded-lg border border-border bg-background px-2.5 text-sm font-medium outline-none transition-colors hover:bg-surface-hover focus-visible:ring-3 focus-visible:ring-ring/50';

/** A part of the page that failed to load, with retry and reload actions. */
export function LoadErrorNotice({
  title,
  message,
  onRetry,
}: LoadErrorNoticeProps) {
  return (
    <div
      role="alert"
      className="m-3 rounded-xl bg-error/10 px-4 py-3 text-body ring-1 ring-error/20"
    >
      <p className="text-title-sm text-error">{title}</p>
      <p className="mt-1 text-caption leading-5 break-words text-muted-foreground">
        {message}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {onRetry && (
          <button type="button" className={buttonClass} onClick={onRetry}>
            重试
          </button>
        )}
        <button
          type="button"
          className={buttonClass}
          onClick={() => window.location.reload()}
        >
          刷新页面
        </button>
      </div>
    </div>
  );
}
