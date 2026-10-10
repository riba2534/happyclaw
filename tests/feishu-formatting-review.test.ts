import { describe, expect, test } from 'vitest';

import { optimizeMarkdownStyle } from '../src/feishu-markdown-style.js';
import {
  buildPostMdFallback,
  separatePostMarkdownTables,
  splitFeishuPostMarkdown,
} from '../src/feishu-message-format.js';
import {
  buildAskQuestionText,
  buildBodyChunks,
  buildProgressListText,
  buildStatusBannerText,
  buildThinkingBlockquote,
  buildTimelineText,
  buildToolsTimelineText,
  escapeFeishuPanelInline,
  extractTitle,
  formatTokens,
  shortModel,
} from '../src/feishu-cards/sections.js';
import {
  SECTION_MAX_TABLES,
  splitIntoBodySections,
} from '../src/feishu-cards/length.js';
import { countMarkdownTables } from '../src/feishu-cards/pagination.js';
import {
  formatFeishuTokenCount,
  formatFeishuTokenSummary,
} from '../src/feishu-usage-display.js';

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function postNodes(text: string): string[] {
  const payload = JSON.parse(buildPostMdFallback(text)) as {
    zh_cn: { content: Array<Array<{ text: string }>> };
  };
  return payload.zh_cn.content.map((paragraph) => paragraph[0].text);
}

function table(label: string): string {
  return `| ${label} | 值 |\n|---|---|\n| a | 1 |\n`;
}

describe('P1-7 optimizeMarkdownStyle stays linear on pipe-heavy input', () => {
  test.each([
    ['one 80K-char `col|` line', `结果：\n${'col|'.repeat(20_000)}end\n\n完毕`],
    ['pipe prose', `x${' | y'.repeat(16_000)}\n`],
    ['row without trailing pipe', `\n\n|${'a|'.repeat(40_000)}x\n`],
  ])('%s is processed in under 50ms', (_label, input) => {
    expect(input.length).toBeGreaterThanOrEqual(64_000);
    // Best of three keeps the bound meaningful on a busy CI host; the old
    // quadratic regex took over a second for the first input.
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      optimizeMarkdownStyle(input, 2);
      best = Math.min(best, performance.now() - started);
    }
    expect(best).toBeLessThan(50);
  });
});

describe('P2-10 table spacing keeps the established layout for real tables', () => {
  test.each([
    [
      'Intro\n| A | B |\n| --- | --- |\n| a | b |\n\nnext',
      'Intro\n<br>\n| A | B |\n| --- | --- |\n| a | b |\n<br>\n\nnext',
    ],
    ['| A |\n|---|\n| a |\n', '| A |\n|---|\n| a |\n<br>\n'],
    [
      '#### H\n| A |\n|---|\n| a |\nnext',
      '#### H\n\n<br>\n\n| A |\n|---|\n| a |\n<br>\nnext',
    ],
    [
      '**B**\n| A |\n|---|\n| a |\n#### X',
      '**B**\n<br>\n\n| A |\n|---|\n| a |\n\n<br>\n#### X',
    ],
    ['x\n| a |\n|---|\n| 1 |', 'x\n<br>\n| a |\n|---|\n| 1 |\n<br>\n'],
    [
      '| a |\n|---|\n| 1 |\n\n| b |\n|---|\n| 2 |\n',
      '| a |\n|---|\n| 1 |\n<br>\n<br>\n| b |\n|---|\n| 2 |\n<br>\n',
    ],
  ])('%j', (input, expected) => {
    expect(optimizeMarkdownStyle(input, 2)).toBe(expected);
  });

  test('a table without trailing pipes is padded, never cut mid-row', () => {
    expect(
      optimizeMarkdownStyle('结果如下：\n\n| a | b\n|---|---\n| 1 | 2\n', 2),
    ).toBe('结果如下：\n<br>\n| a | b\n|---|---\n| 1 | 2\n<br>\n');
  });

  test('pipe-delimited prose is not treated as a table', () => {
    const prose = '说明\n|x| 表示 x 的绝对值，|y| 同理\n后文';
    expect(optimizeMarkdownStyle(prose, 2)).toBe(prose);
  });
});

describe('P2-10 image stripping', () => {
  test.each([
    ['![图](https://e.com/a.png "示意图")', ''],
    ['![图](https://e.com/a_(1).png)', ''],
    ['![图](<https://e.com/a b.png>)', ''],
    [
      '[![badge](https://img.shields.io/x.svg)](https://github.com/x)',
      '[badge](https://github.com/x)',
    ],
    [
      '[![](https://img.shields.io/x.svg)](https://github.com/x)',
      '[https://github.com/x](https://github.com/x)',
    ],
    ['![ok](img_v2_abc) 与 ![bad](./x.png)', '![ok](img_v2_abc) 与 '],
  ])('%j', (input, expected) => {
    expect(optimizeMarkdownStyle(input, 2)).toBe(expected);
  });

  test('image syntax inside inline code stays literal', () => {
    const out = optimizeMarkdownStyle(
      '用 `![描述](https://example.com/a.png)` 插入；或 ![logo](https://x.com/l.png) 结束',
      2,
    );
    expect(out).toBe('用 `![描述](https://example.com/a.png)` 插入；或  结束');
  });
});

describe('P1-2 / P2-11 post Markdown', () => {
  test('mentions are neutralized outside code and kept verbatim inside', () => {
    const [node] = postNodes(
      '提醒 <at user_id="all"></at> <at email=ceo@corp.com></at> `<at id=all>`\n```\n<at id=all></at>\n```',
    );
    expect(node).not.toMatch(/(^|[^`])<at (user_id|email)/);
    expect(node).toContain('＜at user_id="all">');
    expect(node).toContain('`<at id=all>`');
    expect(node).toContain('```\n<at id=all></at>\n```');
  });

  test('tables are separated from surrounding blocks by blank lines', () => {
    expect(
      postNodes('统计结果：\n| a | b |\n|---|---|\n| 1 | 2 |\n后文'),
    ).toEqual(['统计结果：\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n后文']);
    expect(
      separatePostMarkdownTables('```\n| a |\n|---|\n```\n| b |\n|---|\n'),
    ).toBe('```\n| a |\n|---|\n```\n\n| b |\n|---|\n');
  });

  test('an over-budget line is never cut inside a link or bold run', () => {
    const link =
      '**[官方文档链接](https://open.feishu.cn/document/server-docs/im-v1/message/create)**';
    const para = `${'这是一段很长的中文说明'.repeat(70)}，详见${link}以及更多${'补充内容'.repeat(60)}`;
    const nodes = splitFeishuPostMarkdown(para);
    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes.join('')).toBe(para);
    expect(nodes.some((node) => node.includes(link))).toBe(true);
    for (const node of nodes) {
      expect(Buffer.byteLength(node)).toBeLessThanOrEqual(2_400);
    }
  });

  test('a protected span larger than the budget still makes progress', () => {
    const huge = `${'a'.repeat(100)}**${'b'.repeat(900)}**`;
    const nodes = splitFeishuPostMarkdown(huge, 512);
    expect(nodes.join('')).toBe(huge);
    expect(nodes.every((node) => Buffer.byteLength(node) <= 512)).toBe(true);
  });
});

describe('P1-2 / P2-11 panel text', () => {
  test('escapeFeishuPanelInline neutralizes markup in one-line values', () => {
    expect(
      escapeFeishuPanelInline('# echo "</font><at id=all></at>" | `x`\nnext'),
    ).toBe(
      '&#35; echo "&#60;/font>&#60;at id=all>&#60;/at>" &#124; &#96;x&#96; next',
    );
  });

  test('tool timeline cannot close its font tag or @ everyone', () => {
    const out = buildToolsTimelineText([
      {
        name: 'Bash',
        status: 'complete',
        durationMs: 1200,
        summary: 'echo "</font><at id=all></at>" | grep **x**\nrm -rf /',
      },
    ]);
    expect(out).not.toContain('<at');
    expect(out.match(/<\/font>/g)).toHaveLength(2);
    expect(out.split('\n')).toHaveLength(2);
  });

  test('truncation and thinking tails never leave lone surrogates', () => {
    const timeline = buildToolsTimelineText([
      {
        name: 'Read',
        status: 'complete',
        durationMs: 0,
        summary: `${'a'.repeat(88)}😀😀😀`,
      },
    ]);
    expect(LONE_SURROGATE.test(timeline)).toBe(false);
    const thinking = buildThinkingBlockquote(
      `${'x'.repeat(10)}${'😀'.repeat(1500)}`,
    );
    expect(LONE_SURROGATE.test(thinking)).toBe(false);
  });

  test('thinking keeps Markdown but neutralizes mentions', () => {
    const out = buildThinkingBlockquote('**粗体** <at id=all></at>');
    expect(out).toBe('> **粗体** &#60;at id=all></at>');
  });

  test('todos, questions, timeline and banner details never @ anyone', () => {
    const outputs = [
      buildProgressListText([
        { content: '通知 <at id=all></at>\n下一行', status: 'in_progress' },
      ]),
      buildAskQuestionText([
        {
          question: '选择 <at id=all></at>?',
          options: [{ label: '<at email=ceo@corp.com></at>' }],
        },
      ]),
      buildTimelineText([{ text: '↳ 结果 <at id=all></at>\n第二行' }]),
      buildStatusBannerText({
        phase: 'tooling',
        detail: '`Bash`: <at id=all></at>',
      }),
    ];
    for (const output of outputs) expect(output).not.toMatch(/<at\b/);
    expect(outputs[2].split('\n')).toHaveLength(1);
  });
});

describe('P2-12 small formatting items', () => {
  test.each([
    ['claude-opus-5-20261001', 'opus-5'],
    ['claude-opus-5', 'opus-5'],
    ['claude-fable-5-1', 'fable-5.1'],
    ['claude-opus-4-7', 'opus-4.7'],
    ['claude-haiku-4-5-20251001', 'haiku-4.5'],
    ['claude-opus-4-7[1m]', 'opus-4.7'],
    ['us.anthropic.claude-opus-4-1-20250805-v1:0', 'opus-4.1'],
    ['gpt-4o-mini', 'gpt-4o-mini'],
  ])('shortModel(%s) = %s', (model, expected) => {
    expect(shortModel(model)).toBe(expected);
  });

  test('token counts switch to M instead of 1000.0K', () => {
    expect(formatFeishuTokenCount(7_512_345)).toBe('7.5M');
    expect(formatFeishuTokenCount(999_950)).toBe('1.0M');
    expect(formatFeishuTokenCount(999_949)).toBe('999.9K');
    expect(formatTokens(2_000_000)).toBe('2.0M');
    expect(
      formatFeishuTokenSummary({
        inputTokens: 12,
        outputTokens: 3400,
        cacheReadInputTokens: 7_512_345,
      }),
    ).toBe('7.5M tokens（输入 12 · 输出 3.4K · 缓存读取 7.5M）');
  });

  test.each([
    '```bash\nnpm ci\n```\n\n然后运行',
    '~~~\ncode\n~~~',
    '| 项 | 值 |\n|---|---|\n| a | 1 |\n\n说明',
    '| 单列 |\n|---|\n| a |',
  ])('extractTitle does not eat a code or table line: %j', (text) => {
    expect(extractTitle(text)).toEqual({ title: 'Reply', bodyStartIndex: 0 });
  });
});

describe('P1-3 body sections hold at most four tables', () => {
  test('six blank-line separated tables split across Markdown elements', () => {
    const text = Array.from(
      { length: 6 },
      (_, i) => `### 表 ${i}\n\n${table(`列${i}`)}`,
    ).join('\n');
    const sections = splitIntoBodySections(text);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.map((section) => section.text).join('')).toBe(text);
    for (const section of sections) {
      expect(countMarkdownTables(section.text)).toBeLessThanOrEqual(
        SECTION_MAX_TABLES,
      );
    }
    const elements = buildBodyChunks(text) as Array<{ content: string }>;
    for (const element of elements) {
      expect(countMarkdownTables(element.content)).toBeLessThanOrEqual(4);
    }
  });

  test('tables without blank lines between them are split too', () => {
    const text = Array.from(
      { length: 9 },
      (_, i) => `段落 ${i}\n${table(`T${i}`)}`,
    ).join('');
    expect(countMarkdownTables(text)).toBe(9);
    const sections = splitIntoBodySections(text);
    expect(sections.map((section) => section.text).join('')).toBe(text);
    expect(
      sections.map((section) => countMarkdownTables(section.text)),
    ).toEqual([4, 4, 1]);
  });

  test('tables inside fences do not count', () => {
    const fenced = `\`\`\`md\n${Array.from({ length: 6 }, (_, i) => table(`F${i}`)).join('\n')}\`\`\``;
    expect(splitIntoBodySections(fenced)).toHaveLength(1);
  });
});
