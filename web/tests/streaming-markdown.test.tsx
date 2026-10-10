import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  FinalMarkdown,
  StreamingMarkdown,
} from '../src/components/chat/StreamingMarkdown';
import { MarkdownRenderer } from '../src/components/chat/MarkdownRenderer';

const streamed = (content: string) =>
  renderToStaticMarkup(<StreamingMarkdown content={content} />);
const finished = (content: string) =>
  renderToStaticMarkup(<FinalMarkdown content={content} />);

describe('StreamingMarkdown', () => {
  it('resolves a reference link whose definition is in another block', () => {
    const html = streamed(
      '参见[文档][ref]。\n\n[ref]: https://example.com/doc\n\n继续输出',
    );
    expect(html).toContain('href="https://example.com/doc"');
    expect(html).not.toContain('[文档][ref]');
  });

  it('shows a footnote definition as text until the reply is final', () => {
    const html = streamed('结论[^1]。\n\n[^1]: 脚注内容\n\n继续');
    expect(html).toContain('[^1]: 脚注内容');
    expect(finished('结论[^1]。\n\n[^1]: 脚注内容')).toContain(
      'data-footnotes',
    );
  });

  it('adds the rows of an open table as they complete', () => {
    const table =
      '| 名称 | 值 |\n| --- | --- |\n| alpha | beta |\n| gamma | del';
    const html = streamed(table);
    expect(html).toContain('alpha');
    expect(html).not.toContain('gamma');
    expect(streamed(`${table}ta |\n`)).toContain('gamma');
  });

  it('marks where the reply continues only when asked', () => {
    expect(
      renderToStaticMarkup(<StreamingMarkdown content="正在写" caret />),
    ).toContain('data-streaming-caret="true"');
    expect(streamed('正在写')).not.toContain('data-streaming-caret');
  });
});

describe('FinalMarkdown', () => {
  it('renders a reply block by block like its stream', () => {
    const reply = '# 标题\n\n第一段。\n\n- 列表项\n- 第二项\n\n最后一段。';
    const html = finished(reply);
    expect(html.match(/data-markdown-root=""/g)).toHaveLength(4);
    for (const text of ['标题', '第一段。', '第二项', '最后一段。']) {
      expect(html).toContain(text);
    }
  });

  it('renders a reply with cross-block definitions as one document', () => {
    const html = finished('参见[文档][ref]。\n\n[ref]: https://example.com');
    expect(html.match(/data-markdown-root=""/g)).toHaveLength(1);
    expect(html).toContain('href="https://example.com"');
  });
});

/**
 * The rendered Markdown without what differs by construction and not in
 * layout: one `data-markdown-root` per block (and Suspense fallback
 * wrappers) versus one for the document, and the whitespace-only text
 * between top-level blocks.
 */
function withoutRenderRoots(html: string): string {
  const stack: boolean[] = [];
  let out = '';
  let inPre = 0;
  for (const token of html.match(/<\/?[a-zA-Z][^>]*>|[^<]+/g) ?? []) {
    if (/^<pre[\s>]/.test(token)) inPre += 1;
    else if (token === '</pre>') inPre -= 1;
    if (/^<div[\s>]/.test(token)) {
      const drop =
        token.includes('data-markdown-root') ||
        token.includes('data-markdown-pending');
      stack.push(drop);
      if (!drop) out += token;
    } else if (token === '</div>') {
      if (!stack.pop()) out += token;
    } else if (inPre > 0 || token.trim() || token.startsWith('<')) {
      out += token;
    }
  }
  return out;
}

const KITCHEN_SINK = [
  '# 一级标题',
  '',
  '段落里有 **粗体**、*斜体*、`<br>` 这样的行内代码和 [链接](https://example.com)。',
  '',
  'Setext 标题',
  '----------',
  '',
  '- 第一项',
  '  - 嵌套项',
  '- 第二项',
  '',
  '- 松散列表第一段。',
  '',
  '  同一项的第二段。',
  '',
  '1. 安装依赖',
  '',
  '```bash',
  'npm ci',
  '',
  'echo "<div>not html</div>"',
  '```',
  '',
  '2. 启动服务',
  '',
  '> 引用里的 **重点**',
  '>',
  '> - 引用中的列表',
  '',
  '| 方案 | 次数 |',
  '| --- | ---: |',
  '| 整 store | 120 |',
  '| 窄 selector | 3 |',
  '',
  '---',
  '',
  '- [x] 已完成',
  '- [ ] 未完成',
  '',
  '```tsx',
  'export function A() {',
  '  return <div className="row"><br /></div>;',
  '}',
  '```',
  '',
  '$$',
  'a + b',
  '',
  '= c',
  '$$',
  '',
  '结尾段落。',
].join('\n');

describe('block-wise final rendering', () => {
  it('renders the same Markdown as the whole document', () => {
    const blockwise = finished(KITCHEN_SINK);
    // HTML in code is not raw HTML: the reply really renders block-wise.
    expect(blockwise.match(/data-markdown-root=""/g)!.length).toBeGreaterThan(
      10,
    );
    const whole = renderToStaticMarkup(
      <MarkdownRenderer content={KITCHEN_SINK} />,
    );
    expect(withoutRenderRoots(blockwise)).toBe(withoutRenderRoots(whole));
  });
});
