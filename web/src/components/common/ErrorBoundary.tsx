import { Component, ErrorInfo, ReactNode } from 'react';
import {
  isStaleChunkError,
  reloadForStaleChunk,
} from '../../utils/staleChunkReload';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
  resetKeys?: readonly unknown[];
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      '[ErrorBoundary] caught render error:',
      error,
      info.componentStack,
    );
    this.props.onError?.(error, info);
    if (isStaleChunkError(error)) reloadForStaleChunk();
  }

  componentDidUpdate(previousProps: ErrorBoundaryProps) {
    if (
      this.state.error &&
      resetKeysChanged(previousProps.resetKeys, this.props.resetKeys)
    ) {
      this.reset();
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div
        role="alert"
        className="my-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-4 text-sm text-destructive"
      >
        <p className="font-medium">这部分内容暂时无法显示</p>
        <p className="mt-1 break-words text-xs leading-5 opacity-80">
          {error.message || '发生了未知的页面渲染错误。'}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={this.reset}
            className="rounded-md border border-destructive/30 bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            重试渲染
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border border-destructive/30 bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            刷新页面
          </button>
        </div>
      </div>
    );
  }
}

function resetKeysChanged(
  previous: readonly unknown[] | undefined,
  current: readonly unknown[] | undefined,
): boolean {
  if (!previous || !current) return previous !== current;
  return (
    previous.length !== current.length ||
    previous.some((value, index) => !Object.is(value, current[index]))
  );
}
