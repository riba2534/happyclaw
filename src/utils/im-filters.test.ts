import { describe, it, expect } from 'vitest';
import { stripImTags } from './im-filters.js';

describe('stripImTags', () => {
  // ── <internal> tag ──────────────────────────────────────────────────

  it('strips a single <internal> block', () => {
    const input = 'Hello <internal>secret reasoning</internal> World';
    expect(stripImTags(input)).toBe('Hello  World');
  });

  it('strips multiple <internal> blocks', () => {
    const input =
      '<internal>first</internal> visible <internal>second</internal>';
    expect(stripImTags(input)).toBe('visible');
  });

  it('strips multi-line <internal> content', () => {
    const input = 'Before\n<internal>\nline1\nline2\n</internal>\nAfter';
    expect(stripImTags(input)).toBe('Before\n\nAfter');
  });

  // ── <process> tag ────────────────────────────────────────────────────

  it('strips a single <process> block', () => {
    const input = 'Start <process>tool trace…</process> End';
    expect(stripImTags(input)).toBe('Start  End');
  });

  it('strips multi-line <process> content', () => {
    const input = '<process>\nRunning tool\nOutput: ok\n</process>\nDone';
    expect(stripImTags(input)).toBe('Done');
  });

  // ── mixed tags ───────────────────────────────────────────────────────

  it('strips both tag types in one pass', () => {
    const input =
      '<internal>think</internal>answer<process>trace</process>';
    expect(stripImTags(input)).toBe('answer');
  });

  it('handles interleaved tags correctly', () => {
    const input =
      'A<internal>i</internal>B<process>p</process>C';
    expect(stripImTags(input)).toBe('ABC');
  });

  // ── edge cases ───────────────────────────────────────────────────────

  it('returns the original text when no tags are present', () => {
    const input = 'plain text without any tags';
    expect(stripImTags(input)).toBe(input);
  });

  it('returns empty string when all content is inside tags', () => {
    const input = '<internal>everything</internal>';
    expect(stripImTags(input)).toBe('');
  });

  it('trims surrounding whitespace after stripping', () => {
    const input = '  <internal>x</internal>  ';
    expect(stripImTags(input)).toBe('');
  });

  it('handles empty string input', () => {
    expect(stripImTags('')).toBe('');
  });

  it('does not strip partial / unclosed tags', () => {
    // An unclosed tag should be left as-is — we don't want to eat content
    // accidentally if an agent emits a malformed tag.
    const input = '<internal>not closed';
    expect(stripImTags(input)).toBe('<internal>not closed');
  });
});
