import { describe, expect, test } from 'vitest';
import {
  FEISHU_POST_MAX_BYTES,
  FEISHU_TEXT_MAX_BYTES,
  prepareFeishuPlainTextPages,
  prepareFeishuPostTextPages,
} from '../src/feishu-message-capacity.js';
import {
  buildPostMdFallback,
  FEISHU_POST_MD_NODE_MAX_BYTES,
  splitFeishuPostMarkdown,
} from '../src/feishu-message-format.js';

const validUnicode = (text: string) =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    text,
  );

describe('ordinary Feishu message capacity', () => {
  test.each([
    '中文内容'.repeat(800) + '尾部',
    '🙂🚀'.repeat(800) + 'TAIL',
    '\\"\t\r\n'.repeat(800) + 'TAIL',
    '~~~ts\nconst text = "![literal](image.png)";\n\n~~~\n'.repeat(200) +
      'TAIL',
  ])(
    'plain text preserves exact source and actual escaped content bytes (%#)',
    (raw) => {
      const pages = prepareFeishuPlainTextPages(raw, { maxBytes: 1024 });
      expect(pages.length).toBeGreaterThan(1);
      expect(pages.join('')).toBe(raw);
      expect(pages.every(validUnicode)).toBe(true);
      expect(
        pages.every(
          (text) => Buffer.byteLength(JSON.stringify({ text })) <= 1024,
        ),
      ).toBe(true);
    },
  );

  test('plain text paragraph preference does not create a tiny introduction page', () => {
    const source = 'Intro\n\n' + 'a'.repeat(1500);
    const pages = prepareFeishuPlainTextPages(source, { maxBytes: 512 });
    expect(pages[0].length).toBeGreaterThan(450);
    expect(pages.join('')).toBe(source);
  });

  test('plain text semantic boundaries use actual bytes for mixed-width source', () => {
    const source = 'a'.repeat(390) + '\n\n' + '中'.repeat(100);
    const pages = prepareFeishuPlainTextPages(source, { maxBytes: 512 });
    expect(pages[0]).toContain('中');
    expect(
      Buffer.byteLength(JSON.stringify({ text: pages[0] })),
    ).toBeGreaterThan(490);
    expect(pages.join('')).toBe(source);
  });

  test('plain text uses a near-capacity paragraph boundary when available', () => {
    const source = 'a'.repeat(470) + '\n\n' + 'b'.repeat(600);
    const pages = prepareFeishuPlainTextPages(source, { maxBytes: 512 });
    expect(pages[0]).toBe('a'.repeat(470) + '\n\n');
    expect(pages.join('')).toBe(source);
  });

  test.each([prepareFeishuPlainTextPages, prepareFeishuPostTextPages])(
    'a small answer stays unmodified; byte budgets can be tightened for retry (%#)',
    (prepare) => {
      const short = '# Original heading\n\n  Indented source\nTAIL';
      expect(prepare(short)).toEqual([short]);
      const source = '字🙂"\\'.repeat(1200) + 'TAIL';
      const original = prepare(source, { maxBytes: 4096 });
      const retry = original.flatMap((page) =>
        prepare(page, { maxBytes: 1024 }),
      );
      expect(retry.length).toBeGreaterThan(original.length);
      expect(retry.join('')).toBe(source);
    },
  );

  test.each([
    '中文内容'.repeat(800) + '尾部',
    '🙂🚀'.repeat(800) + 'TAIL',
    '\\"'.repeat(2500) + 'TAIL',
  ])(
    'post pagination accounts for formatted node JSON and escaping (%#)',
    (raw) => {
      const pages = prepareFeishuPostTextPages(raw, { maxBytes: 2048 });
      expect(pages.length).toBeGreaterThan(1);
      expect(pages.join('')).toBe(raw);
      expect(pages.every(validUnicode)).toBe(true);
      expect(
        pages.every(
          (text) => Buffer.byteLength(buildPostMdFallback(text)) <= 2048,
        ),
      ).toBe(true);
    },
  );

  test('post code pages and their internal Markdown nodes remain independently balanced', () => {
    const lines = Array.from(
      { length: 240 },
      (_, i) => `const value_${i} = "中文🙂";\n`,
    );
    const source = '~~~ts\n' + lines.join('') + '~~~\n\nTAIL_SENTINEL';
    const pages = prepareFeishuPostTextPages(source, { maxBytes: 4096 });
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      const content = buildPostMdFallback(page);
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(4096);
      const nodes = JSON.parse(content).zh_cn.content.flat() as {
        text: string;
      }[];
      for (const node of nodes) {
        expect(Buffer.byteLength(node.text)).toBeLessThanOrEqual(
          FEISHU_POST_MD_NODE_MAX_BYTES,
        );
        expect((node.text.match(/~~~/g) ?? []).length % 2).toBe(0);
      }
    }
    const visible = pages.join('');
    for (const line of lines) expect(visible.split(line)).toHaveLength(2);
    expect(pages.at(-1)).toContain('TAIL_SENTINEL');
  });

  test('post tables preserve each data row while repeating continuation headers', () => {
    const header = '| Name | Value |\n| --- | --- |\n';
    const rows = Array.from(
      { length: 200 },
      (_, i) => `| key_${i} | 内容_${i} |\n`,
    );
    const pages = prepareFeishuPostTextPages(header + rows.join(''), {
      maxBytes: 2048,
    });
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.startsWith(header)).toBe(true);
      expect(Buffer.byteLength(buildPostMdFallback(page))).toBeLessThanOrEqual(
        2048,
      );
    }
    expect(
      pages.flatMap((page) =>
        page.split('\n').filter((row) => row.startsWith('| key_')),
      ),
    ).toEqual(rows.map((row) => row.trimEnd()));
  });

  test('provider budgets measure inner content, allowing large transport-escaped requests', () => {
    const source = '"'.repeat(70_000);
    const textContent = JSON.stringify({ text: source });
    expect(Buffer.byteLength(textContent)).toBeLessThan(FEISHU_TEXT_MAX_BYTES);
    expect(
      Buffer.byteLength(
        JSON.stringify({ msg_type: 'text', content: textContent }),
      ),
    ).toBeGreaterThan(FEISHU_TEXT_MAX_BYTES);
    expect(prepareFeishuPlainTextPages(source)).toEqual([source]);
    const postContent = buildPostMdFallback(source);
    expect(Buffer.byteLength(postContent)).toBeLessThan(FEISHU_POST_MAX_BYTES);
    expect(
      Buffer.byteLength(
        JSON.stringify({ msg_type: 'post', content: postContent }),
      ),
    ).toBeGreaterThan(FEISHU_POST_MAX_BYTES);
    expect(prepareFeishuPostTextPages(source)).toEqual([source]);
  });

  test('150KB-class ordinary replies preserve the tail across physical messages', () => {
    const source = '中文🙂'.repeat(32_000) + 'UNIQUE_END_SENTINEL';
    for (const prepare of [
      prepareFeishuPlainTextPages,
      prepareFeishuPostTextPages,
    ]) {
      const pages = prepare(source);
      expect(pages.length).toBeGreaterThan(1);
      expect(pages.join('')).toBe(source);
      expect(pages.at(-1)?.endsWith('UNIQUE_END_SENTINEL')).toBe(true);
    }
  });

  test('empty source and invalid budgets have explicit behavior', () => {
    for (const prepare of [
      prepareFeishuPlainTextPages,
      prepareFeishuPostTextPages,
    ]) {
      expect(prepare('')).toEqual(['']);
      expect(() => prepare('hello', { maxBytes: 0 })).toThrow('256');
    }
  });
});

describe('oversized post fence markers', () => {
  test.each(['`'.repeat(2600), '~'.repeat(1198)])(
    'oversized continuation syntax makes progress and retains the original marker (%#)',
    (marker) => {
      const source = marker + '\n' + '🙂'.repeat(1500) + '\n' + marker;
      const chunks = splitFeishuPostMarkdown(source);
      expect(chunks.join('')).toBe(source);
      expect(
        chunks.every(
          (chunk) => Buffer.byteLength(chunk) <= FEISHU_POST_MD_NODE_MAX_BYTES,
        ),
      ).toBe(true);
      expect(chunks.every(validUnicode)).toBe(true);
      const pages = prepareFeishuPostTextPages(source, { maxBytes: 4096 });
      expect(
        pages.every(
          (page) => Buffer.byteLength(buildPostMdFallback(page)) <= 4096,
        ),
      ).toBe(true);
    },
  );
});
