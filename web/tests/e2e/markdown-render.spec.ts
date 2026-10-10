import { expect, test, type Locator, type Page } from '@playwright/test';

const HARNESS_PATH = '/tests/e2e/chat-render-harness.html';

async function openMarkdown(page: Page, query = '') {
  await page.goto(`${HARNESS_PATH}?scenario=markdown${query}`);
  const sink = page
    .locator('.group', { has: page.locator('h1', { hasText: '一级标题' }) })
    .first();
  await expect(sink.locator('h2', { hasText: '代码' })).toBeVisible();
  // The lazy pipelines replace the basic fallback once loaded.
  await expect(page.locator('[data-markdown-pending]')).toHaveCount(0);
  return sink;
}

/** Append a settled assistant reply to the transcript. */
async function appendReply(page: Page, content: string) {
  await page.evaluate((text) => {
    (
      window as unknown as {
        markdownHarness: { finish(content: string): void };
      }
    ).markdownHarness.finish(text);
  }, content);
}

/** Whether the element or any ancestor is fixed-positioned. */
function fixedInChain(locator: Locator) {
  return locator.evaluate((element) => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (getComputedStyle(node).position === 'fixed') return true;
    }
    return false;
  });
}

test.describe('chat Markdown rendering', () => {
  test('raw HTML cannot lay a fixed overlay over the conversation', async ({
    page,
  }) => {
    const sink = await openMarkdown(page);
    const probe = sink.getByRole('link', {
      name: '全屏覆盖层（style 注入探针）',
    });
    await expect(probe).toBeVisible();
    expect(await fixedInChain(probe)).toBe(false);
    expect(
      await sink.evaluate(
        (root) =>
          [...root.querySelectorAll('*')].filter(
            (element) => getComputedStyle(element).position === 'fixed',
          ).length,
      ),
    ).toBe(0);

    await appendReply(
      page,
      'class 注入探针：\n\n<div class="fixed inset-0 z-50 bg-primary/40"><a href="https://example.com/phish">点我继续</a></div>\n\n<span class="fixed top-0 left-0" style="position:fixed">span 探针</span>',
    );
    const injected = page.getByRole('link', { name: '点我继续' });
    await expect(injected).toBeVisible();
    expect(await fixedInChain(injected)).toBe(false);
    expect(await fixedInChain(page.getByText('span 探针'))).toBe(false);
    await expect(page.locator('[data-markdown-root] .fixed')).toHaveCount(0);

    // Nothing intercepts clicks on the message's own controls.
    const code = sink
      .locator('.group\\/code', { hasText: 'interface StreamingState' })
      .first();
    await code.scrollIntoViewIfNeeded();
    await code.getByRole('button', { name: '复制代码' }).click();
    await expect(
      code.getByRole('button', { name: '已复制代码' }),
    ).toBeVisible();
  });

  test('KaTeX keeps the root sign in a reply that also has code', async ({
    page,
  }) => {
    const sink = await openMarkdown(page);
    await expect(sink.locator('.group\\/code').first()).toBeVisible();
    const formula = sink.locator('.katex', { hasText: 'x2+1' }).first();
    await expect(formula).toBeVisible();
    await expect(formula.locator('svg')).toHaveCount(1);
    expect(await sink.locator('.katex svg').count()).toBeGreaterThanOrEqual(2);
  });

  test('text, lists and links parse like the reply was written', async ({
    page,
  }) => {
    const sink = await openMarkdown(page);

    // `<word>` that is not HTML stays literal.
    await expect(
      sink.getByText('返回值类型是 Promise<void>，泛型写作 Array<string>。', {
        exact: false,
      }),
    ).toBeVisible();

    // CJK-friendly emphasis after full-width punctuation.
    await expect(sink.locator('strong', { hasText: '注意：' })).toBeVisible();
    await expect(
      sink.locator('strong', { hasText: '“引号包裹”' }),
    ).toBeVisible();
    await expect(sink.getByText('**注意：**')).toHaveCount(0);

    // A bare URL ends at the Chinese comma.
    const bare = sink.getByRole('link', {
      name: 'https://claw.riba2534.cn/chat',
      exact: true,
    });
    await expect(bare).toHaveAttribute('href', 'https://claw.riba2534.cn/chat');

    // Ordered list numbering survives an interrupting code block.
    const second = sink.locator('ol', { hasText: '启动开发服务' }).first();
    await expect(second).toHaveAttribute('start', '2');
    const third = sink.locator('ol', { hasText: '打开浏览器访问' }).first();
    await expect(third).toHaveAttribute('start', '3');

    // Workspace-relative links open the file preview, not an SPA route.
    await expect(sink.getByRole('link', { name: 'report.md' })).toHaveAttribute(
      'href',
      /^\/api\/groups\/web%3Arender-harness\/files\/preview\//,
    );
  });

  test('footnote references jump within the message', async ({
    page,
    context,
  }) => {
    const sink = await openMarkdown(page);
    const url = page.url();
    const reference = sink.locator('sup a[data-footnote-ref]').first();
    await reference.scrollIntoViewIfNeeded();
    const pages = context.pages().length;
    await reference.click();
    await expect(
      sink.locator('li[id$="fn-1"]', { hasText: '第一个脚注的内容' }),
    ).toBeInViewport();
    expect(context.pages().length).toBe(pages);
    expect(page.url()).toBe(url);
    await expect(sink.locator('section[data-footnotes] h2')).toHaveClass(
      /sr-only/,
    );
  });

  test('code copy reports failure instead of claiming success', async ({
    page,
  }) => {
    const sink = await openMarkdown(page);
    await page.evaluate(() => {
      Object.defineProperty(Navigator.prototype, 'clipboard', {
        get: () => undefined,
        configurable: true,
      });
      document.execCommand = () => false;
    });
    const code = sink
      .locator('.group\\/code', { hasText: 'interface StreamingState' })
      .first();
    await code.scrollIntoViewIfNeeded();
    await code.getByRole('button', { name: '复制代码' }).click();
    await expect(page.getByText('复制失败，请手动选择文本复制')).toBeVisible();
    await expect(code.getByRole('button', { name: '复制代码' })).toHaveText(
      '复制',
    );
  });

  test('wide tables hint at horizontal scrolling and keep alignment', async ({
    page,
  }) => {
    const sink = await openMarkdown(page);
    const wide = sink
      .locator('[data-scroll-fade]', { hasText: '列 12 Column' })
      .first();
    await wide.scrollIntoViewIfNeeded();
    await expect(wide).toHaveAttribute('data-scroll-fade', 'end');
    await wide.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect(wide).toHaveAttribute('data-scroll-fade', 'start');

    const count = sink.locator('th', { hasText: '次数' });
    await expect(count).toHaveCSS('text-align', 'right');
  });

  test('Mermaid uses the dark theme with SVG labels in dark mode', async ({
    page,
  }) => {
    const sink = await openMarkdown(page, '&theme=dark');
    const diagram = sink.locator('svg[id^="mermaid-"]').first();
    await diagram.scrollIntoViewIfNeeded();
    await expect(diagram).toBeVisible();
    await expect(diagram.locator('foreignObject')).toHaveCount(0);
    await expect(diagram.locator('text', { hasText: '否' })).toHaveCount(1);
    const stroke = await diagram
      .locator('path.flowchart-link')
      .first()
      .evaluate((path) => getComputedStyle(path).stroke);
    const [r, g, b] = stroke.match(/\d+/g)!.map(Number);
    // Edges must stand out on the dark canvas.
    expect((r + g + b) / 3).toBeGreaterThan(150);
  });
});
