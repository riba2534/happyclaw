// @vitest-environment happy-dom

import { act, Component, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));

import { preloadedComponent, preloadWhenIdle } from './preloaded-component';

const chunkError = () =>
  new TypeError('Failed to fetch dynamically imported module: /x.js');

function Panel({ label }: { label: string }) {
  return <p>{label}</p>;
}

function Dialog({ open }: { open: boolean; onClose: () => void }) {
  return open ? <p role="dialog">对话框</p> : null;
}

class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <p>boundary: {this.state.error.message}</p>
    ) : (
      this.props.children
    );
  }
}

let container: HTMLDivElement;
let root: Root;

async function render(node: ReactNode) {
  await act(async () => root.render(node));
  // Let the load promise settle and its state updates commit.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  toastError.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('preloadedComponent', () => {
  test('shows a retryable notice in place of a panel whose chunk failed', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(chunkError())
      .mockResolvedValueOnce({ default: Panel });
    const lazy = preloadedComponent(load, () => null);

    await render(<lazy.Component label="文件面板" />);
    expect(container.textContent).toContain('这部分内容加载失败');

    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '重试',
    )!;
    await act(async () => retry.click());
    await render(<lazy.Component label="文件面板" />);
    expect(load).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('文件面板');
  });

  test('closes a dialog whose chunk failed and loads it again on reopen', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(chunkError())
      .mockResolvedValueOnce({ default: Dialog });
    const lazy = preloadedComponent(load, () => null);
    const onClose = vi.fn();

    await render(<lazy.Component open onClose={onClose} />);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('');

    await render(<lazy.Component open={false} onClose={onClose} />);
    await render(<lazy.Component open onClose={onClose} />);
    expect(load).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  test('rethrows into the error boundary when asked to', async () => {
    const lazy = preloadedComponent(
      () => Promise.reject(chunkError()),
      () => null,
      { rethrow: true },
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await render(
      <Boundary>
        <lazy.Component />
      </Boundary>,
    );
    expect(container.textContent).toContain('boundary: Failed to fetch');
  });
});

describe('preloadWhenIdle', () => {
  test('swallows a failed preload so it is retried on first use', async () => {
    vi.useFakeTimers();
    const failing = vi.fn(() => Promise.reject(chunkError()));
    preloadWhenIdle(failing);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
