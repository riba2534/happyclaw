import { create } from 'zustand';

/** One option of a confirm dialog that asks how, not only whether. */
export interface ConfirmChoice {
  value: string;
  label: string;
  description?: string;
  /** Picking it turns the confirm button destructive and relabels it. */
  dangerConfirmText?: string;
}

/** A dropdown a confirm dialog asks to pick from; see confirmSelectDialog(). */
export interface ConfirmSelect {
  label: string;
  options: Array<{ value: string; label: string }>;
  defaultValue: string;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** `danger` renders a destructive confirm button. */
  variant?: 'primary' | 'danger';
  /** Radio options shown under the message; see confirmChoiceDialog(). */
  choices?: ConfirmChoice[];
  defaultChoice?: string;
  /** A dropdown shown under the message instead of radio options. */
  select?: ConfirmSelect;
}

interface PendingConfirm extends ConfirmOptions {
  id: number;
  resolve: (confirmed: boolean, choice?: string) => void;
}

interface ConfirmState {
  pending: PendingConfirm | null;
  settle: (confirmed: boolean, choice?: string) => void;
}

let nextId = 1;

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  pending: null,
  settle: (confirmed, choice) => {
    const pending = get().pending;
    if (!pending) return;
    set({ pending: null });
    pending.resolve(confirmed, choice);
  },
}));

function request(
  options: ConfirmOptions,
  resolve: PendingConfirm['resolve'],
): void {
  const previous = useConfirmStore.getState().pending;
  previous?.resolve(false);
  useConfirmStore.setState({
    pending: { ...options, id: nextId++, resolve },
  });
}

/**
 * Promise-based replacement for window.confirm(), rendered by <ConfirmHost/>.
 * A new request cancels any dialog that is still open.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => request(options, resolve));
}

/**
 * confirmDialog() with a dropdown under the message: resolves the picked
 * value, or null when cancelled.
 */
export function confirmSelectDialog(
  options: Omit<ConfirmOptions, 'choices' | 'defaultChoice' | 'select'> & {
    select: ConfirmSelect;
  },
): Promise<string | null> {
  return new Promise((resolve) =>
    request(
      { ...options, defaultChoice: options.select.defaultValue },
      (confirmed, choice) => resolve(confirmed ? (choice ?? '') : null),
    ),
  );
}

/**
 * confirmDialog() that also asks the user to pick one of `choices`: resolves
 * the chosen value, or null when cancelled.
 */
export function confirmChoiceDialog<V extends string>(
  options: Omit<ConfirmOptions, 'choices' | 'defaultChoice'> & {
    choices: (ConfirmChoice & { value: V })[];
    defaultChoice: V;
  },
): Promise<V | null> {
  return new Promise((resolve) =>
    request(options, (confirmed, choice) =>
      resolve(confirmed ? ((choice as V) ?? options.defaultChoice) : null),
    ),
  );
}
