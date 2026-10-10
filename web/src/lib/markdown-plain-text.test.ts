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

  test('keeps `<word>` that is not HTML, as the reply renders it', () => {
    expect(
      markdownToPlainText('返回 Promise<void> 和 Vec<u8>，见 Array<string>。'),
    ).toBe('返回 Promise<void> 和 Vec<u8>，见 Array<string>。');
  });

  test('reads emphasis after full-width punctuation as emphasis', () => {
    expect(markdownToPlainText('**注意：**正文内容')).toBe('注意：正文内容');
    expect(markdownToPlainText('~~（已废弃）~~接口')).toBe('（已废弃）接口');
  });

  test('strips only allowlisted tags, turning <br> into a line break', () => {
    expect(markdownToPlainText('第一行<br>第二行')).toBe('第一行\n第二行');
    expect(markdownToPlainText('按 <kbd>Ctrl</kbd> + <kbd>C</kbd>')).toBe(
      '按 Ctrl + C',
    );
    expect(markdownToPlainText('可见<!-- 注释 -->文字')).toBe('可见文字');
    expect(
      markdownToPlainText(
        '<details>\n<summary>返回 Promise<void></summary>\n\n正文\n\n</details>',
      ),
    ).toBe('返回 Promise<void>\n\n正文');
    expect(markdownToPlainText('<script>alert(1)</script>')).toBe(
      '<script>alert(1)</script>',
    );
  });

  test('tables become tab-separated rows', () => {
    const md = '| a | b |\n|---|---|\n| 1 | **2** |';
    expect(markdownToPlainText(md)).toBe('a\tb\n1\t2');
  });
});
