import { lazy, Suspense, useEffect, useRef } from 'react';
import { useShellStore } from '../../stores/shell';
import { SHORTCUTS, useShortcut } from '@/lib/shortcuts';

const loadPalette = () => import('./CommandPalette');
const CommandPalette = lazy(() =>
  loadPalette().then((m) => ({ default: m.CommandPalette })),
);

/** Binds ⌘K globally and loads the palette (cmdk) on first use. */
export function CommandPaletteHost() {
  const open = useShellStore((s) => s.paletteOpen);
  const setOpen = useShellStore((s) => s.setPaletteOpen);
  const loadedRef = useRef(false);
  if (open) loadedRef.current = true;

  // Warm the chunk once the app is idle so the first ⌘K opens instantly.
  useEffect(() => {
    const idle =
      window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1500));
    const handle = idle(() => void loadPalette());
    return () => {
      if (window.cancelIdleCallback) window.cancelIdleCallback(handle);
      else clearTimeout(handle);
    };
  }, []);

  useShortcut(SHORTCUTS.commandPalette, () =>
    setOpen(!useShellStore.getState().paletteOpen),
  );

  if (!loadedRef.current) return null;
  return (
    <Suspense fallback={null}>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </Suspense>
  );
}
