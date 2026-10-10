import { describe, expect, test } from 'vitest';
import { markdownToPlainText } from './markdown-plain-text';

describe('markdownToPlainText', () => {
  test('copies code verbatim instead of stripping Markdown inside it', () => {
    const md = [
      'Call it like this:',
      '',
      '```python',
      '# comment stays',
      'def f(*args, **kwargs):',
      '    return a * b * c',
      '```',
      '',
      '```yaml',
      '- name: keep the dash',
      '```',
    ].join('\n');
    expect(markdownToPlainText(md)).toBe(
      [
        'Call it like this:',
        '',
        '# comment stays\ndef f(*args, **kwargs):\n    return a * b * c',
        '',
        '- name: keep the dash',
      ].join('\n'),
    );
  });

  test('drops emphasis and links but keeps prose math and list markers', () => {
    const md = [
      '## Title',
      '',
      '**Bold** and *it* and `x * y`, 2 * 3 * 4, [link](https://a.b).',
      '',
      '1. one',
      '2. two',
      '   - nested',
      '',
      '- [x] done',
      '- [ ] todo',
    ].join('\n');
    expect(markdownToPlainText(md)).toBe(
      [
        'Title',
        '',
        'Bold and it and x * y, 2 * 3 * 4, link.',
        '',
        '1. one\n2. two\n   - nested',
        '',
        '- [x] done\n- [ ] todo',
      ].join('\n'),
    );
  });

  test('tables become tab-separated rows', () => {
    const md = '| a | b |\n|---|---|\n| 1 | **2** |';
    expect(markdownToPlainText(md)).toBe('a\tb\n1\t2');
  });
});
