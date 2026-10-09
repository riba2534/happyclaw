import { create } from 'zustand';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** `danger` renders a destructive confirm button. */
  variant?: 'primary' | 'danger';
}

interface PendingConfirm extends ConfirmOptions {
  id: number;
  resolve: (confirmed: boolean) => void;
}

interface ConfirmState {
  pending: PendingConfirm | null;
  settle: (confirmed: boolean) => void;
}

let nextId = 1;

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  pending: null,
  settle: (confirmed) => {
    const pending = get().pending;
    if (!pending) return;
    set({ pending: null });
    pending.resolve(confirmed);
  },
}));

/**
 * Promise-based replacement for window.confirm(), rendered by <ConfirmHost/>.
 * A new request cancels any dialog that is still open.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const previous = useConfirmStore.getState().pending;
    previous?.resolve(false);
    useConfirmStore.setState({
      pending: { ...options, id: nextId++, resolve },
    });
  });
}
