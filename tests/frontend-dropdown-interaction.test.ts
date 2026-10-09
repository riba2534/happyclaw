import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const source = fs.readFileSync(
  path.join(process.cwd(), 'web/src/components/ui/dropdown-menu.tsx'),
  'utf8',
);

describe('dropdown menu interaction states', () => {
  test('shows the same selection feedback for hover and roving focus', () => {
    expect(source).toContain('hover:bg-accent');
    expect(source).toContain('data-[highlighted]:bg-accent');
    // Rows highlight with a flat fill only; elevation belongs to the menu
    // surface (shadow-menu), never to individual items.
    expect(source).not.toContain('shadow-md');
    expect(source).toContain('shadow-menu');
  });

  test('keeps destructive items visually destructive when selected', () => {
    expect(source).toContain(
      'data-[variant=destructive]:hover:bg-destructive/10',
    );
    expect(source).toContain(
      'data-[variant=destructive]:data-[highlighted]:bg-destructive/10',
    );
  });
});
