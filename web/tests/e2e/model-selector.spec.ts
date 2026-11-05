import { expect, test, type Locator, type Page } from '@playwright/test';

// The composer's model picker and the reasoning effort control beside it,
// in ChatView over the composer harness. The model-selection API is answered by the test itself:
// GET returns the current selection, PUT records the body and applies it.

const HARNESS_PATH = '/tests/e2e/composer-harness.html';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

interface Selection {
  selectedModelConfigId: string | null;
  selectedModel: string | null;
  selectedEffort: string | null;
}

function payload(selection: Selection) {
  return {
    ...selection,
    default: { source: 'none', modelConfigId: null },
    options: [
      {
        id: 'official',
        name: 'Claude 官方',
        kind: 'official',
        model: 'opus',
        usable: true,
      },
      {
        id: 'chatgpt',
        name: 'ChatGPT 订阅 (someone@example.com)',
        kind: 'codex',
        model: 'gpt-6.1-sol',
        usable: true,
        codex: {
          defaultModel: 'gpt-6.1-sol',
          defaultEffort: 'low',
          source: 'live',
          needsReauth: false,
          models: [
            {
              value: 'gpt-6.1-sol',
              label: 'gpt-6.1-sol（主力编码）',
              efforts: EFFORTS,
              defaultEffort: 'low',
            },
            {
              value: 'gpt-6-astra',
              label: 'gpt-6-astra（旗舰·最强推理）',
              efforts: EFFORTS,
              defaultEffort: 'medium',
            },
            {
              value: 'gpt-5.5',
              label: 'gpt-5.5（遗留）',
              efforts: ['low', 'medium', 'high'],
              defaultEffort: 'medium',
            },
          ],
        },
      },
    ],
  };
}

async function openHarness(
  page: Page,
  initial: Partial<Selection> = {},
  { openCard = true }: { openCard?: boolean } = {},
) {
  const state: Selection = {
    selectedModelConfigId: null,
    selectedModel: null,
    selectedEffort: null,
    ...initial,
  };
  const puts: Array<Record<string, unknown>> = [];
  await page.route('**/api/groups/**/model-selection**', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      puts.push(body);
      state.selectedModelConfigId = (body.modelConfigId as string) ?? null;
      state.selectedModel = (body.model as string) ?? null;
      state.selectedEffort = (body.effort as string) ?? null;
    }
    await route.fulfill({ json: payload(state) });
  });
  await page.goto(HARNESS_PATH);
  if (openCard) {
    await openComposerCard(page);
    await expect(modelButton(page)).toBeVisible();
  } else {
    await expect(page.locator('[data-hc-composer]')).toBeVisible();
  }
  return { puts, state };
}

/**
 * A phone's composer rests as a one-line pill; the model sits in the card
 * it opens into when its text gets focus.
 */
async function openComposerCard(page: Page) {
  await expect(page.locator('[data-hc-composer]')).toBeVisible();
  if ((await page.locator('[data-composer-dock="pill"]').count()) === 0) return;
  await page.locator('[data-hc-composer] [data-composer-editor]').click();
  await expect(page.locator('[data-composer-dock="card"]')).toHaveCount(1);
}

const modelButton = (page: Page) =>
  page.locator('[data-hc-composer] button[aria-label^="模型："]');
/** A model row of the open panel, by the model it names. */
const modelRow = (page: Page, model: string) =>
  page.locator(`[data-model-row][title="${model}"]`);
/** The reasoning effort control next to the model (not on a phone). */
const effortButton = (page: Page) =>
  page.locator('[data-hc-composer] button[aria-label$="选择推理等级"]');
/** A phone's level, in the segmented row under the model in the sheet. */
const effortSegment = (page: Page, label: string) =>
  page
    .locator('[data-effort-segments]')
    .getByRole('button', { name: label, exact: true });
const effortItem = (page: Page, label: string) =>
  page.getByRole('menuitemradio', { name: label, exact: true });

/** The row of composer actions the model button sits in. */
const actionRow = (page: Page) =>
  modelButton(page).locator('xpath=ancestor::div[@data-composer-toolbar][1]');

async function expectRowFits(page: Page) {
  const fits = await actionRow(page).evaluate((row) => {
    const rowBox = row.getBoundingClientRect();
    const send = row.querySelector('button[aria-label]:last-of-type');
    const sendBox = send?.getBoundingClientRect();
    // Boxes, not scrollWidth: a phone's padded touch targets reach past
    // the row without taking any room in it.
    const right = Math.max(
      ...[...row.querySelectorAll<HTMLElement>('*')]
        .filter((element) => element.offsetParent !== null)
        .map((element) => element.getBoundingClientRect().right),
    );
    return {
      overflow: right - rowBox.right,
      sendInside:
        !!sendBox &&
        sendBox.right <= window.innerWidth + 0.5 &&
        sendBox.right <= rowBox.right + 0.5,
    };
  });
  expect(fits.overflow).toBeLessThanOrEqual(1);
  expect(fits.sendInside).toBe(true);
}

/** Waits for enter animations: a sliding sheet's handle is still moving. */
const settleAnimations = (scope: Locator) =>
  scope.evaluate((element) =>
    Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );

/**
 * WebKit's focus rules in Chromium (iOS Safari, which this box cannot run):
 * a tapped <button> never takes focus, so the focused editor blurs with
 * relatedTarget null, unless the page cancelled the press. Installed after
 * React's own listener (window, bubbling), so it sees what the page did.
 */
async function emulateWebKitButtonFocus(page: Page) {
  await page.addInitScript(() => {
    window.addEventListener('mousedown', (event) => {
      const button =
        event.target instanceof Element ? event.target.closest('button') : null;
      if (!button || event.defaultPrevented) return;
      event.preventDefault();
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) {
        active.blur();
      }
    });
  });
}

const dockState = (page: Page) =>
  page.locator('[data-hc-composer]').getAttribute('data-composer-dock');
const editorFocused = (page: Page) =>
  page.evaluate(
    () => !!(document.activeElement as HTMLElement | null)?.isContentEditable,
  );

const sendButton = (page: Page) =>
  page.locator('[data-composer-toolbar] button[aria-label="发送消息"]');

test.describe('model slot in the composer toolbar', () => {
  test('sits right before send on a desktop, right after + on a phone', async ({
    page,
    isMobile,
  }) => {
    await openHarness(page, {
      selectedModelConfigId: 'chatgpt',
      selectedModel: 'gpt-6-astra',
      selectedEffort: 'high',
    });
    const slot = (await page
      .locator('[data-composer-model-slot]')
      .boundingBox())!;
    const model = (await modelButton(page).boundingBox())!;
    const send = (await sendButton(page).boundingBox())!;
    if (isMobile) {
      // cindy's order: [+][model · effort] … [stop][send].
      const plus = (await page
        .locator('[data-composer-tools] > button')
        .first()
        .boundingBox())!;
      const gap = slot.x - (plus.x + plus.width);
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThan(10);
      expect(send.x - (slot.x + slot.width)).toBeGreaterThan(8);
    } else {
      // Left: the tools. Right: the model slot, then send.
      const tools = (await page
        .locator('[data-composer-tools]')
        .boundingBox())!;
      expect(tools.x + tools.width).toBeLessThan(slot.x);
      expect(send.x - (slot.x + slot.width)).toBeLessThan(8);
    }
    expect(model.x + model.width).toBeLessThanOrEqual(send.x + 0.5);
  });

  test('412px and 320px windows truncate the model, never the tools or send', async ({
    page,
    hasTouch,
  }) => {
    await openHarness(page, {
      selectedModelConfigId: 'chatgpt',
      selectedModel: 'gpt-6-astra',
      selectedEffort: 'high',
    });
    // A phone's tools are cindy's 34px.
    const size = hasTouch ? 34 : 30;
    for (const width of [412, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await expect
        .poll(async () => {
          const box = (await sendButton(page).boundingBox())!;
          return [Math.round(box.width), Math.round(box.height)];
        })
        .toEqual([size, size]);
      await expectRowFits(page);
      // The tools on the left keep their size and end before the slot.
      const slot = (await page
        .locator('[data-composer-model-slot]')
        .boundingBox())!;
      // The tool buttons keep their size and stay clear of the slot (on a
      // phone it sits among them, right after +).
      const tools = page.locator('[data-composer-tools] > button');
      for (let i = 0; i < (await tools.count()); i += 1) {
        const tool = (await tools.nth(i).boundingBox())!;
        expect(Math.round(tool.width), `tool ${i} at ${width}px`).toBe(size);
        const clear =
          tool.x + tool.width <= slot.x + 0.5 ||
          tool.x >= slot.x + slot.width - 0.5;
        expect(clear, `tool ${i} at ${width}px`).toBe(true);
      }
    }
  });

  test('at 390px the model shows at least 8 characters of its name', async ({
    page,
  }) => {
    await openHarness(page, {
      selectedModelConfigId: 'official',
      selectedModel: 'claude-opus-5-5',
    });
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(modelButton(page)).toContainText('claude-opus-5-5');
    // Characters left of the ellipsis in the element that truncates the name.
    const visible = await modelButton(page).evaluate((button) => {
      const name = 'claude-opus-5-5';
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
      let text: Text | null = null;
      while (walker.nextNode()) {
        if ((walker.currentNode as Text).data.includes(name)) {
          text = walker.currentNode as Text;
          break;
        }
      }
      if (!text) return 0;
      let clip = text.parentElement!;
      while (clip !== button && getComputedStyle(clip).overflow === 'visible') {
        clip = clip.parentElement!;
      }
      if (clip.scrollWidth <= clip.clientWidth) return name.length;
      const canvas = document.createElement('canvas').getContext('2d')!;
      canvas.font = getComputedStyle(clip).font;
      const room = clip.clientWidth - canvas.measureText('…').width;
      const start = text.data.indexOf(name);
      const range = document.createRange();
      let shown = 0;
      for (let count = 1; count <= name.length; count += 1) {
        range.setStart(text, start);
        range.setEnd(text, start + count);
        if (range.getBoundingClientRect().width > room) break;
        shown = count;
      }
      return shown;
    });
    expect(visible).toBeGreaterThanOrEqual(8);
  });
});

test.describe('phone model sheet', () => {
  test('takes the bottom sheet look and closes when dragged down', async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, 'a phone opens the picker as a sheet');
    await openHarness(page, {
      selectedModelConfigId: 'chatgpt',
      selectedModel: 'gpt-6-astra',
      selectedEffort: 'high',
    });
    await modelButton(page).click();
    const sheet = page.getByRole('dialog', { name: '选择模型' });
    await expect(sheet).toBeVisible();
    // Rounded top with a handle, without changes to the picker.
    expect(
      await sheet.evaluate(
        (element) => getComputedStyle(element).borderTopLeftRadius,
      ),
    ).toBe('12px');
    // Measured once it has slid in; mid-slide the press lands on the header.
    await settleAnimations(sheet);
    const handle = (await sheet.locator('[data-sheet-handle]').boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 10);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 400, {
      steps: 10,
    });
    await page.mouse.up();
    await expect(sheet).toHaveCount(0);
  });
});

test.describe('phone model entry', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(!isMobile, 'the resting pill and its chip are a phone layout');
  });

  test("a tap on the resting pill's model chip opens the sheet and picks a model", async ({
    page,
  }) => {
    const { puts } = await openHarness(page, {}, { openCard: false });
    expect(await dockState(page)).toBe('pill');
    const chip = page.locator('[data-model-pill="compact"]');
    await expect(chip).toBeVisible();

    await chip.tap();
    const sheet = page.getByRole('dialog', { name: '选择模型' });
    await expect(sheet).toBeVisible();
    // No keyboard: the editor was never focused on the way.
    expect(await editorFocused(page)).toBe(false);
    // The card opens behind the sheet while it is up (cindy's
    // composerCardActive), the same button now the full pill.
    await expect.poll(() => dockState(page)).toBe('card');
    await expect(page.locator('[data-model-pill=""]')).toBeVisible();

    await modelRow(page, 'gpt-6-astra').tap();
    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0]).toMatchObject({
      modelConfigId: 'chatgpt',
      model: 'gpt-6-astra',
    });
    // Still open, the new model's levels right under it.
    await expect(sheet).toBeVisible();
    await expect(
      page.locator('[data-effort-segments]').getByRole('button'),
    ).toHaveCount(1 + EFFORTS.length);
    await effortSegment(page, '高').tap();
    await expect.poll(() => puts.length).toBe(2);
    expect(puts[1]).toMatchObject({ model: 'gpt-6-astra', effort: 'high' });

    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => dockState(page)).toBe('pill');
    await expect(chip).toBeVisible();
  });

  test('with WebKit focus rules, a tap on the model pill in the focused card opens the sheet', async ({
    page,
  }) => {
    await emulateWebKitButtonFocus(page);
    await openHarness(page, {}, { openCard: false });
    await page.locator('[data-hc-composer] [data-composer-editor]').tap();
    await expect.poll(() => dockState(page)).toBe('card');
    expect(await editorFocused(page)).toBe(true);

    await modelButton(page).tap();
    await expect(page.getByRole('dialog', { name: '选择模型' })).toBeVisible();
    expect(await dockState(page)).toBe('card');
  });

  test('with WebKit focus rules, + in the focused card opens its sheet', async ({
    page,
  }) => {
    await emulateWebKitButtonFocus(page);
    await openHarness(page, {}, { openCard: false });
    await page.locator('[data-hc-composer] [data-composer-editor]').tap();
    await expect.poll(() => dockState(page)).toBe('card');

    await page.locator('[data-composer-tools] > button').first().tap();
    await expect(page.locator('[data-composer-plus-sheet]')).toBeVisible();
    expect(await dockState(page)).toBe('card');
  });

  test('without the right to change it, the chip says why instead of opening', async ({
    page,
  }) => {
    await page.route('**/api/groups/**/model-selection**', (route) =>
      route.fulfill({
        json: payload({
          selectedModelConfigId: null,
          selectedModel: null,
          selectedEffort: null,
        }),
      }),
    );
    await page.goto(`${HARNESS_PATH}?readonly=1`);
    const chip = page.locator('[data-model-pill="compact"]');
    await expect(chip).toHaveAttribute('aria-disabled', 'true');
    // aria-disabled, not disabled: a finger can still press it.
    await chip.tap({ force: true });
    await expect(page.getByText('你没有修改此工作区配置的权限')).toBeVisible();
    await expect(page.getByRole('dialog', { name: '选择模型' })).toHaveCount(0);
  });

  test('the sheet opens on the model in use, its list filling the sheet', async ({
    page,
  }) => {
    await openHarness(
      page,
      { selectedModelConfigId: 'chatgpt', selectedModel: 'gpt-5.5' },
      { openCard: false },
    );
    await page.setViewportSize({ width: 390, height: 600 });
    await page.locator('[data-model-pill]').tap();
    const sheet = page.getByRole('dialog', { name: '选择模型' });
    await expect(sheet).toBeVisible();
    await settleAnimations(sheet);
    const list = sheet.getByRole('radiogroup');
    const row = modelRow(page, 'gpt-5.5');
    const [listBox, rowBox] = await Promise.all([
      list.boundingBox(),
      row.boundingBox(),
    ]);
    // The selected row is in view without scrolling by hand.
    expect(rowBox!.y).toBeGreaterThanOrEqual(listBox!.y - 0.5);
    expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(
      listBox!.y + listBox!.height + 0.5,
    );
    // Connections by name (a touch screen has no tooltips).
    await expect(
      sheet.getByRole('button', { name: 'Claude 官方', exact: true }),
    ).toBeVisible();
    // The search field: 16px, no autocapitalisation or autocorrect.
    const search = sheet.getByRole('textbox', { name: '搜索模型' });
    expect(
      await search.evaluate((element) => [
        getComputedStyle(element).fontSize,
        element.getAttribute('autocapitalize'),
        element.getAttribute('autocorrect'),
        element.getAttribute('enterkeyhint'),
      ]),
    ).toEqual(['16px', 'none', 'off', 'search']);
    // The sheet opens full, and searching keeps it there.
    await expect(sheet).toHaveAttribute('data-snap', 'full');
    await search.tap();
    await expect(sheet).toHaveAttribute('data-snap', 'full');
  });
});

test.describe('model picker', () => {
  test('fits the composer row without pushing the send button off a phone', async ({
    page,
    isMobile,
  }) => {
    await openHarness(page, {
      selectedModelConfigId: 'chatgpt',
      selectedModel: 'gpt-6-astra',
      selectedEffort: 'high',
    });
    await expect(modelButton(page)).toContainText('gpt-6-astra');
    if (isMobile) {
      // A phone: one pill, 「模型 · 档位」, whose name says both.
      await expect(modelButton(page)).toContainText('高');
      await expect(modelButton(page)).toHaveAttribute(
        'aria-label',
        /，推理等级：高$/,
      );
      await expect(effortButton(page)).toHaveCount(0);
    } else {
      // The model, then its own effort control.
      await expect(effortButton(page)).toContainText('高');
      const boxes = await Promise.all([
        modelButton(page).boundingBox(),
        effortButton(page).boundingBox(),
      ]);
      expect(boxes[0]!.x).toBeLessThan(boxes[1]!.x);
    }
    await expectRowFits(page);

    for (const width of [412, 360, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await expectRowFits(page);
      await expect(modelButton(page)).toBeVisible();
    }
  });

  test('picking a model, then an effort, saves both for the conversation', async ({
    page,
    isMobile,
  }) => {
    const { puts } = await openHarness(page);

    await modelButton(page).click();
    const panel = page.getByRole('dialog');
    await expect(
      panel.getByText('ChatGPT 订阅 (someone@example.com)').first(),
    ).toBeVisible();
    // Models are listed by name; whatever commentary the catalog carries stays out.
    await expect(panel).not.toContainText(/主力编码|旗舰|遗留|配置默认/);
    // Nothing to set an effort on while no connection is chosen.
    await expect(effortButton(page)).toHaveCount(0);
    await modelRow(page, 'gpt-6-astra').click();
    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0]).toMatchObject({
      modelConfigId: 'chatgpt',
      model: 'gpt-6-astra',
      effort: null,
    });
    await expect(modelButton(page)).toContainText('gpt-6-astra');

    if (isMobile) {
      // A phone keeps the sheet open on the new model and offers its
      // levels right under it.
      await expect(panel).toBeVisible();
      await expect(modelRow(page, 'gpt-6-astra')).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(
        page.locator('[data-effort-segments]').getByRole('button'),
      ).toHaveCount(1 + EFFORTS.length);
      await effortSegment(page, '超高').click();
    } else {
      await effortButton(page).click();
      // gpt-6-astra offers everything up to max here, after 默认.
      await expect(page.getByRole('menuitemradio')).toHaveCount(
        1 + EFFORTS.length,
      );
      await effortItem(page, '超高').click();
    }
    await expect.poll(() => puts.length).toBe(2);
    expect(puts[1]).toMatchObject({
      modelConfigId: 'chatgpt',
      model: 'gpt-6-astra',
      effort: 'xhigh',
    });
    if (isMobile) {
      // Applied in place: the sheet stays open on the pressed level.
      await expect(effortSegment(page, '超高')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(modelButton(page)).toContainText('超高');
    } else {
      await expect(effortButton(page)).toContainText('超高');
      await modelButton(page).click();
    }

    // A model without that level puts the effort back to its default.
    await modelRow(page, 'gpt-5.5').click();
    await expect.poll(() => puts.length).toBe(3);
    expect(puts[2]).toMatchObject({ model: 'gpt-5.5', effort: null });
    await expect(modelButton(page)).toContainText('gpt-5.5');
    await expect(
      isMobile ? modelButton(page) : effortButton(page),
    ).toContainText('中');
  });

  test('the panel stays inside a small screen', async ({ page }) => {
    await openHarness(page, {
      selectedModelConfigId: 'chatgpt',
      selectedModel: 'gpt-6-astra',
    });
    for (const width of [360, 1100]) {
      await page.setViewportSize({ width, height: 700 });
      await modelButton(page).click();
      const panel = page.getByRole('dialog');
      await expect(panel).toBeVisible();
      const box = await panel.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
    }
  });
});

test.describe('phone model sheet at 390px', () => {
  test('the levels and the rail fit, every level reachable', async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, 'the levels sit in the sheet on a phone');
    await page.setViewportSize({ width: 390, height: 844 });
    await openHarness(page, {
      selectedModelConfigId: 'chatgpt',
      selectedModel: 'gpt-6-astra',
    });
    await modelButton(page).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByRole('button', { name: '最近', exact: true }),
    ).toBeVisible();
    const row = await page.locator('[data-effort-segments]').boundingBox();
    expect(row!.x).toBeGreaterThanOrEqual(0);
    expect(row!.x + row!.width).toBeLessThanOrEqual(390.5);
    // 默认 and all five levels fit, or scroll inside the row.
    for (const label of ['默认', '低', '中', '高', '超高', '最高']) {
      const segment = effortSegment(page, label);
      await segment.scrollIntoViewIfNeeded();
      const box = await segment.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390.5);
    }
  });
});

test.describe('pinned models', () => {
  const CHATGPT = 'ChatGPT 订阅 (someone@example.com)';
  const firstRow = (page: Page) => page.locator('[data-model-row]').first();
  /** A finger held on a row: no hover on a phone, so pins come this way. */
  async function longPress(target: Locator) {
    const init = { pointerId: 7, pointerType: 'touch', isPrimary: true };
    await target.dispatchEvent('pointerdown', init);
    await target.page().waitForTimeout(650);
    await target.dispatchEvent('pointerup', init);
    // The click a real release makes, which the long press swallows.
    await target.dispatchEvent('click');
  }

  test('a desktop pins from the button a hovered row shows, and by keyboard', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'a phone has no hover');
    const { puts } = await openHarness(page);
    await modelButton(page).click();
    const pin = page.getByRole('button', {
      name: `置顶「${CHATGPT} · gpt-5.5」`,
    });
    await expect(pin).toHaveCSS('opacity', '0');
    await modelRow(page, 'gpt-5.5').hover();
    await expect(pin).toHaveCSS('opacity', '1');
    await pin.click();
    await expect(firstRow(page)).toHaveAttribute('title', 'gpt-5.5');
    await expect(page.getByText('置顶', { exact: true })).toBeVisible();

    // Tab from the row reaches its pin; a pinned row's pin stays shown.
    await modelRow(page, 'gpt-5.5').focus();
    await page.keyboard.press('Tab');
    const unpin = page.getByRole('button', {
      name: `取消置顶「${CHATGPT} · gpt-5.5」`,
    });
    await expect(unpin).toBeFocused();
    await expect(unpin).toHaveCSS('opacity', '1');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-model-row][data-pinned]')).toHaveCount(0);
    expect(puts).toHaveLength(0);
  });

  test('a phone pins by a long press in the sheet, a tap still picks', async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, 'the long press is a phone gesture');
    const { puts } = await openHarness(page);
    await modelButton(page).click();
    const sheet = page.locator('[data-slot="sheet-content"]').first();
    await expect(sheet).toBeVisible();
    await longPress(modelRow(page, 'gpt-5.5'));
    await page.getByRole('button', { name: '置顶「gpt-5.5」' }).click();
    // The model sheet stays, its pinned row first; nothing was picked.
    await expect(sheet).toBeVisible();
    await expect(firstRow(page)).toHaveAttribute('title', 'gpt-5.5');
    expect(puts).toHaveLength(0);

    await modelRow(page, 'gpt-5.5').click();
    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0]).toMatchObject({
      modelConfigId: 'chatgpt',
      model: 'gpt-5.5',
    });
  });
});
