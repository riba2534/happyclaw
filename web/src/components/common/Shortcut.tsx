import { useMemo } from 'react';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { formatKeys, isMacPlatform } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';

export interface ShortcutProps {
  /** Portable shortcut such as `mod+k` (see lib/shortcuts.ts). */
  keys: string;
  className?: string;
}

/** Keycap rendering of a shortcut: ⌘ ⇧ K on macOS, Ctrl Shift K elsewhere. */
export function Shortcut({ keys, className }: ShortcutProps) {
  const caps = useMemo(() => formatKeys(keys, isMacPlatform()), [keys]);
  return (
    <KbdGroup className={cn('shrink-0', className)} aria-hidden="true">
      {caps.map((cap, index) => (
        <Kbd key={`${cap}-${index}`}>{cap}</Kbd>
      ))}
    </KbdGroup>
  );
}
