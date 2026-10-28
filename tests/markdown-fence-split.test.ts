import { describe, expect, test } from 'vitest';

import { splitMarkdownWithCodeFences } from '../src/markdown-fence-split.js';

const codeLines = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix} line ${i} = ${i * 7}`);

/** Lines of `chunk` outside any ``` fence (these texts never nest them). */
function proseLines(chunk: string): string[] {
  let inside = false;
  const prose: string[] = [];
  for (const line of chunk.split('\n')) {
    if (line.startsWith('```')) inside = !inside;
    else if (!inside) prose.push(line);
  }
  // Every chunk closes what it opens.
  expect(inside).toBe(false);
  return prose;
}

/**
 * Undo the split. The texts here are cut at line ends, so a chunk ending in
 * a bare fence run without a newline carries an added closing fence, and the
 * next chunk then starts with the added reopening line.
 */
function rejoin(chunks: string[]): string {
  let text = '';
  let reopened = false;
  for (const chunk of chunks) {
    let body = reopened ? chunk.slice(chunk.indexOf('\n') + 1) : chunk;
    const closer = /(`{3,}|~{3,})$/.exec(body);
    reopened = closer !== null && chunk !== chunks.at(-1);
    if (reopened) body = body.slice(0, -closer![0].length);
    text += body;
  }
  return text;
}

describe('splitMarkdownWithCodeFences', () => {
  test('a long block cut three times keeps every chunk self-contained', () => {
    const code = codeLines('x', 270).join('\n');
    expect(code.length).toBeGreaterThan(4000);
    const text = `intro\n\`\`\`py\n${code}\n\`\`\`\nafter prose`;
    const chunks = splitMarkdownWithCodeFences(text, 1500);
    expect(chunks.length).toBeGreaterThanOrEqual(4);

    for (const [i, chunk] of chunks.entries()) {
      expect(chunk.length).toBeLessThanOrEqual(1500);
      if (i > 0) expect(chunk.startsWith('```py\n')).toBe(true);
      if (i < chunks.length - 1) expect(chunk.endsWith('\n```')).toBe(true);
      // No code line is read as prose in any chunk.
      expect(proseLines(chunk).some((line) => line.startsWith('x '))).toBe(
        false,
      );
    }
    expect(proseLines(chunks[0])).toEqual(['intro']);
    expect(proseLines(chunks.at(-1)!)).toEqual(['after prose']);
    expect(rejoin(chunks)).toBe(text);
  });

  test('several blocks reopen with their own language and prose stays prose', () => {
    const text = [
      'PROSE-1',
      '```js',
      ...codeLines('js', 90),
      '```',
      'PROSE-2',
      '```py',
      ...codeLines('py', 90),
      '```',
      'PROSE-3',
    ].join('\n');
    const chunks = splitMarkdownWithCodeFences(text, 900);
    expect(chunks.length).toBeGreaterThanOrEqual(4);

    expect(chunks.flatMap(proseLines).filter((line) => line !== '')).toEqual([
      'PROSE-1',
      'PROSE-2',
      'PROSE-3',
    ]);
    const reopenedAs = new Set<string>();
    for (const chunk of chunks.slice(1)) {
      const match = /^```(js|py)\n/.exec(chunk);
      if (!match) continue;
      reopenedAs.add(match[1]);
      const block = chunk.slice(match[0].length).split('\n```')[0];
      for (const line of block.split('\n')) {
        expect(line.startsWith(`${match[1]} `)).toBe(true);
      }
    }
    expect(reopenedAs).toEqual(new Set(['js', 'py']));
    expect(rejoin(chunks)).toBe(text);
  });

  test('fences of the other character or a shorter run are content', () => {
    const inner = Array.from({ length: 150 }, (_, i) =>
      i % 3 === 0 ? '```js' : i % 3 === 1 ? 'console.log(1)' : '```',
    );
    const text = [
      'before',
      '~~~markdown',
      ...inner,
      '~~~',
      'between',
      '````md',
      ...inner,
      '````',
      'after',
    ].join('\n');
    const chunks = splitMarkdownWithCodeFences(text, 300);
    expect(chunks.length).toBeGreaterThanOrEqual(4);

    const betweenAt = chunks.findIndex((chunk) =>
      chunk.split('\n').includes('between'),
    );
    expect(betweenAt).toBeGreaterThan(1);
    for (const [i, chunk] of chunks.entries()) {
      expect(chunk.length).toBeLessThanOrEqual(300);
      const lines = chunk.split('\n');
      if (i > 0 && i < betweenAt) {
        // Wholly inside the ~~~ block: the inner ``` lines never close it.
        expect(lines[0]).toBe('~~~markdown');
        expect(lines.at(-1)).toBe('~~~');
      }
      if (i > betweenAt && i < chunks.length - 1) {
        // Wholly inside the ```` block: a ``` run is too short to close it.
        expect(lines[0]).toBe('````md');
        expect(lines.at(-1)).toBe('````');
      }
    }
    expect(chunks.at(-1)!.startsWith('````md\n')).toBe(true);
    expect(chunks.at(-1)!.endsWith('\n````\nafter')).toBe(true);
    expect(rejoin(chunks)).toBe(text);
  });

  test('a fence line with an info string never closes, inline code never opens', () => {
    const body = Array.from({ length: 80 }, (_, i) =>
      i % 2 ? `body ${i}` : '```python',
    );
    const text = ['```inline``` is prose', '```text', ...body, '```', 'z'].join(
      '\n',
    );
    const chunks = splitMarkdownWithCodeFences(text, 200);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks[0].split('\n')[1]).toBe('```text');
    for (const chunk of chunks.slice(1)) {
      expect(chunk.startsWith('```text\n')).toBe(true);
    }
    expect(chunks.at(-1)!.endsWith('\n```\nz')).toBe(true);
    expect(rejoin(chunks)).toBe(text);
  });

  test('text within the limit is returned as is', () => {
    expect(splitMarkdownWithCodeFences('```\nopen', 100)).toEqual([
      '```\nopen',
    ]);
  });

  test('caps reopened fence info string to avoid chunk explosion', () => {
    const input = '```' + 'x'.repeat(4000) + '\n' + 'body line\n'.repeat(2000);
    const chunks = splitMarkdownWithCodeFences(input, 3500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(50);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3500);
    }
    for (const chunk of chunks.slice(1)) {
      expect(chunk.startsWith('```' + 'x'.repeat(32) + '\n')).toBe(true);
    }
  });
});
