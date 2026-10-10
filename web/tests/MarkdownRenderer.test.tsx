import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  decodeMarkdownImagePath,
  resolveMarkdownImageSrc,
} from '../src/utils/markdownImageSrc';
import {
  MarkdownRenderer,
  detectMarkdownFeatures,
  needsEnhancedMarkdown,
} from '../src/components/chat/MarkdownRenderer';
import { EnhancedMarkdownRenderer } from '../src/components/chat/EnhancedMarkdownRenderer';

function renderedImageSrc(markdown: string): string {
  const html = renderToStaticMarkup(
    <MarkdownRenderer content={markdown} groupJid="test-group#agent:worker" />,
  );
  const src = html.match(/<img[^>]+src="([^"]+)"/)?.[1];
  if (!src) throw new Error(`Rendered image src not found in: ${html}`);
  return src;
}

function renderedDownloadPath(markdown: string): string {
  const src = renderedImageSrc(markdown);
  const encoded = src.split('/').at(-1);
  if (!encoded) throw new Error(`Encoded path not found in: ${src}`);
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

describe('decodeMarkdownImagePath', () => {
  it.each([
    ['images/photo.png', 'images/photo.png'],
    ['images/%E5%9B%BE%E7%89%87.png', 'images/图片.png'],
    ['images/my%20photo.png', 'images/my photo.png'],
    ['images/100%25-ready.png', 'images/100%-ready.png'],
    ['images/%ZZ-%E5%9B%BE%E7%89%87.png', 'images/%ZZ-图片.png'],
    ['images/%FF-%E5%9B%BE%E7%89%87.png', 'images/%FF-图片.png'],
    ['images/%FF%E5%9B%BE.png', 'images/%FF图.png'],
    ['images/%E5%9B%BE%FF.png', 'images/图%FF.png'],
  ])('decodes %s as %s', (input, expected) => {
    expect(decodeMarkdownImagePath(input)).toBe(expected);
  });

  it.each([
    '%21',
    '%23',
    '%24',
    '%26',
    '%27',
    '%28',
    '%29',
    '%2A',
    '%2B',
    '%2C',
    '%2F',
    '%3A',
    '%3B',
    '%3D',
    '%3F',
    '%40',
    '%5B',
    '%5D',
  ])('preserves the reserved escape %s', (escape) => {
    expect(decodeMarkdownImagePath(`before${escape}after.png`)).toBe(
      `before${escape}after.png`,
    );
  });
});

describe('resolveMarkdownImageSrc', () => {
  it.each([
    'https://example.com/image.png',
    'http://example.com/image.png',
    '//example.com/image.png',
    'data:image/png;base64,AAAA',
    '/absolute/image.png',
  ])('leaves the non-local source unchanged: %s', (src) => {
    expect(resolveMarkdownImageSrc(src, 'test-group')).toBe(src);
  });

  it('leaves a relative source unchanged without a group', () => {
    expect(resolveMarkdownImageSrc('images/photo.png')).toBe(
      'images/photo.png',
    );
  });

  it('uses the base group JID for an agent conversation', () => {
    const src = resolveMarkdownImageSrc(
      'images/photo.png',
      'group@example#agent:researcher',
    );
    expect(src).toContain('/api/groups/group%40example/files/download/');
    expect(src).not.toContain('agent');
  });
});

describe('MarkdownRenderer local image paths through react-markdown/micromark', () => {
  it('resolves a plain Chinese filename to its real UTF-8 path', () => {
    expect(renderedDownloadPath('![截图](images/图片.png)')).toBe(
      'images/图片.png',
    );
  });

  it('resolves spaces and literal percent signs after micromark encoding', () => {
    expect(renderedDownloadPath('![截图](images/100%-完成%20截图.png)')).toBe(
      'images/100%-完成 截图.png',
    );
  });

  it('keeps a literal invalid percent escape while decoding Chinese text', () => {
    expect(renderedDownloadPath('![截图](images/%ZZ-图片.png)')).toBe(
      'images/%ZZ-图片.png',
    );
  });

  it('does not turn a percent-encoded reserved slash into a path separator', () => {
    expect(renderedDownloadPath('![截图](dir%2F图片.png)')).toBe(
      'dir%2F图片.png',
    );
  });

  it('strips the agent suffix from the download route', () => {
    expect(renderedImageSrc('![截图](images/photo.png)')).toContain(
      '/api/groups/test-group/files/download/',
    );
  });
});

describe('MarkdownRenderer progressive enhancement', () => {
  it('keeps ordinary Markdown and autolinks on the basic path', () => {
    const plain = detectMarkdownFeatures(
      '普通 **Markdown** 与 <https://example.com> 链接',
    );
    expect(plain).toEqual({
      hasMath: false,
      hasCodeFence: false,
      hasRawHtml: false,
    });
    expect(needsEnhancedMarkdown(plain, false)).toBe(false);
  });

  it('detects code fences, block math, and raw HTML', () => {
    expect(detectMarkdownFeatures('```ts\nconst value = 1\n```')).toMatchObject(
      {
        hasCodeFence: true,
      },
    );
    expect(detectMarkdownFeatures('$$x^2$$')).toMatchObject({ hasMath: true });
    expect(detectMarkdownFeatures('<strong>内容</strong>')).toMatchObject({
      hasRawHtml: true,
    });
  });

  it('defers math and raw HTML until streaming settles', () => {
    expect(needsEnhancedMarkdown(detectMarkdownFeatures('$$x^2$$'), true)).toBe(
      false,
    );
    expect(
      needsEnhancedMarkdown(
        detectMarkdownFeatures('<strong>内容</strong>'),
        true,
      ),
    ).toBe(false);
    expect(
      needsEnhancedMarkdown(
        detectMarkdownFeatures('```ts\nconst value = 1\n```'),
        true,
      ),
    ).toBe(true);
  });

  it('marks the lazy fallback so share-image export waits for enhancement', () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer content={'```ts\nconst value = 1\n```'} />,
    );
    expect(html).toContain('data-markdown-pending="true"');
  });

  it('retains syntax highlighting on the enhanced path', () => {
    const content = '```ts\nconst value: number = 1\n```';
    const html = renderToStaticMarkup(
      <EnhancedMarkdownRenderer
        content={content}
        features={detectMarkdownFeatures(content)}
      />,
    );
    expect(html).toContain('hljs-keyword');
  });

  it('retains KaTeX rendering and sanitizes raw HTML', () => {
    const content = '$$x^2$$\n\n<strong>保留</strong><script>alert(1)</script>';
    const html = renderToStaticMarkup(
      <EnhancedMarkdownRenderer
        content={content}
        features={detectMarkdownFeatures(content)}
      />,
    );
    expect(html).toContain('class="katex"');
    expect(html).toContain('<strong>保留</strong>');
    expect(html).not.toContain('<script');
    // A tag outside the allowlist stays visible, inert text (like GFM's
    // tagfilter) instead of vanishing, matching the streaming view.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('MarkdownRenderer rendered-tree cache', () => {
  it('renders repeated content the same and keys it by group and image mode', () => {
    const content = '![截图](images/photo.png)';
    const render = (props: { groupJid: string; eagerImages?: boolean }) =>
      renderToStaticMarkup(<MarkdownRenderer content={content} {...props} />);

    expect(render({ groupJid: 'group-a' })).toBe(
      render({ groupJid: 'group-a' }),
    );
    expect(render({ groupJid: 'group-a' })).toContain(
      '/api/groups/group-a/files/download/',
    );
    expect(render({ groupJid: 'group-b' })).toContain(
      '/api/groups/group-b/files/download/',
    );
    expect(render({ groupJid: 'group-a' })).toContain('loading="lazy"');
    expect(render({ groupJid: 'group-a', eagerImages: true })).toContain(
      'loading="eager"',
    );
  });

  it('keeps the plugin set in the key for identical text', () => {
    const content = '$$x^2$$';
    const basic = renderToStaticMarkup(
      <EnhancedMarkdownRenderer
        content={content}
        features={{ hasMath: false, hasCodeFence: false, hasRawHtml: false }}
      />,
    );
    const math = renderToStaticMarkup(
      <EnhancedMarkdownRenderer
        content={content}
        features={detectMarkdownFeatures(content)}
      />,
    );
    expect(basic).not.toContain('class="katex"');
    expect(math).toContain('class="katex"');
  });
});
