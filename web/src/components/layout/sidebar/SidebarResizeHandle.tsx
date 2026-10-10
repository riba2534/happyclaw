import {
  useRef,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  useShellStore,
} from '../../../stores/shell';

/** Dragging below this collapses the sidebar to its icon rail. */
const COLLAPSE_THRESHOLD = 160;
const KEYBOARD_STEP = 16;

/**
 * Drag handle on the sidebar's right edge. While dragging it writes the
 * width straight to the CSS variable (no React render per pointer move) and
 * commits to the store on release. Double-click restores the default width.
 */
export function SidebarResizeHandle({
  targetRef,
}: {
  targetRef: RefObject<HTMLElement | null>;
}) {
  const width = useShellStore((s) => s.sidebarWidth);
  const collapsed = useShellStore((s) => s.sidebarCollapsed);
  const setSidebarWidth = useShellStore((s) => s.setSidebarWidth);
  const setSidebarCollapsed = useShellStore((s) => s.setSidebarCollapsed);
  const drag = useRef<{ startX: number; startWidth: number; last: number }>(
    null,
  );

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startWidth = collapsed ? COLLAPSE_THRESHOLD : width;
    drag.current = { startX: event.clientX, startWidth, last: startWidth };
    targetRef.current?.setAttribute('data-resizing', 'true');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    const target = targetRef.current;
    if (!state || !target) return;
    const raw = state.startWidth + event.clientX - state.startX;
    state.last = raw;
    if (raw < COLLAPSE_THRESHOLD) {
      target.setAttribute('data-collapsed', 'true');
    } else {
      target.removeAttribute('data-collapsed');
      target.style.setProperty(
        '--sidebar-width',
        `${clampSidebarWidth(raw)}px`,
      );
    }
  };

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    targetRef.current?.removeAttribute('data-resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (state.last < COLLAPSE_THRESHOLD) {
      setSidebarCollapsed(true);
    } else {
      setSidebarCollapsed(false);
      setSidebarWidth(state.last);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = event.key === 'ArrowLeft' ? -KEYBOARD_STEP : KEYBOARD_STEP;
      setSidebarCollapsed(false);
      setSidebarWidth(width + delta);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      setSidebarCollapsed(!collapsed);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧边栏宽度"
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuenow={collapsed ? SIDEBAR_MIN_WIDTH : width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={() => {
        setSidebarCollapsed(false);
        setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
      }}
      onKeyDown={onKeyDown}
      className="group/resize absolute inset-y-0 -right-1.5 z-20 w-3 cursor-col-resize outline-none"
    >
      <span className="absolute inset-y-3 left-1/2 w-px -translate-x-1/2 rounded-full bg-transparent transition-colors duration-150 group-hover/resize:bg-foreground/15 group-focus-visible/resize:bg-ring group-active/resize:bg-foreground/25" />
    </div>
  );
}
