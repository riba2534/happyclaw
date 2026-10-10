import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge the custom @theme tokens from globals.css. Without
// this, `text-body` looks like a text color and gets dropped when merged
// with `text-muted-foreground` (same for `shadow-menu` vs `shadow-sm`).
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        'micro',
        'caption',
        'label',
        'body',
        'body-lg',
        'title-sm',
        'title',
        'title-lg',
        'display-sm',
        'display',
      ],
      shadow: ['card', 'canvas', 'menu', 'floating'],
      ease: ['snappy'],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
