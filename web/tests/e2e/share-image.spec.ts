import { expect, test, type Page } from '@playwright/test';

// The share-image dialog over the share-image harness. On a phone the card is
// laid out at 390px and exported at 3x while that shows the whole reply at
// no less than the 720 card's 2x; longer replies fall back to the 720 card.
// A reply cut on any card fades out above the footer instead of running
// over it.

const PHONE_QUERY = '(max-width: 1023px) and (pointer: coarse)';

interface Export {
  phone: boolean;
  viewportWidth: number;
  dialogWidth: number;
  cardWidth: number;
  imageWidth: number;
  clipped: boolean;
  faded: boolean;
  /** Dark pixels in a footer strip left of its centred caption. */
  footerInk: number;
}

async function share(page: Page, reply: string): Promise<Export> {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => route.fulfill({ json: {} }),
  );
  await page.goto(`/tests/e2e/share-image-harness.html?reply=${reply}`);
  await expect(page.getByAltText('分享预览')).toBeVisible({ timeout: 60_000 });
  const dialogWidth = (await page.getByRole('dialog').boundingBox())!.width;
  const result = await page.evaluate(async (phoneQuery) => {
    const portal = Array.from(document.body.children).find(
      (node) => (node as HTMLElement).style.left === '-10000px',
    )!;
    const card = portal.firstElementChild as HTMLElement;
    const footer = card.lastElementChild as HTMLElement;
    const body = footer.previousElementSibling as HTMLElement;
    const img =
      document.querySelector<HTMLImageElement>('img[alt="分享预览"]')!;
    await img.decode();

    const cardRect = card.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const scaleX = img.naturalWidth / cardRect.width;
    const scaleY = img.naturalHeight / cardRect.height;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    // Body text starts 24px in; the footer caption is centred, well clear.
    const left = Math.ceil(24 * scaleX);
    const right = Math.floor(46 * scaleX);
    const top = Math.ceil((footerRect.top - cardRect.top + 3) * scaleY);
    const bottom = Math.floor((footerRect.bottom - cardRect.top - 3) * scaleY);
    const pixels = ctx.getImageData(left, top, right - left, bottom - top).data;
    let footerInk = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] < 3 * 160) footerInk += 1;
    }

    return {
      phone: matchMedia(phoneQuery).matches,
      viewportWidth: window.innerWidth,
      cardWidth: Math.round(cardRect.width),
      imageWidth: img.naturalWidth,
      clipped: body.scrollHeight - body.clientHeight > 1,
      faded: Array.from(body.children).some((child) =>
        getComputedStyle(child).backgroundImage.includes('gradient'),
      ),
      footerInk,
    };
  }, PHONE_QUERY);
  return { ...result, dialogWidth };
}

test.describe('share image', () => {
  test.setTimeout(120_000);

  test('a short reply gets the phone card at 3x, the sheet spanning the phone', async ({
    page,
  }) => {
    const shared = await share(page, 'short');
    if (shared.phone) {
      expect(shared.dialogWidth).toBeCloseTo(shared.viewportWidth, 0);
      expect(shared.cardWidth).toBe(390);
      expect(shared.imageWidth).toBe(390 * 3);
    } else {
      // The card plus the body padding and the preview ring.
      expect(shared.dialogWidth).toBeCloseTo(720 + 34, 0);
      expect(shared.cardWidth).toBe(720);
      expect(shared.imageWidth).toBe(720 * 2);
    }
    expect(shared.clipped).toBe(false);
    expect(shared.faded).toBe(false);
    expect(shared.footerInk).toBe(0);
  });

  test('a reply the phone card could only export below 2x gets the 720 card at 2x', async ({
    page,
  }) => {
    const shared = await share(page, 'medium');
    expect(shared.cardWidth).toBe(720);
    expect(shared.imageWidth).toBe(720 * 2);
    expect(shared.clipped).toBe(false);
    expect(shared.footerInk).toBe(0);
  });

  test('a reply the phone card would cut is exported whole on the 720 card', async ({
    page,
  }) => {
    const shared = await share(page, 'long');
    expect(shared.cardWidth).toBe(720);
    expect(shared.clipped).toBe(false);
    expect(shared.faded).toBe(false);
    expect(shared.footerInk).toBe(0);
  });

  test('a reply cut on any card fades out above the footer, not over it', async ({
    page,
  }) => {
    const shared = await share(page, 'huge');
    expect(
      await page.evaluate(() => document.documentElement.dataset.replyLength),
    ).toMatch(/^[12]\d{4}$/);
    expect(shared.cardWidth).toBe(720);
    expect(shared.clipped).toBe(true);
    expect(shared.faded).toBe(true);
    expect(shared.footerInk).toBe(0);
  });
});
