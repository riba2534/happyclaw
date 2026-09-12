import { describe, expect, test } from 'vitest';
import { splitCardPages } from '../src/feishu-cards/pagination.js';
import { splitIntoBodySections } from '../src/feishu-cards/length.js';
import {
  buildAgentReplyCard,
  buildStreamingAgentCard,
} from '../src/feishu-cards/builder.js';

function verifyCoverage(source: string, maxBytes: number) {
  const pages = splitCardPages(source, { maxBytes });
  let position = 0;
  for (const page of pages) {
    expect(page.rawStart).toBe(position);
    expect(page.rawEnd).toBeGreaterThan(page.rawStart);
    expect(page.text).toContain(source.slice(page.rawStart, page.rawEnd));
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(maxBytes);
    expect(page.text).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
    position = page.rawEnd;
  }
  expect(position).toBe(source.length);
  expect(pages.map((p) => source.slice(p.rawStart, p.rawEnd)).join('')).toBe(
    source,
  );
  return pages;
}

describe('card pagination', () => {
  test('five 2500-character paragraphs survive final rendering (12508-character regression)', () => {
    const source = Array.from({ length: 5 }, (_, i) =>
      String(i).repeat(2500),
    ).join('\n\n');
    expect(source.length).toBe(12508);
    const card = buildAgentReplyCard({ text: source, status: 'done' });
    const body = card.body as {
      elements: Array<{ tag: string; content?: string }>;
    };
    expect(
      body.elements
        .filter((e) => e.tag === 'markdown')
        .map((e) => e.content)
        .join(''),
    ).toBe(source);
  });

  test('paragraph sections preserve exact whitespace and blank lines inside code', () => {
    const source =
      'Intro\n\n' + '```ts\n' + 'const x = 1;\n\n'.repeat(450) + '```\n\nTail';
    const sections = splitIntoBodySections(source);
    expect(sections.map((section) => section.text).join('')).toBe(source);
    const code = sections.find((section) => section.text.includes('```ts'))!;
    expect(code.text).toContain('const x = 1;\n\n'.repeat(450));
    expect(code.text).toContain('```\n');
  });

  test('completed cards retain indentation on the first code line', () => {
    const source = '    const x = 1;\n    console.log(x);\n';
    const card = buildAgentReplyCard({ text: source, status: 'done' });
    const body = card.body as { elements: Array<{ content?: string }> };
    expect(body.elements[0].content).toBe(source);
  });

  test('CJK and emoji use UTF-8 byte limits without splitting surrogate pairs', () => {
    verifyCoverage('中文🙂👨‍👩‍👧‍👦 e\u0301\n'.repeat(800), 1024);
  });

  test.each(['```typescript', '~~~~python'])(
    'continuation pages close and reopen %s fences',
    (opener) => {
      const marker = opener.startsWith('`') ? '```' : '~~~~';
      const source =
        `Intro\n\n${opener}\n` +
        'const 中文 = "🙂";\n\n'.repeat(200) +
        marker +
        '\nTail';
      const pages = verifyCoverage(source, 1024);
      expect(pages.length).toBeGreaterThan(2);
      for (const page of pages) {
        const fences = page.text
          .split('\n')
          .filter((line) => line.startsWith(marker));
        expect(fences.length % 2).toBe(0);
      }
    },
  );

  test('open upstream fence is closed in the displayed tail only', () => {
    const source = '```ts\n' + 'const x = 1;\n'.repeat(100);
    const pages = verifyCoverage(source, 600);
    expect(pages.at(-1)?.text.endsWith('\n```\n')).toBe(true);
    expect(source.endsWith('```')).toBe(false);
  });

  test('table pages repeat the header and preserve every row once', () => {
    const header = '| Key | Value |\n| --- | --- |\n';
    const rows = Array.from(
      { length: 100 },
      (_, i) => `| key_${i} | 中文详情_${i} |\n`,
    );
    const source = header + rows.join('');
    const pages = verifyCoverage(source, 600);
    for (const page of pages) expect(page.text.startsWith(header)).toBe(true);
    const allRows = pages.flatMap((p) =>
      p.text.split('\n').filter((row) => row.startsWith('| key_')),
    );
    expect(allRows).toEqual(rows.map((row) => row.trimEnd()));
  });

  test('a fitting table stays on one page even after a long introduction', () => {
    const table = '| Name | Status |\n| --- | --- |\n| Read | Done |\n';
    const source = 'Intro '.repeat(90) + '\n\n' + table;
    const pages = verifyCoverage(source, 570);
    expect(pages.some((page) => page.text.includes(table))).toBe(true);
  });

  test('a huge single line makes progress without truncating', () => {
    const source = '🙂'.repeat(2500);
    const pages = verifyCoverage(source, 1024);
    expect(pages.map((page) => page.text).join('')).toBe(source);
  });

  test.each([
    '| Name | Value |\n| --- | --- |\n| one | ' + '字'.repeat(1000) + ' |\n',
    '```' + 'language'.repeat(200) + '\nconst x = 1;\n```',
  ])(
    'indivisible Markdown keeps the complete source with an explicit plain continuation notice',
    (source) => {
      const pages = verifyCoverage(source, 600);
      expect(
        pages.every((page) =>
          page.text.startsWith('> 内容较长，以下按原文分段展示。'),
        ),
      ).toBe(true);
    },
  );

  test('empty content and invalid byte budgets have explicit behavior', () => {
    expect(splitCardPages('')).toEqual([{ rawStart: 0, rawEnd: 0, text: '' }]);
    expect(() => splitCardPages('hello', { maxBytes: 0 })).toThrow('256');
  });

  test('a fitting 20K answer uses one card when actual JSON capacity is available', () => {
    const source = 'a'.repeat(20_000);
    const fits = (text: string) =>
      [
        buildStreamingAgentCard({ initialText: text }),
        buildAgentReplyCard({ text, status: 'done' }),
      ].every((card) => Buffer.byteLength(JSON.stringify(card)) <= 25 * 1024);
    expect(splitCardPages(source, { fits })).toEqual([
      { rawStart: 0, rawEnd: source.length, text: source },
    ]);
  });

  test('actual JSON escaping determines capacity instead of raw-text bytes', () => {
    const source = '\\'.repeat(20_000);
    const fits = (text: string) =>
      Buffer.byteLength(
        JSON.stringify(buildStreamingAgentCard({ initialText: text })),
      ) <=
      25 * 1024;
    const pages = splitCardPages(source, { fits });
    expect(pages).toHaveLength(2);
    expect(pages.every((page) => fits(page.text))).toBe(true);
    expect(pages[0].rawEnd).toBeGreaterThan(12_000);
    expect(
      pages.map((page) => source.slice(page.rawStart, page.rawEnd)).join(''),
    ).toBe(source);
  });

  test('short introduction and a long code line do not create tiny fence pages', () => {
    const source = 'intro\n\n~~~txt\n' + 'a'.repeat(15_000) + '\n~~~\n';
    const pages = verifyCoverage(source, 12_000);
    expect(pages).toHaveLength(2);
    expect(pages[0].rawEnd).toBeGreaterThan(11_000);
    expect(
      pages.every(
        (page) =>
          page.text.split('\n').filter((line) => line.startsWith('~~~'))
            .length === 2,
      ),
    ).toBe(true);
    expect(
      splitCardPages(source, {
        fits: (text) =>
          Buffer.byteLength(
            JSON.stringify(buildStreamingAgentCard({ initialText: text })),
          ) <=
          25 * 1024,
      }),
    ).toHaveLength(1);
  });

  test('early paragraph boundaries do not waste most of an available card', () => {
    const source = 'a'.repeat(4000) + '\n\n' + 'b'.repeat(15_000);
    const pages = verifyCoverage(source, 12_000);
    expect(pages).toHaveLength(2);
    expect(pages[0].rawEnd).toBe(12_000);
  });

  test('character budgets count Unicode code points and include repaired fences', () => {
    const source = '~~~text\n' + '🙂'.repeat(1100) + '\n~~~\n';
    const pages = splitCardPages(source, { maxChars: 1000 });
    expect(pages).toHaveLength(2);
    for (const page of pages)
      expect(Array.from(page.text).length).toBeLessThanOrEqual(1000);
    expect(pages[0].rawEnd).toBeGreaterThan(1900);
    expect(
      pages.map((page) => source.slice(page.rawStart, page.rawEnd)).join(''),
    ).toBe(source);
    expect(
      splitCardPages('🙂'.repeat(99_000), { maxChars: 99_000 }),
    ).toHaveLength(1);
  });

  test('frozen raw boundaries stay fixed when more content is appended inside a fence', () => {
    const initial = '```ts\n' + 'const x = 1;\n'.repeat(100);
    const previous = splitCardPages(initial, { maxBytes: 600 });
    const boundaries = previous.slice(0, -1).map((page) => page.rawEnd);
    const extended = initial + 'const y = 2;\n'.repeat(100) + '```\n';
    const pages = splitCardPages(extended, {
      maxBytes: 600,
      frozenBoundaries: boundaries,
    });
    expect(pages.slice(0, boundaries.length)).toEqual(previous.slice(0, -1));
    expect(
      pages.map((page) => extended.slice(page.rawStart, page.rawEnd)).join(''),
    ).toBe(extended);
    expect(pages.every((page) => Buffer.byteLength(page.text) <= 600)).toBe(
      true,
    );
  });

  test('new rendering capacity can shorten an affected frozen page without losing text', () => {
    const source = 'a'.repeat(2000);
    const pages = splitCardPages(source, {
      maxChars: 700,
      frozenBoundaries: [500, 1500],
    });
    expect(pages[0].rawEnd).toBe(500);
    expect(pages[1].rawEnd).toBe(1200);
    expect(pages.every((page) => page.text.length <= 700)).toBe(true);
    expect(pages.map((page) => page.text).join('')).toBe(source);
  });

  test('provider-accepted pages keep their capacity when only a later page needs a smaller retry', () => {
    const source = 'a'.repeat(2300);
    const pages = splitCardPages(source, {
      maxChars: 600,
      frozenBoundaries: [1000],
      preserveFrozenCapacity: true,
    });
    expect(pages[0]).toEqual({
      rawStart: 0,
      rawEnd: 1000,
      text: source.slice(0, 1000),
    });
    expect(pages.slice(1).every((page) => page.text.length <= 600)).toBe(true);
    expect(pages.map((page) => page.text).join('')).toBe(source);
  });

  test('a later oversized table row does not reformat already frozen pages', () => {
    const initial = 'Intro\n\n' + 'a'.repeat(1400) + '\n\n';
    const previous = splitCardPages(initial, { maxBytes: 600 });
    const boundaries = previous.slice(0, -1).map((page) => page.rawEnd);
    const source =
      initial +
      '| Name | Value |\n| --- | --- |\n| One | ' +
      '字'.repeat(1000) +
      ' |\n';
    const pages = splitCardPages(source, {
      maxBytes: 600,
      frozenBoundaries: boundaries,
    });
    expect(pages.slice(0, boundaries.length)).toEqual(previous.slice(0, -1));
    expect(
      pages.map((page) => source.slice(page.rawStart, page.rawEnd)).join(''),
    ).toBe(source);
    expect(pages.every((page) => Buffer.byteLength(page.text) <= 600)).toBe(
      true,
    );
  });
});
