import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  FinalMarkdown,
  StreamingMarkdown,
} from '../src/components/chat/StreamingMarkdown';

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
