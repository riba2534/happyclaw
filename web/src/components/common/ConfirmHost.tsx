import { lazy, Suspense, useRef, useState } from 'react';
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
  // The pick for the request on screen; each request starts at its default.
  const [choice, setChoice] = useState<{ id: number; value: string } | null>(
    null,
  );
  if (!shown) return null;

  const selected =
    choice?.id === shown.id ? choice.value : (shown.defaultChoice ?? '');
  const dangerText = shown.choices?.find(
    (item) => item.value === selected,
  )?.dangerConfirmText;

  return (
    <Suspense fallback={null}>
      <ConfirmDialog
        open={!!pending}
        onClose={() => settle(false)}
        onConfirm={() =>
          settle(true, shown.choices || shown.select ? selected : undefined)
        }
        title={shown.title}
        message={shown.message}
        confirmText={dangerText ?? shown.confirmText}
        cancelText={shown.cancelText}
        confirmVariant={dangerText ? 'danger' : shown.variant}
        choices={shown.choices}
        select={shown.select}
        choice={selected}
        onChoiceChange={(value) => setChoice({ id: shown.id, value })}
      />
    </Suspense>
  );
}
