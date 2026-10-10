import { expect, test, type Locator, type Page } from '@playwright/test';

const HARNESS_PATH = '/tests/e2e/mobile-chat-harness.html';

function createMinimalPdf() {
  const pageStream = 'BT\n/F1 24 Tf\n100 700 Td\n(PDF preview) Tj\nET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(pageStream)} >>\nstream\n${pageStream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const offsets = [0];
  let pdf = '%PDF-1.4\n';
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

const MINIMAL_PDF = createMinimalPdf();

async function prepareHarness(
  page: Page,
  options: {
    role?: 'admin' | 'member';
    runtime?: 'container' | 'host';
    canModify?: boolean;
    deferPdfResponse?: boolean;
  } = {},
) {
  let markPdfRequestStarted!: () => void;
  const pdfRequestStarted = new Promise<void>((resolve) => {
    markPdfRequestStarted = resolve;
  });
  let releasePdfResponse!: () => void;
  const pdfResponseGate = new Promise<void>((resolve) => {
    releasePdfResponse = resolve;
  });

  await page.route('**/test-image.svg', async (route) => {
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="100%" height="100%" fill="#0891b2"/><text x="50%" y="50%" fill="white" text-anchor="middle">preview</text></svg>',
    });
  });
  await page.route('**/api/groups/**/files/preview/**', async (route) => {
    if (route.request().resourceType() === 'document') {
      markPdfRequestStarted();
      if (options.deferPdfResponse) await pdfResponseGate;
      await route.fulfill({
        contentType: 'application/pdf',
        body: MINIMAL_PDF,
      });
      return;
    }
    if (route.request().resourceType() === 'image') {
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="100%" height="100%" fill="#db2777"/></svg>',
      });
      return;
    }
    await route.fulfill({ status: 204 });
  });

  const query = new URLSearchParams({
    role: options.role ?? 'admin',
    runtime: options.runtime ?? 'container',
    canModify: String(options.canModify ?? true),
  });
  await page.goto(`${HARNESS_PATH}?${query}`);
  return { pdfRequestStarted, releasePdfResponse };
}

async function openContextSheet(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: '展开上下文面板' }).click();
  const sheet = page.getByTestId('mobile-context-sheet');
  await expect(sheet).toBeVisible();
  await settleAnimations(sheet);
  return sheet;
}

/** Wait for enter animations: rows of a sliding sheet are not "stable". */
async function settleAnimations(scope: Locator) {
  await scope.evaluate((element) =>
    Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

async function clickFile(sheet: Locator, fileName: string) {
  // click() scrolls into view, waits for stability and re-resolves the
  // locator if the row re-renders; a separate scrollIntoViewIfNeeded() fails
  // outright when the element is replaced mid-action on slow CI machines.
  await sheet.getByText(fileName, { exact: true }).click();
}

async function wheelInside(page: Page, scrollPane: Locator, deltaY: number) {
  const box = await scrollPane.boundingBox();
  if (!box) throw new Error('Expected scroll pane to have a bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

test('idle scroll affordance is scoped and context nav follows scroll direction', async ({
  page,
}) => {
  await prepareHarness(page);
  const sheet = await openContextSheet(page);
  const fileList = sheet.getByTestId('file-list-scroll');

  await expect(sheet.getByTestId('scroll-edge-affordance')).toBeVisible();
  await expect(sheet.getByTestId('scroll-edge-below')).toHaveAttribute(
    'data-visible',
    'true',
  );
  await expect(sheet.getByTestId('context-nav-expanded')).toHaveAttribute(
    'data-state',
    'open',
  );

  const scrollbarStyles = await fileList.evaluate((element) => {
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;width:20px;height:20px;overflow:auto;left:-9999px';
    probe.append(document.createElement('div'));
    probe.firstElementChild!.setAttribute('style', 'height:40px');
    document.body.append(probe);
    const styles = {
      pane: getComputedStyle(element).scrollbarWidth,
      unrelated: getComputedStyle(probe).scrollbarWidth,
    };
    probe.remove();
    return styles;
  });
  expect(scrollbarStyles).toEqual({ pane: 'thin', unrelated: 'auto' });

  await wheelInside(page, fileList, 180);
  await expect(sheet.getByTestId('context-nav-expanded')).toHaveAttribute(
    'data-state',
    'closed',
  );
  await expect(sheet.getByTestId('context-nav-collapsed')).toHaveAttribute(
    'data-state',
    'open',
  );
  await expect(sheet.getByTestId('scroll-edge-above')).toHaveAttribute(
    'data-visible',
    'true',
  );

  await wheelInside(page, fileList, -1000);
  await expect(sheet.getByTestId('context-nav-expanded')).toHaveAttribute(
    'data-state',
    'open',
  );
});

test('markdown preview keeps focus and scroll inside nested modal layers', async ({
  page,
}) => {
  await prepareHarness(page);
  const sheet = await openContextSheet(page);
  await clickFile(sheet, 'notes.md');

  const preview = page.getByRole('dialog', { name: '预览 notes.md' });
  await expect(preview).toBeVisible();
  const previewScroll = preview.getByTestId('markdown-preview-scroll');
  await expect
    .poll(() =>
      previewScroll.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    )
    .toBe(true);
  await wheelInside(page, previewScroll, 600);
  await expect
    .poll(() => previewScroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);

  await preview.getByRole('button', { name: '编辑', exact: true }).click();
  const textarea = preview.getByRole('textbox');
  await expect(textarea).toBeFocused();
  await preview.getByRole('button', { name: '预览', exact: true }).click();

  const imageTrigger = preview.getByRole('button', {
    name: '放大图片：测试图片',
  });
  await imageTrigger.focus();
  await imageTrigger.press('Enter');
  const lightbox = page.getByRole('dialog', { name: '图片预览' });
  await expect(lightbox).toBeVisible();
  await expect
    .poll(() =>
      lightbox.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);

  await page.keyboard.press('Escape');
  await expect(lightbox).toBeHidden();
  await expect(preview).toBeVisible();
  await expect(imageTrigger).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await expect(sheet).toBeVisible();
  await expect
    .poll(() =>
      sheet.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);

  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});

test('PDF bridge binds only after load and closes from the embedded window', async ({
  page,
}) => {
  const { pdfRequestStarted, releasePdfResponse } = await prepareHarness(page, {
    deferPdfResponse: true,
  });
  const sheet = await openContextSheet(page);
  const returnTarget = sheet.getByRole('button', { name: /manual\.pdf/ });
  await returnTarget.scrollIntoViewIfNeeded();
  await returnTarget.click();

  const preview = page.getByRole('dialog', { name: 'manual.pdf' });
  await expect(preview).toBeVisible();
  const iframe = preview.locator('iframe');

  await pdfRequestStarted;
  expect(await iframe.getAttribute('data-escape-bridge')).toBeNull();
  releasePdfResponse();
  await expect(iframe).toHaveAttribute('data-escape-bridge', 'ready');
  await iframe.focus();
  await expect(iframe).toBeFocused();

  const eventWasNotCanceled = await iframe.evaluate((element) => {
    const embeddedWindow = (element as HTMLIFrameElement).contentWindow;
    if (!embeddedWindow) throw new Error('PDF iframe has no content window');
    return embeddedWindow.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(eventWasNotCanceled).toBe(false);
  await expect(preview).toBeHidden();
  await expect(sheet).toBeVisible();
  await expect(returnTarget).toBeFocused();
});

test('direct image preview opens, traps focus, and restores it on Escape', async ({
  page,
}) => {
  await prepareHarness(page);
  const sheet = await openContextSheet(page);
  const returnTarget = sheet.getByRole('button', { name: /sample\.png/ });
  await returnTarget.scrollIntoViewIfNeeded();
  await returnTarget.click();

  const preview = page.getByRole('dialog', { name: 'sample.png' });
  await expect(preview).toBeVisible();
  await expect
    .poll(() =>
      preview
        .locator('img')
        .evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
        ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      preview.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);

  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await expect(sheet).toBeVisible();
  await expect(returnTarget).toBeFocused();
});

test('audio and video controls can take focus without escaping the sheet scope', async ({
  page,
}) => {
  await prepareHarness(page);
  const sheet = await openContextSheet(page);

  const cases = [
    { file: 'sample.mp3', dialog: '播放 sample.mp3', selector: 'audio' },
    { file: 'sample.mp4', dialog: 'sample.mp4', selector: 'video' },
  ];

  for (const item of cases) {
    await clickFile(sheet, item.file);
    const preview = page.getByRole('dialog', { name: item.dialog });
    await expect(preview).toBeVisible();
    await settleAnimations(preview);
    const media = preview.locator(item.selector);
    await expect(media).toBeAttached();
    await media.focus();
    await expect(media).toBeFocused();
    await expect
      .poll(() =>
        preview.evaluate((element) => element.contains(document.activeElement)),
      )
      .toBe(true);
    await page.keyboard.press('Escape');
    await expect(preview).toBeHidden();
    await expect(sheet).toBeVisible();
  }
});

for (const visibility of [
  {
    label: 'admin container',
    role: 'admin' as const,
    runtime: 'container' as const,
    canModify: true,
    env: true,
    terminal: true,
  },
  {
    label: 'admin host',
    role: 'admin' as const,
    runtime: 'host' as const,
    canModify: true,
    env: true,
    terminal: false,
  },
  {
    label: 'member container',
    role: 'member' as const,
    runtime: 'container' as const,
    canModify: false,
    env: false,
    terminal: true,
  },
  {
    label: 'member host',
    role: 'member' as const,
    runtime: 'host' as const,
    canModify: false,
    env: false,
    terminal: false,
  },
]) {
  test(`${visibility.label} exposes only authorized context actions`, async ({
    page,
  }) => {
    await prepareHarness(page, visibility);
    const sheet = await openContextSheet(page);
    const env = sheet.getByRole('button', { name: /工作区环境/ });
    const terminal = sheet.getByRole('button', { name: '终端' });

    if (visibility.env) await expect(env).toBeVisible();
    else await expect(env).toHaveCount(0);

    if (visibility.terminal) await expect(terminal).toBeVisible();
    else await expect(terminal).toHaveCount(0);
  });
}
