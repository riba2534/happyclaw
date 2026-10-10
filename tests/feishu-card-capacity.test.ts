import { describe, expect, test } from 'vitest';
import {
  buildAgentReplyCard,
  buildStreamingAgentCard,
  buildStreamingContentElements,
} from '../src/feishu-cards/builder.js';
import {
  CARDKIT_JSON_MAX_BYTES,
  CARDKIT_MARKDOWN_MAX_CHARS,
  fitsCardCapacity,
  unicodeCodePointLength,
} from '../src/feishu-cards/capacity.js';
import { splitCardPages } from '../src/feishu-cards/pagination.js';

describe('CardKit capacity', () => {
  test('nested plain text components count towards the card limit', () => {
    const card = {
      body: {
        elements: Array.from({ length: 100 }, () => ({
          tag: 'button',
          text: { tag: 'plain_text', content: 'Run' },
        })),
      },
    };
    expect(fitsCardCapacity(card)).toBe(true);
    card.body.elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: 'Run' },
    });
    expect(fitsCardCapacity(card)).toBe(false);
  });

  test('native and Markdown tables both count toward the per-card and per-element table limits', () => {
    const table = '| A | B |\n| - | - |\n| C | D |\n\n';
    expect(
      fitsCardCapacity({
        body: { elements: Array.from({ length: 6 }, () => ({ tag: 'table' })) },
      }),
    ).toBe(false);
    // Feishu: at most 5 tables per card and 4 per Markdown element; beyond
    // that the whole card is rejected (230099 / ErrCode 11310).
    expect(
      fitsCardCapacity(
        buildAgentReplyCard({ text: table.repeat(6), status: 'done' }),
      ),
    ).toBe(false);
    expect(
      fitsCardCapacity(
        buildAgentReplyCard({ text: table.repeat(5), status: 'done' }),
      ),
    ).toBe(true);
    expect(
      fitsCardCapacity({ tag: 'markdown', content: table.repeat(4) }),
    ).toBe(true);
    expect(
      fitsCardCapacity({ tag: 'markdown', content: table.repeat(5) }),
    ).toBe(false);
    // Tables inside fenced code are literal text, not tables.
    expect(
      fitsCardCapacity({
        tag: 'markdown',
        content: '```md\n' + table.repeat(8) + '```\n',
      }),
    ).toBe(true);
    // Three Markdown tables in panels plus three in the body exceed the card.
    expect(
      fitsCardCapacity({
        body: {
          elements: [
            { tag: 'markdown', content: table.repeat(3) },
            { tag: 'markdown', content: table.repeat(3) },
          ],
        },
      }),
    ).toBe(false);
  });

  test('pagination keeps six Markdown tables within the card table limits', () => {
    const tables = Array.from(
      { length: 6 },
      (_, i) => `### 表 ${i}\n\n| 列${i} | 值 |\n|---|---|\n| a | 1 |\n`,
    ).join('\n');
    const fits = (text: string) =>
      [
        buildStreamingAgentCard({ initialText: text }),
        buildAgentReplyCard({ text, status: 'done' }),
      ].every((card) => fitsCardCapacity(card));
    const pages = splitCardPages(tables, { fits });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map((page) => page.text).join('')).toContain('列5');
    for (const page of pages) expect(fits(page.text)).toBe(true);
    expect(pages.at(-1)!.rawEnd).toBe(tables.length);
  });

  test('astral emoji use code points for Markdown limits and UTF-8 bytes for cards', () => {
    expect(unicodeCodePointLength('中🙂a')).toBe(3);
    const card = buildStreamingAgentCard({ initialText: '🙂'.repeat(50_001) });
    expect(fitsCardCapacity(card)).toBe(true);
    expect(
      fitsCardCapacity(
        buildStreamingAgentCard({ initialText: '🙂'.repeat(80_000) }),
      ),
    ).toBe(false);
    expect(
      fitsCardCapacity(
        {
          tag: 'markdown',
          content: 'a'.repeat(CARDKIT_MARKDOWN_MAX_CHARS + 1),
        },
        { maxMarkdownChars: CARDKIT_MARKDOWN_MAX_CHARS },
      ),
    ).toBe(false);
  });

  test.each([
    'a'.repeat(320_000),
    '中'.repeat(110_000),
    '\\'.repeat(160_000),
    '🙂'.repeat(100_000),
  ])(
    'pages fit actual live/final cards while preserving the complete source (%#)',
    (source) => {
      const fits = (text: string) =>
        [
          buildStreamingAgentCard({ initialText: text }),
          buildAgentReplyCard({ text, status: 'done' }),
        ].every((card) => fitsCardCapacity(card));
      const pages = splitCardPages(source, {
        fits,
      });
      expect(pages).toHaveLength(2);
      expect(pages.every((page) => fits(page.text))).toBe(true);
      expect(
        pages.map((page) => source.slice(page.rawStart, page.rawEnd)).join(''),
      ).toBe(source);
      expect(
        Buffer.byteLength(
          JSON.stringify(
            buildStreamingAgentCard({ initialText: pages[0].text }),
          ),
        ),
      ).toBeLessThanOrEqual(CARDKIT_JSON_MAX_BYTES);
    },
  );

  test('one 200K ASCII card uses three independently streamable content slots', () => {
    const source = 'a'.repeat(200_000);
    const elements = buildStreamingContentElements(source);
    expect(elements.map((element) => element.element_id)).toEqual([
      'main_content',
      'main_content_1',
      'main_content_2',
    ]);
    expect(elements.map((element) => element.content).join('')).toBe(source);
    expect(
      elements.every(
        (element) =>
          unicodeCodePointLength(element.content) <= CARDKIT_MARKDOWN_MAX_CHARS,
      ),
    ).toBe(true);
    const fits = (text: string) =>
      fitsCardCapacity(buildStreamingAgentCard({ initialText: text })) &&
      fitsCardCapacity(buildAgentReplyCard({ text, status: 'done' }));
    expect(splitCardPages(source, { fits })).toHaveLength(1);
    expect(
      fitsCardCapacity(buildAgentReplyCard({ text: source, status: 'done' })),
    ).toBe(true);
  });

  test('content slots repair a long code fence within one card', () => {
    const source = '~~~text\n' + 'a'.repeat(120_000) + '\n~~~\n';
    const elements = buildStreamingContentElements(source);
    expect(elements).toHaveLength(2);
    expect(
      elements.every(
        (element) =>
          unicodeCodePointLength(element.content) <= CARDKIT_MARKDOWN_MAX_CHARS,
      ),
    ).toBe(true);
    // The live slot uses the terminal card's Markdown normalization (spacing
    // around the fence), and every slot still holds a complete fence.
    const fenced = elements.map((element) =>
      element.content.match(/~~~text\n([\s\S]*?)\n~~~(?:\n|$)/),
    );
    expect(fenced.every((match) => match !== null)).toBe(true);
    expect(fenced.map((match) => match![1]).join('')).toBe('a'.repeat(120_000));
    expect(
      fitsCardCapacity(buildStreamingAgentCard({ initialText: source })),
    ).toBe(true);
  });
});
