import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ColorPickerProps {
  value?: string;
  onChange: (color: string) => void;
}

const COLORS = [
  '#C96442', '#0ea5e9', '#6366f1', '#8b5cf6',
  '#ec4899', '#f43f5e', '#ef4444', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#64748b',
  '#1e293b', '#78716c', '#a855f7', '#3b82f6',
];

export function ColorPicker({ value, onChange }: ColorPickerProps) {
  return (
    <div className="grid grid-cols-8 gap-2 p-2">
      {COLORS.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          className={cn(
            'w-8 h-8 rounded-lg cursor-pointer flex items-center justify-center transition-transform hover:scale-110',
            value === color && 'outline-2 outline-primary outline-offset-2 outline',
          )}
          style={{ backgroundColor: color }}
        >
          {value === color && (
            <Check className="w-3.5 h-3.5 text-white drop-shadow-sm" />
          )}
        </button>
      ))}
    </div>
  );
}
