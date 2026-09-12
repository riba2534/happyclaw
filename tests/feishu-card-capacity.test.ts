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

  test('native tables are counted without confusing Markdown table source with components', () => {
    expect(
      fitsCardCapacity({
        body: { elements: Array.from({ length: 6 }, () => ({ tag: 'table' })) },
      }),
    ).toBe(false);
    expect(
      fitsCardCapacity(
        buildAgentReplyCard({
          text: '| A | B |\n| - | - |\n| C | D |\n\n'.repeat(6),
          status: 'done',
        }),
      ),
    ).toBe(true);
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
    expect(
      elements.every(
        (element) =>
          element.content.startsWith('~~~text\n') &&
          element.content.endsWith('\n~~~\n'),
      ),
    ).toBe(true);
    expect(
      elements
        .map((element) =>
          element.content.replace(/^~~~text\n/, '').replace(/\n~~~\n$/, ''),
        )
        .join(''),
    ).toBe('a'.repeat(120_000));
    expect(
      fitsCardCapacity(buildStreamingAgentCard({ initialText: source })),
    ).toBe(true);
  });
});
