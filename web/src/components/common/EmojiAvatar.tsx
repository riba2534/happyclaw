import { cn } from '@/lib/utils';

export interface EmojiAvatarProps {
  emoji?: string | null;
  color?: string | null;
  fallbackChar?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeClasses = {
  sm: 'w-6 h-6 text-sm',
  md: 'w-8 h-8 text-base',
  lg: 'w-10 h-10 text-lg',
} as const;

const fallbackTextClasses = {
  sm: 'text-[10px]',
  md: 'text-xs',
  lg: 'text-sm',
} as const;

export function EmojiAvatar({
  emoji,
  color,
  fallbackChar,
  size = 'md',
  className,
}: EmojiAvatarProps) {
  const base = cn(
    'rounded-full flex items-center justify-center flex-shrink-0',
    sizeClasses[size],
    className,
  );

  if (emoji) {
    return (
      <div
        className={base}
        style={{ backgroundColor: color || '#0d9488' }}
      >
        <span>{emoji}</span>
      </div>
    );
  }

  const letter = (fallbackChar || '?')[0].toUpperCase();

  return (
    <div className={cn(base, 'bg-brand-100')}>
      <span className={cn('font-medium text-brand-600', fallbackTextClasses[size])}>
        {letter}
      </span>
    </div>
  );
}
