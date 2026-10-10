import { describe, expect, test } from 'vitest';
import {
  canRenderBlockwise,
  endsInOpenFence,
  findMarkdownDefinitions,
  markdownTail,
  splitMarkdownBlocks,
} from './markdown-blocks';

const join = (blocks: string[]) => blocks.join('\n');

describe('splitMarkdownBlocks', () => {
  test('splits at blank lines and joins back to the original text', () => {
    const text = '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n';
    const blocks = splitMarkdownBlocks(text);
    expect(blocks).toEqual([
      '# Title\n',
      'First paragraph.\n',
      'Second paragraph.\n',
    ]);
    expect(join(blocks)).toBe(text);
  });

  test('keeps blank lines inside code fences and math in one block', () => {
    const text = [
      'Intro',
      '',
      '```python',
      'def f():',
      '',
      '    return 1',
      '```',
      '',
      '$$',
      'a',
      '',
      'b',
      '$$',
      '',
      'Outro',
    ].join('\n');
    const blocks = splitMarkdownBlocks(text);
    expect(blocks).toHaveLength(4);
    expect(blocks[1]).toContain('def f():\n\n    return 1\n```');
    expect(blocks[2]).toContain('a\n\nb\n$$');
    expect(join(blocks)).toBe(text);
  });

  test('an unclosed fence keeps everything after it in the open block', () => {
    const text = 'Intro\n\n~~~\ncode\n\nmore code';
    expect(splitMarkdownBlocks(text)).toEqual([
      'Intro\n',
      '~~~\ncode\n\nmore code',
    ]);
  });

  test('only a fence of the same kind and length closes it', () => {
    const text = '````md\n```\n\ninside\n````\n\nafter';
    const blocks = splitMarkdownBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toBe('after');
  });

  test('keeps loose lists and indented continuations together', () => {
    const text = [
      '1. One',
      '',
      '2. Two',
      '',
      '    indented continuation',
      '',
      'After the list',
    ].join('\n');
    const blocks = splitMarkdownBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toBe('After the list');
  });

  test('earlier blocks never change as text is appended', () => {
    const full =
      '# A\n\npara one\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nend';
    let previous: string[] = [];
    for (let end = 1; end <= full.length; end += 1) {
      const blocks = splitMarkdownBlocks(full.slice(0, end));
      // All but the last (open) block of the previous step are unchanged.
      expect(blocks.slice(0, previous.length - 1)).toEqual(
        previous.slice(0, -1),
      );
      previous = blocks;
    }
  });
});

describe('markdownTail', () => {
  test('returns short text unchanged', () => {
    expect(markdownTail('short', 100)).toBe('short');
  });

  test('cuts at a block boundary so fences stay intact', () => {
    const text = `${'a'.repeat(50)}\n\n\`\`\`\n${'b'.repeat(20)}\n\`\`\`\n\nend`;
    const tail = markdownTail(text, 40);
    expect(tail.startsWith('…\n\n```')).toBe(true);
    expect(tail.endsWith('end')).toBe(true);
  });
});

describe('endsInOpenFence', () => {
  test('is true only while a fence is unclosed', () => {
    expect(endsInOpenFence('text\n```ts\nconst a = 1;')).toBe(true);
    expect(endsInOpenFence('```ts\nconst a = 1;\n```')).toBe(false);
    expect(endsInOpenFence('~~~~\n```\nstill code')).toBe(true);
    expect(endsInOpenFence('plain paragraph')).toBe(false);
  });
});

describe('findMarkdownDefinitions', () => {
  test('collects reference links and notices footnotes outside code', () => {
    const text = [
      'See [文档][ref] and a note[^1].',
      '',
      '[ref]: https://example.com',
      '[^1]: The note.',
      '',
      '```',
      '[inside]: https://not-a-definition',
      '```',
    ].join('\n');
    expect(findMarkdownDefinitions(text)).toEqual({
      links: ['[ref]: https://example.com'],
      footnotes: true,
    });
  });

  test('ignores definitions that only appear inside fences', () => {
    expect(
      findMarkdownDefinitions('```\n[x]: https://a\n[^1]: b\n```'),
    ).toEqual({ links: [], footnotes: false });
  });
});

describe('canRenderBlockwise', () => {
  test('falls back to one document for cross-block meaning', () => {
    expect(canRenderBlockwise('# A\n\nB', false)).toBe(true);
    expect(canRenderBlockwise('[a][r]\n\n[r]: https://x', false)).toBe(false);
    expect(canRenderBlockwise('a[^1]\n\n[^1]: b', false)).toBe(false);
    expect(canRenderBlockwise('<details>\n\nx\n\n</details>', true)).toBe(
      false,
    );
  });
});
