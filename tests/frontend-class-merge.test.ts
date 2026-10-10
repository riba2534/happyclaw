import { describe, expect, test } from 'vitest';
import { cn } from '../web/src/lib/utils';

describe('cn() with design-system tokens', () => {
  test('keeps role-based font sizes next to text colors', () => {
    expect(cn('text-body text-muted-foreground')).toBe(
      'text-body text-muted-foreground',
    );
    expect(cn('text-caption', 'text-foreground')).toBe(
      'text-caption text-foreground',
    );
  });

  test('still resolves conflicts within the same group', () => {
    expect(cn('text-body', 'text-caption')).toBe('text-caption');
    expect(cn('text-sm', 'text-title')).toBe('text-title');
    expect(cn('shadow-md', 'shadow-menu')).toBe('shadow-menu');
  });
});
