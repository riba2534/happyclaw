import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ColorPickerProps {
  value?: string;
  onChange: (color: string) => void;
}

const COLORS = [
  '#0d9488', '#0ea5e9', '#6366f1', '#8b5cf6',
  '#ec4899', '#f43f5e', '#ef4444', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#64748b',
];

export function ColorPicker({ value, onChange }: ColorPickerProps) {
  return (
    <div className="grid grid-cols-6 gap-2">
      {COLORS.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          className={cn(
            'w-8 h-8 rounded-full cursor-pointer flex items-center justify-center transition-transform hover:scale-110',
            value === color && 'ring-2 ring-offset-2 ring-slate-400',
          )}
          style={{ backgroundColor: color }}
        >
          {value === color && (
            <Check className="w-4 h-4 text-white" />
          )}
        </button>
      ))}
    </div>
  );
}
