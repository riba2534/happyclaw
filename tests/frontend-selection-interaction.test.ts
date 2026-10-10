import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

function componentSource(source: string, name: string, nextName: string) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('shared selection interaction states', () => {
  test('gives every Select trigger and option visible pointer feedback', () => {
    const source = read('web/src/components/ui/select.tsx');
    const trigger = componentSource(source, 'SelectTrigger', 'SelectContent');
    const item = componentSource(source, 'SelectItem', 'SelectSeparator');

    expect(trigger).toContain('hover:bg-foreground/[0.04]');
    expect(trigger).toContain('data-[state=open]:bg-foreground/[0.04]');
    expect(trigger).toContain('focus-visible:ring-3');

    expect(item).toContain('hover:bg-foreground/[0.06]');
    expect(item).toContain('focus:bg-foreground/[0.06]');
    expect(item).toContain('data-[highlighted]:bg-foreground/[0.06]');
    expect(item).toContain('active:bg-foreground/[0.1]');
    expect(item).toContain('data-disabled:cursor-not-allowed');
  });

  test.each([
    ['DropdownMenuItem', 'DropdownMenuCheckboxItem'],
    ['DropdownMenuCheckboxItem', 'DropdownMenuRadioGroup'],
    ['DropdownMenuRadioItem', 'DropdownMenuLabel'],
    ['DropdownMenuSubTrigger', 'DropdownMenuSubContent'],
  ])(
    '%s supports pointer, keyboard, and roving-focus selection',
    (name, next) => {
      const source = read('web/src/components/ui/dropdown-menu.tsx');
      const component = componentSource(source, name, next);

      // Neutral fills: --accent is brand-tinted in the teal scheme.
      expect(component).toContain('hover:bg-surface-hover');
      expect(component).toContain('focus:bg-surface-hover');
      expect(component).toContain('data-[highlighted]:bg-surface-hover');
    },
  );
});
