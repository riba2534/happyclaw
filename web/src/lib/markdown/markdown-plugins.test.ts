import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, RootContent } from 'mdast';
import { REMARK_BASE } from './pipeline';
import { cjkAutolinkCut } from './remark-cjk-autolink';
import { RAW_HTML_PATTERN, isMarkdownHtmlTag } from './html-tags';

function parse(markdown: string): Root {
  const processor = unified().use(remarkParse);
  for (const plugin of REMARK_BASE) processor.use(plugin as never);
  return processor.runSync(processor.parse(markdown)) as Root;
}

/** Flatten a tree to `type:value` / `link(url)` tokens for assertions. */
function tokens(nodes: RootContent[]): string[] {
  return nodes.flatMap((node) => {
    if (node.type === 'link')
      return [`link(${node.url})`, ...tokens(node.children)];
    if ('value' in node) return [`${node.type}:${node.value}`];
    if ('children' in node)
      return [node.type, ...tokens(node.children as RootContent[])];
    return [node.type];
  });
}

describe('cjkAutolinkCut', () => {
  it.each([
    ['https://claw.riba2534.cn/chat，后面是中文。带', 29],
    ['https://example.com/docs查看文档', 24],
    ['https://example.com/a”后面', 21],
    ['https://example.com/a——后面', 21],
  ])('cuts %s at %i', (text, index) => {
    expect(cjkAutolinkCut(text)).toBe(index);
  });

  it.each([
    'https://react.dev/learn',
    'https://zh.wikipedia.org/wiki/北京市',
    'https://example.com/search?q=中文',
    'https://example.com/#章节',
  ])('keeps %s whole', (text) => {
    expect(cjkAutolinkCut(text)).toBe(-1);
  });
});

describe('remarkCjkAutolink', () => {
  it('ends a literal autolink before full-width punctuation', () => {
    const tree = parse('见 https://claw.riba2534.cn/chat，后面是中文。');
    expect(tokens(tree.children)).toEqual([
      'paragraph',
      'text:见 ',
      'link(https://claw.riba2534.cn/chat)',
      'text:https://claw.riba2534.cn/chat',
      'text:，后面是中文。',
    ]);
  });

  it('ends a www. autolink before Chinese text and keeps its scheme', () => {
    const tree = parse('打开 www.example.com/docs查看');
    expect(tokens(tree.children)).toContain(
      'link(http://www.example.com/docs)',
    );
    expect(tokens(tree.children)).toContain('text:查看');
  });

  it('drops trailing ASCII punctuation exposed by the cut', () => {
    const tree = parse('地址 https://example.com/a.，下一句');
    expect(tokens(tree.children)).toContain('link(https://example.com/a)');
    expect(tokens(tree.children)).toContain('text:.，下一句');
  });

  it('leaves explicit links alone', () => {
    const tree = parse('[文档](https://example.com/中文，路径)');
    expect(tokens(tree.children)).toContain(
      'link(https://example.com/中文，路径)',
    );
  });
});

describe('remarkLiteralHtml', () => {
  it('keeps unknown inline tags as text', () => {
    const tree = parse('返回 Promise<void>，泛型 Array<string>。');
    expect(tokens(tree.children)).toEqual([
      'paragraph',
      'text:返回 Promise',
      'text:<void>',
      'text:，泛型 Array',
      'text:<string>',
      'text:。',
    ]);
  });

  it('keeps allowlisted inline tags and comments as HTML', () => {
    const tree = parse('按 <kbd>Ctrl</kbd> <!-- note -->');
    expect(tokens(tree.children)).toContain('html:<kbd>');
    expect(tokens(tree.children)).toContain('html:</kbd>');
    expect(tokens(tree.children)).toContain('html:<!-- note -->');
  });

  it('turns an HTML block of unknown tags into a paragraph', () => {
    const tree = parse('<script>alert(1)</script>');
    expect(tree.children[0].type).toBe('paragraph');
  });
});

describe('CJK-friendly emphasis', () => {
  it('closes ** after full-width punctuation followed by Han text', () => {
    const tree = parse('**注意：**正文，以及 **“引号包裹”**的粗体');
    expect(tokens(tree.children)).toEqual([
      'paragraph',
      'strong',
      'text:注意：',
      'text:正文，以及 ',
      'strong',
      'text:“引号包裹”',
      'text:的粗体',
    ]);
  });

  it('closes ~~ after full-width punctuation', () => {
    const tree = parse('~~（已废弃）~~接口');
    expect(tokens(tree.children)).toEqual([
      'paragraph',
      'delete',
      'text:（已废弃）',
      'text:接口',
    ]);
  });
});

describe('raw HTML detection', () => {
  it('only matches tags the sanitizer keeps', () => {
    expect(RAW_HTML_PATTERN.test('Promise<void> Array<string>')).toBe(false);
    expect(RAW_HTML_PATTERN.test('<!DOCTYPE html>')).toBe(false);
    expect(RAW_HTML_PATTERN.test('按 <kbd>K</kbd>')).toBe(true);
    expect(RAW_HTML_PATTERN.test('第一行<br>第二行')).toBe(true);
    expect(RAW_HTML_PATTERN.test('<br/>')).toBe(true);
    expect(RAW_HTML_PATTERN.test('<details open>')).toBe(true);
    expect(RAW_HTML_PATTERN.test('<!-- hidden -->')).toBe(true);
    expect(RAW_HTML_PATTERN.test('<bread>')).toBe(false);
  });

  it('is case-insensitive like HTML', () => {
    expect(isMarkdownHtmlTag('DETAILS')).toBe(true);
    expect(isMarkdownHtmlTag('script')).toBe(false);
    expect(isMarkdownHtmlTag('style')).toBe(false);
  });
});
