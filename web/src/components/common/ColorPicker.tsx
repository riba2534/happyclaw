import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ColorPickerProps {
  value?: string;
  onChange: (color: string) => void;
}

const COLORS = [
  '#0d9488',
  '#0ea5e9',
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#f43f5e',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#64748b',
];

export function ColorPicker({ value, onChange }: ColorPickerProps) {
  return (
    <div
      role="radiogroup"
      aria-label="背景色"
      className="grid w-fit grid-cols-6 gap-2"
    >
      {COLORS.map((color) => {
        const selected = value === color;
        return (
          <Button
            key={color}
            type="button"
            variant="ghost"
            size="icon"
            role="radio"
            aria-checked={selected}
            aria-label={`选择颜色 ${color}`}
            onClick={() => onChange(color)}
            className={cn(
              'rounded-full ring-offset-2 ring-offset-background hover:opacity-85 pointer-coarse:size-10',
              selected && 'ring-2 ring-foreground/40',
            )}
            style={{ backgroundColor: color }}
          >
            {selected && (
              <Check className="size-4 text-white" strokeWidth={2.5} />
            )}
          </Button>
        );
      })}
    </div>
  );
}
