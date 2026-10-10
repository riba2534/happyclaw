import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  MarkdownRenderer,
  detectMarkdownFeatures,
} from '../src/components/chat/MarkdownRenderer';
import { EnhancedMarkdownRenderer } from '../src/components/chat/EnhancedMarkdownRenderer';
import { RawMarkdownRenderer } from '../src/components/chat/RawMarkdownRenderer';
import { CodeMarkdownRenderer } from '../src/components/chat/CodeMarkdownRenderer';
import { MathMarkdownRenderer } from '../src/components/chat/MathMarkdownRenderer';
import { MarkdownContent } from '../src/components/chat/MarkdownContent';
import { REMARK_BASE } from '../src/lib/markdown/pipeline';
import { resolveMarkdownLinkHref } from '../src/utils/markdownImageSrc';

/** Render `content` the way a settled reply picks its pipeline. */
function settled(content: string, groupJid?: string): string {
  return renderToStaticMarkup(
    <EnhancedMarkdownRenderer
      content={content}
      groupJid={groupJid}
      features={detectMarkdownFeatures(content)}
    />,
  );
}

function basic(content: string, props: { trimEdges?: boolean } = {}): string {
  return renderToStaticMarkup(
    <MarkdownContent
      content={content}
      remarkPlugins={REMARK_BASE}
      rehypePlugins={[]}
      pipeline="test-basic"
      {...props}
    />,
  );
}

const OVERLAY_PROBE = [
  '<div style="position:fixed;inset:0;z-index:9999;background:rgba(220,38,38,.35)" data-sanitize-probe="overlay"><a href="https://example.com/phish">全屏覆盖层</a></div>',
  '',
  '<div class="fixed inset-0 z-50 bg-primary/40"><a href="https://example.com/phish">点我继续</a></div>',
  '',
  '<span class="fixed top-0" style="position:fixed">span 探针</span> 与 <code class="language-ts fixed inset-0">code</code>',
].join('\n');

describe('sanitizing raw HTML (P0-1)', () => {
  // Every pipeline that accepts raw HTML: plain, with code, with math, both.
  const variants: Record<string, string> = {
    raw: OVERLAY_PROBE,
    'raw+code': `${OVERLAY_PROBE}\n\n\`\`\`ts\nconst a = 1;\n\`\`\``,
    'raw+math': `${OVERLAY_PROBE}\n\n$$\\sqrt{2}$$`,
    'raw+code+math': `${OVERLAY_PROBE}\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n\n$$\\sqrt{2}$$`,
  };

  it.each(Object.entries(variants))(
    'strips user class and style on the %s pipeline',
    (_name, content) => {
      const html = settled(content);
      expect(html).toContain('全屏覆盖层');
      expect(html).toContain('点我继续');
      expect(html).not.toMatch(/position:\s*fixed/);
      expect(html).not.toMatch(/class="[^"]*\b(?:fixed|inset-0|z-50)\b/);
      expect(html).not.toContain('data-sanitize-probe');
      expect(html).not.toContain('z-index');
    },
  );

  it('keeps only pipeline classes on code', () => {
    const html = settled(OVERLAY_PROBE);
    expect(html).not.toMatch(/class="[^"]*language-ts/);
    const block = settled(
      '<pre><code class="language-ts fixed">x</code></pre>',
    );
    expect(block).toContain('language-ts');
    expect(block).not.toMatch(/class="[^"]*\bfixed\b/);
  });

  it('applies the same schema to Skill READMEs (docs variant)', () => {
    const html = renderToStaticMarkup(
      <RawMarkdownRenderer content={OVERLAY_PROBE} variant="docs" />,
    );
    expect(html).not.toMatch(/position:\s*fixed/);
    expect(html).not.toMatch(/class="[^"]*\bfixed\b/);
  });

  it('keeps script and style inert as visible text', () => {
    const html = settled(
      '<kbd>K</kbd>\n\n<script>window.x = 1</script>\n\n<style>body{display:none}</style>\n\n<img src="x" onerror="window.y=1">',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('onerror');
    expect(html).toContain('&lt;script&gt;window.x = 1&lt;/script&gt;');
  });
});

describe('KaTeX after sanitizing (P0-2)', () => {
  it('keeps the \\sqrt SVG when the reply also has code and HTML', () => {
    const content =
      '双美元行内 $$\\sqrt{x^2 + 1}$$\n\n```ts\nconst a = 1;\n```\n\n<kbd>K</kbd>';
    const html = settled(content);
    expect(html).toContain('class="katex"');
    expect(html).toMatch(/<span class="katex[^"]*">[\s\S]*<svg/);
    expect(html).toContain('hljs-keyword');
  });

  it('renders the same root sign as the math-only pipeline', () => {
    const content = '$$\\frac{\\sqrt{\\pi}}{2}$$';
    // KaTeX's root-sign SVG (lucide icons do not set this attribute).
    const svgCount = (html: string) =>
      html.split('preserveAspectRatio="xMinYMin slice"').length - 1;
    const mathOnly = renderToStaticMarkup(
      <MathMarkdownRenderer content={content} />,
    );
    const withCode = settled(`${content}\n\n\`\`\`\nx\n\`\`\``);
    expect(svgCount(mathOnly)).toBeGreaterThan(0);
    expect(svgCount(withCode)).toBe(svgCount(mathOnly));
  });

  it('marks display math as a horizontal scroller', () => {
    const html = settled('$$\nf(x) = a_0 + a_1 x\n$$\n\n```\nx\n```');
    expect(html).toMatch(
      /class="katex-display"[^>]*data-swipe-back-ignore="true"|data-swipe-back-ignore="true"[^>]*class="katex-display"/,
    );
  });

  it('caps user-specified sizes', () => {
    const html = settled('$$\\rule{999em}{999em}$$');
    expect(html).not.toMatch(/style="[^"]*999em/);
    expect(html).toContain('border-top-width:20em');
  });
});

describe('literal <word> text (P1-8)', () => {
  const sentence = '返回值类型是 Promise<void>，泛型写作 Array<string>。';

  it('does not route generic types to the raw-HTML pipeline', () => {
    expect(detectMarkdownFeatures(sentence).hasRawHtml).toBe(false);
  });

  it('renders the same text streaming and settled', () => {
    const streaming = renderToStaticMarkup(
      <MarkdownRenderer content={sentence} streaming />,
    );
    const final = renderToStaticMarkup(<MarkdownRenderer content={sentence} />);
    expect(streaming).toContain('Promise&lt;void&gt;');
    expect(final).toContain('Promise&lt;void&gt;');
    expect(final).toContain('Array&lt;string&gt;');
  });

  it('keeps unknown tags inside allowlisted HTML as text', () => {
    const html = settled(
      '<details>\n<summary>返回 Promise<void></summary>\n\n正文\n\n</details>\n\n按 <kbd>K</kbd> 得到 Map<K>',
    );
    expect(html).toContain('<summary');
    expect(html).toContain('返回 Promise&lt;void&gt;');
    expect(html).toContain('<kbd');
    expect(html).toContain('Map&lt;K&gt;');
  });
});

describe('element rendering', () => {
  it('renders CJK-friendly bold on the basic path (P1-1)', () => {
    const html = basic('**注意：**中文标点后紧跟正文');
    expect(html).toContain('<strong>注意：</strong>中文标点后紧跟正文');
  });

  it('cuts a bare URL at Chinese punctuation (P1-2)', () => {
    const html = basic('见 https://claw.riba2534.cn/chat，后面是中文。');
    expect(html).toContain('href="https://claw.riba2534.cn/chat"');
    expect(html).toContain('</a>，后面是中文。');
  });

  it('keeps an ordered list number after an interrupting code block (P1-4)', () => {
    const html = renderToStaticMarkup(
      <CodeMarkdownRenderer
        content={
          '1. 安装依赖\n\n```bash\nnpm ci\n```\n\n2. 启动服务\n3. 打开浏览器'
        }
      />,
    );
    expect(html).toContain('<ol start="2"');
  });

  it('keeps loose list paragraphs as blocks and right-aligns nested markers (P1-4)', () => {
    const html = basic('1. 第一段。\n\n   第二段。\n\n- a\n  - b');
    expect(html).not.toContain('[&amp;&gt;p]:inline');
    expect(html).toMatch(/<li class="[^"]*\[&amp;&gt;p\]:my-1/);
    expect(html).toContain('[ul_&amp;]:list-[circle]');
  });

  it('styles h4-h6 (P1-5)', () => {
    const html = basic('#### 四\n\n##### 五\n\n###### 六');
    expect(html).toMatch(/<h4[^>]*class="[^"]*font-semibold/);
    expect(html).toMatch(/<h5[^>]*class="[^"]*font-semibold/);
    expect(html).toMatch(/<h6[^>]*class="[^"]*font-semibold/);
  });

  it('renders a one-line fence without language as a block, without nested pre (P1-6)', () => {
    const html = renderToStaticMarkup(
      <CodeMarkdownRenderer content={'```\nnpm install --save-dev x\n```'} />,
    );
    expect(html).toContain('aria-label="复制代码"');
    expect(html).toContain('>text</span>');
    expect(html).not.toMatch(/<pre[^>]*>(?:(?!<\/pre>)[\s\S])*<pre/);
    expect(html).toMatch(/<pre[^>]*data-swipe-back-ignore="true"/);
  });

  it('reads languages such as c++ and objective-c (P1-6)', () => {
    const cpp = renderToStaticMarkup(
      <CodeMarkdownRenderer content={'```c++\nint main() {}\n```'} />,
    );
    expect(cpp).toContain('>c++</span>');
    const objc = renderToStaticMarkup(
      <CodeMarkdownRenderer content={'```objective-c\n@end\n```'} />,
    );
    expect(objc).toContain('>objective-c</span>');
  });

  it('passes table alignment through and lets cells wrap (P1-3)', () => {
    const html = basic('| a | b | c |\n| --- | ---: | :---: |\n| 1 | 2 | 3 |');
    expect(html).toContain('style="text-align:right"');
    expect(html).toContain('style="text-align:center"');
    expect(html).not.toContain('text-left');
    expect(html).toMatch(/<td[^>]*class="[^"]*whitespace-normal/);
  });

  it('resolves workspace links and keeps anchors in page (P1-11, P2-3)', () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer
        content={
          '[报告](output/report.md) 和 [外链](https://react.dev) 与 [小节](#install)'
        }
        groupJid="web:group#agent:writer"
      />,
    );
    const report = /<a[^>]*href="([^"]+)"[^>]*>报告/.exec(html)?.[1] ?? '';
    expect(report).toMatch(/^\/api\/groups\/web%3Agroup\/files\/preview\//);
    expect(
      Buffer.from(report.split('/').at(-1)!, 'base64url').toString('utf8'),
    ).toBe('output/report.md');
    expect(html).toMatch(/<a[^>]*href="#install"(?![^>]*target)[^>]*>小节/);
    expect(html).toMatch(/href="https:\/\/react.dev"[^>]*target="_blank"/);
  });

  it('renders footnotes with a hidden Chinese label and stable ids (P2-3)', () => {
    const content = '引用[^1]。\n\n[^1]: 脚注内容。';
    for (const html of [
      basic(content),
      settled(`${content}\n\n<kbd>K</kbd>`),
    ]) {
      expect(html).toMatch(/<h2[^>]*class="sr-only"[^>]*>脚注<\/h2>/);
      expect(html).not.toContain('Footnotes');
      const ref = /<a [^>]*data-footnote-ref[^>]*>/.exec(html)?.[0] ?? '';
      expect(ref).toContain('href="#user-content-fn-1"');
      expect(ref).not.toContain('target=');
      // Sanitized HTML gains a second `user-content-` prefix; the in-page
      // click handler looks the target up with and without it.
      expect(html).toMatch(/<li id="(?:user-content-)?user-content-fn-1"/);
      expect(html).not.toMatch(/data-footnote-ref[^>]*target="_blank"/);
    }
  });

  it('keeps data: images and titles consistently (P2-7)', () => {
    const svg = 'data:image/svg+xml;base64,PHN2Zy8+';
    const markdown = `![图](${svg} "说明") ![坏](data:text/html,<b>x</b>)`;
    for (const html of [
      basic(markdown),
      settled(`${markdown}\n\n<kbd>K</kbd>`),
    ]) {
      expect(html).toContain(`src="${svg}"`);
      expect(html).toContain('title="说明"');
      expect(html).not.toContain('data:text/html');
    }
  });

  it('styles kbd, details and hr (P2-6)', () => {
    const html = settled(
      '按 <kbd>K</kbd>\n\n<details><summary>更多</summary>\n\n正文\n\n</details>\n\n---',
    );
    expect(html).toMatch(/<kbd class="[^"]*font-mono/);
    expect(html).toMatch(/<details class="[^"]*border/);
    expect(html).toMatch(/<hr class="[^"]*my-6/);
  });

  it('trims edge margins unless the caller renders several parts (P2-4)', () => {
    expect(basic('段落')).toContain('[&amp;&gt;*:first-child]:mt-0');
    expect(basic('段落', { trimEdges: false })).not.toContain(
      '[&amp;&gt;*:first-child]:mt-0',
    );
    expect(
      renderToStaticMarkup(
        <MarkdownRenderer content={'```ts\nx\n```'} trimEdges={false} />,
      ),
    ).not.toContain('first-child]:mt-0');
  });
});

describe('resolveMarkdownLinkHref', () => {
  it.each([
    'https://example.com/a.md',
    'mailto:me@example.com',
    '//cdn.example.com/x.md',
    '/absolute/x.md',
    '#user-content-fn-1',
  ])('leaves %s unchanged', (href) => {
    expect(resolveMarkdownLinkHref(href, 'web:group')).toBe(href);
  });

  it('drops the fragment and query from workspace files', () => {
    const href = resolveMarkdownLinkHref('docs/报告.md#结论', 'web:group');
    expect(
      Buffer.from(href.split('/').at(-1)!, 'base64url').toString('utf8'),
    ).toBe('docs/报告.md');
  });

  it('leaves relative links unchanged without a workspace', () => {
    expect(resolveMarkdownLinkHref('docs/a.md')).toBe('docs/a.md');
  });
});
