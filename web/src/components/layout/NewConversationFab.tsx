import { SquarePen } from 'lucide-react';
import { useNewConversation } from '../../hooks/useNewConversation';
import { lightTap } from '../../hooks/useHaptic';

/**
 * The phone home's floating new-conversation button (cindy's 55pt circle on
 * the composer's resting line: 16px from the right, 8px above the home
 * indicator). It starts a conversation in the user's home workspace, never
 * a new workspace.
 */
export function NewConversationFab() {
  const { startNewConversation, creatingSession } = useNewConversation();

  // The home list has no workspace on screen: aim at the default one.
  const start = () => {
    lightTap();
    void startNewConversation({ target: 'home' });
  };

  return (
    <button
      type="button"
      aria-label="新对话"
      aria-busy={creatingSession || undefined}
      disabled={creatingSession}
      onClick={start}
      className="fixed right-[calc(env(safe-area-inset-right,0px)+1rem)] bottom-[calc(env(safe-area-inset-bottom,0px)+8px)] z-30 grid size-[55px] cursor-pointer place-items-center rounded-full bg-primary text-primary-foreground shadow-floating outline-none transition-transform duration-150 ease-snappy focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 active:scale-94 disabled:cursor-default disabled:opacity-70 motion-reduce:transition-none motion-reduce:active:scale-100"
    >
      <SquarePen className="size-6" aria-hidden="true" />
    </button>
  );
}
