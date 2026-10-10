import { lazy, Suspense, useRef } from 'react';
import { useConfirmStore } from '../../stores/confirm';

// The dialog stack only loads the first time something asks for confirmation,
// keeping AlertDialog out of the entry chunk.
const ConfirmDialog = lazy(() =>
  import('./ConfirmDialog').then((m) => ({ default: m.ConfirmDialog })),
);

/** Renders dialogs requested through confirmDialog(); mount once at the root. */
export function ConfirmHost() {
  const pending = useConfirmStore((s) => s.pending);
  const settle = useConfirmStore((s) => s.settle);
  // Keep the last request's copy while the dialog animates out.
  const lastRef = useRef(pending);
  if (pending) lastRef.current = pending;
  const shown = pending ?? lastRef.current;
  if (!shown) return null;

  return (
    <Suspense fallback={null}>
      <ConfirmDialog
        open={!!pending}
        onClose={() => settle(false)}
        onConfirm={() => settle(true)}
        title={shown.title}
        message={shown.message}
        confirmText={shown.confirmText}
        cancelText={shown.cancelText}
        confirmVariant={shown.variant}
      />
    </Suspense>
  );
}
