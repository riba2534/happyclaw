import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface EmojiPickerProps {
  value?: string;
  onChange: (emoji: string) => void;
}

// Hand-wrapped rows scan better than one emoji per line.
// prettier-ignore
const EMOJI_CATEGORIES: { label: string; emojis: string[] }[] = [
  {
    label: '动物',
    emojis: [
      '🐱','🐶','🐭','🐹','🐰','🦊','🐻','🐼',
      '🐻‍❄️','🐨','🐯','🦁','🐮','🐷','🐸','🐵',
      '🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤',
      '🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗',
      '🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞',
      '🐜','🪰','🪲','🪳','🦟','🦗','🕷️','🦂',
      '🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐',
      '🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋',
      '🦈','🐊','🐅','🐆','🦓','🦍','🦧','🐘',
      '🦛','🦏','🐪','🐫','🦒','🦘','🦬','🐃',
      '🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐',
      '🦌','🐕','🐩','🦮','🐕‍🦺','🐈','🐈‍⬛','🪶',
      '🐓','🦃','🦤','🦚','🦜','🦢','🦩','🕊️',
      '🐇','🦝','🦨','🦡','🦫','🦦','🦥','🐁',
      '🐀','🐿️','🦔','🐾','🐉','🐲','🦠',
    ],
  },
  {
    label: '表情',
    emojis: [
      '😀','😃','😄','😁','😆','😅','🤣','😂',
      '🙂','😉','😊','😇','🥰','😍','🤩','😘',
      '😎','🤓','🧐','🤔','🤗','🤭','😈','👻',
      '💀','🤖','👽','👾','🎃','😺','😸','😻',
    ],
  },
  {
    label: '自然',
    emojis: [
      '🌸','🌺','🌻','🌹','🌷','🌼','💐','🪻',
      '🌿','🍀','🍁','🍂','🍃','🪴','🌵','🌲',
      '🌳','🌴','🌱','🌾','☘️','🪹','🪺','🍄',
      '🌍','🌎','🌏','🌈','☀️','🌤️','⛅','🌙',
      '⭐','🌟','💫','✨','☄️','🔥','💧','🌊',
      '❄️','🌪️','🌈',
    ],
  },
  {
    label: '食物',
    emojis: [
      '🍎','🍊','🍋','🍇','🍓','🫐','🍑','🍒',
      '🥝','🍌','🥑','🍕','🍔','🌮','🍣','🍩',
      '🎂','🧁','🍫','🍭','🍬','☕','🧋','🍵',
    ],
  },
  {
    label: '物品',
    emojis: [
      '💎','🔮','🪄','🎯','🎨','🎭','🎪','🎬',
      '🎵','🎸','🎹','🥁','🎺','🎻','🎮','🕹️',
      '🎲','🧩','🎰','📚','💻','📱','⌨️','🖥️',
      '💡','🔦','🏮','🕯️','🧲','🔧','⚙️','🛠️',
      '🚀','🛸','✈️','🚁','🏎️','🚂','⛵','🎈',
      '🎁','🏆','🥇','🎖️','👑','💍','🧸','🪅',
    ],
  },
  {
    label: '符号',
    emojis: [
      '❤️','🧡','💛','💚','💙','💜','🖤','🤍',
      '💔','❣️','💕','💞','💓','💗','💖','💘',
      '💝','☮️','✝️','☯️','♾️','🔱','⚡','💥',
      '💢','💦','💨','🕳️','🫧','🎵','🎶','✅',
      '❌','⭕','💯','🔴','🟠','🟡','🟢','🔵','🟣',
    ],
  },
];

export function EmojiPicker({ value, onChange }: EmojiPickerProps) {
  const [activeCategory, setActiveCategory] = useState(0);
  const [customInput, setCustomInput] = useState('');

  const handleCustomSubmit = () => {
    const trimmed = customInput.trim();
    if (trimmed) {
      onChange(trimmed);
      setCustomInput('');
    }
  };

  return (
    <div className="space-y-3">
      {/* Category tabs */}
      <div className="flex gap-0.5 overflow-x-auto">
        {EMOJI_CATEGORIES.map((cat, i) => (
          <Button
            key={cat.label}
            type="button"
            variant="ghost"
            size="xs"
            aria-pressed={activeCategory === i}
            onClick={() => setActiveCategory(i)}
            className={cn(
              'px-2 text-caption',
              activeCategory === i
                ? 'bg-surface-selected text-foreground'
                : 'text-muted-foreground',
            )}
          >
            {cat.label}
          </Button>
        ))}
      </div>

      {/* Emoji grid */}
      <div className="grid max-h-48 grid-cols-8 gap-1 overflow-y-auto p-1">
        {EMOJI_CATEGORIES[activeCategory].emojis.map((emoji, i) => (
          <Button
            key={`${emoji}-${i}`}
            type="button"
            variant="ghost"
            size="icon"
            aria-pressed={value === emoji}
            onClick={() => onChange(emoji)}
            className={cn(
              'text-title-lg font-normal',
              value === emoji && 'bg-surface-selected ring-1 ring-primary',
            )}
          >
            {emoji}
          </Button>
        ))}
      </div>

      {/* Custom input */}
      <div className="flex items-center gap-2 border-t border-surface-border pt-3">
        <Input
          type="text"
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCustomSubmit()}
          placeholder="输入任意 emoji..."
          aria-label="自定义 emoji"
          className="flex-1"
          maxLength={8}
        />
        <Button
          type="button"
          variant="outline"
          onClick={handleCustomSubmit}
          disabled={!customInput.trim()}
        >
          确认
        </Button>
      </div>

      {/* Current selection indicator */}
      {value && (
        <div className="flex items-center gap-2 text-caption text-muted-foreground">
          <span>当前选择：</span>
          <span className="text-title">{value}</span>
        </div>
      )}
    </div>
  );
}
