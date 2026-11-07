import {
  createContext,
  memo,
  useCallback,
  useContext,
  useImperativeHandle,
  useRef,
  type ComponentProps,
} from 'react';
import { cn } from '@/lib/utils';
import { preloadedComponent } from '../../lib/preloaded-component';
import { useIsPhone } from '../layout/phone';
import type {
  MessageInput as EagerMessageInput,
  MessageInputHandle,
} from './MessageInput';

type MessageInputProps = ComponentProps<typeof EagerMessageInput>;

const FallbackLayout = createContext<{
  layout: MessageInputProps['layout'];
  statusBar: boolean;
}>({ layout: 'docked', statusBar: false });

/**
 * The composer's frame while the editor loads, in the size and place of the
 * real one so nothing moves when it arrives.
 */
function ComposerFallback() {
  const { layout, statusBar } = useContext(FallbackLayout);
  const centered = layout === 'centered';
  const dock = useIsPhone() && !centered;
  return (
    <div
      aria-hidden="true"
      data-composer-fallback
      className={cn(
        'relative w-full',
        dock
          ? 'absolute inset-x-0 bottom-0 z-20 pt-6'
          : !centered && 'bg-background pt-1 pb-3',
      )}
      style={
        centered
          ? undefined
          : {
              paddingBottom: dock
                ? 'max(calc(var(--safe-bottom, 0px) + 8px), calc(var(--keyboard-height, 0px) + 8px))'
                : 'max(0.75rem, var(--safe-bottom, 0px), var(--keyboard-height, 0px))',
            }
      }
    >
      <div className="mx-auto max-w-3xl px-4 lg:px-6">
        {statusBar && !centered && <div className="mb-1.5 h-8" />}
        <div
          className={cn(
            'border border-surface-border bg-surface-raised',
            dock
              ? 'min-h-[50px] rounded-[25px]'
              : centered
                ? 'min-h-[140px] rounded-[12px]'
                : 'min-h-[96px] rounded-[12px] sm:min-h-[118px]',
          )}
        />
      </div>
    </div>
  );
}

// The editor (Tiptap, ProseMirror and the cindy composer) is most of the chat
// page's code; it loads when a conversation first renders its composer, not
// with the page, so the phone's conversation list never parses it.
const lazyMessageInput = preloadedComponent(
  () => import('./MessageInput').then((m) => ({ default: m.MessageInput })),
  ComposerFallback,
);

/** Fetch the editor chunk ahead of opening a conversation. */
export const preloadMessageInput = lazyMessageInput.preload;

/**
 * What acceptDrop reads of a drop, taken while the event is dispatched: the
 * browser clears the DataTransfer afterwards, but entries and files stay
 * readable.
 */
function snapshotDrop(dataTransfer: DataTransfer): DataTransfer {
  const items = Array.from(dataTransfer.items).map((item) => {
    const entry = item.webkitGetAsEntry?.() ?? null;
    const file = item.getAsFile();
    return { webkitGetAsEntry: () => entry, getAsFile: () => file };
  });
  return { items } as unknown as DataTransfer;
}

export const MessageInput = memo(function LazyMessageInput({
  ref,
  ...props
}: MessageInputProps) {
  const LoadedOrFallback = lazyMessageInput.Component;
  const loaded = useRef<MessageInputHandle | null>(null);
  // Calls made before the editor arrived, replayed once it has.
  const pendingDrops = useRef<DataTransfer[]>([]);

  useImperativeHandle(
    ref,
    () => ({
      acceptDrop: (dataTransfer) => {
        if (loaded.current) loaded.current.acceptDrop(dataTransfer);
        else pendingDrops.current.push(snapshotDrop(dataTransfer));
      },
    }),
    [],
  );
  const attach = useCallback((handle: MessageInputHandle | null) => {
    loaded.current = handle;
    if (!handle) return;
    const drops = pendingDrops.current.splice(0);
    for (const drop of drops) handle.acceptDrop(drop);
  }, []);

  return (
    <FallbackLayout.Provider
      value={{ layout: props.layout, statusBar: !!props.statusBar }}
    >
      <LoadedOrFallback {...props} ref={attach} />
    </FallbackLayout.Provider>
  );
});
