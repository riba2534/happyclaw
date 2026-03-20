import { useState } from 'react';
import { cn } from '@/lib/utils';

export interface EmojiPickerProps {
  value?: string;
  onChange: (emoji: string) => void;
}

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
      <div className="flex gap-1 overflow-x-auto pb-1">
        {EMOJI_CATEGORIES.map((cat, i) => (
          <button
            key={cat.label}
            type="button"
            onClick={() => setActiveCategory(i)}
            className={cn(
              'px-2.5 py-1 text-xs rounded-md whitespace-nowrap transition-colors cursor-pointer',
              activeCategory === i
                ? 'bg-brand-50 text-primary font-medium'
                : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Emoji grid */}
      <div className="grid grid-cols-8 gap-1 max-h-48 overflow-y-auto">
        {EMOJI_CATEGORIES[activeCategory].emojis.map((emoji, i) => (
          <button
            key={`${emoji}-${i}`}
            type="button"
            onClick={() => onChange(emoji)}
            className={cn(
              'w-8 h-8 flex items-center justify-center rounded-md text-lg hover:bg-muted transition-colors cursor-pointer',
              value === emoji && 'ring-2 ring-primary ring-offset-1 bg-brand-50',
            )}
          >
            {emoji}
          </button>
        ))}
      </div>

      {/* Custom input */}
      <div className="flex items-center gap-2 pt-1 border-t border-border">
        <input
          type="text"
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCustomSubmit()}
          placeholder="输入任意 emoji..."
          className="flex-1 px-2.5 py-1.5 text-sm border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
          maxLength={8}
        />
        <button
          type="button"
          onClick={handleCustomSubmit}
          disabled={!customInput.trim()}
          className="px-3 py-1.5 text-xs font-medium bg-brand-50 text-primary rounded-md hover:bg-brand-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
        >
          确认
        </button>
      </div>

      {/* Current selection indicator */}
      {value && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>当前选择：</span>
          <span className="text-lg">{value}</span>
        </div>
      )}
    </div>
  );
}
