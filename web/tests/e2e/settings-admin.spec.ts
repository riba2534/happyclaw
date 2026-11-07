import { expect, test, type Page } from '@playwright/test';

// The phone forms of Settings, 能力库 and 用户管理 over the settings-admin
// harness (real AppLayout and pages, every /api request answered here):
// the settings section stack and the back gesture, the one-bar page header,
// row menus as action sheets, the detail sheet's fixed header.

const HARNESS = '/tests/e2e/settings-admin-harness.html';

const member = (n: number) => ({
  id: `member-${n}`,
  username: `member_${n}`,
  display_name: `成员 ${n}`,
  role: 'member',
  status: 'active',
  permissions: [],
  must_change_password: false,
  disable_reason: null,
  notes: n === 1 ? '一段比较长的备注，用来检查行内截断' : null,
  created_at: '2026-01-01T00:00:00.000Z',
  last_login_at: '2026-10-29T08:00:00.000Z',
  last_active_at: '2026-10-29T09:00:00.000Z',
  deleted_at: null,
});

const skill = {
  id: 'pdf-tools',
  name: 'pdf-tools',
  description: '读取、拆分和合并 PDF 文件的技能',
  source: 'user',
  sourceKey: 'user:pdf-tools',
  enabled: true,
  userInvocable: true,
  allowedTools: [],
  argumentHint: null,
  updatedAt: '2026-10-01T00:00:00.000Z',
  files: [],
};

async function mockBackend(page: Page) {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path === '/api/admin/users') {
        return route.fulfill({
          json: {
            users: [1, 2, 3].map(member),
            total: 3,
            page: 1,
            pageSize: 20,
          },
        });
      }
      if (path === '/api/admin/permissions') {
        return route.fulfill({ json: { permissions: [], templates: [] } });
      }
      if (path === '/api/skills') {
        return route.fulfill({ json: { skills: [skill] } });
      }
      if (path === '/api/skills/pdf-tools') {
        return route.fulfill({
          json: {
            skill: {
              ...skill,
              // Long enough that the sheet body has to scroll.
              content: Array.from(
                { length: 80 },
                (_, i) => `第 ${i + 1} 行：技能说明`,
              ).join('\n\n'),
            },
          },
        });
      }
      if (path === '/api/config/storage-sources') {
        return route.fulfill({
          json: {
            sources: [
              {
                id: 'nas-smb',
                type: 'cifs',
                server: 'nas.lan',
                share: 'team-archive-with-a-long-name',
                username: 'happyclaw-agent',
                smbVersion: '3.0',
                allowReadWrite: false,
                description: '团队共享盘',
                hasPassword: true,
                origin: 'web',
                usedBy: 2,
                readWriteUsedBy: 0,
              },
            ],
            allowlistPath: 'config/mount-allowlist.json',
            managedPath: 'data/config/storage-sources.json',
            nonMainReadOnly: true,
          },
        });
      }
      return route.fulfill({ status: 404, json: { error: 'not mocked' } });
    },
  );
}

const routeProbe = (page: Page) => page.getByTestId('route');

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
}

/** The control's box is at least 44px tall and wide where it takes taps. */
async function expectTapTarget(page: Page, selector: string) {
  const boxes = await page.locator(selector).evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { w: rect.width, h: rect.height };
    }),
  );
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.h).toBeGreaterThanOrEqual(44);
    expect(box.w).toBeGreaterThanOrEqual(44);
  }
}

test.beforeEach(async ({ page }) => {
  await mockBackend(page);
});

test.describe('settings on a phone', () => {
  test('a section opens over the list and back returns to the list', async ({
    page,
  }) => {
    await page.goto(`${HARNESS}?route=/settings`);
    await expect(routeProbe(page)).toHaveText('/settings');
    // The list is the settings home; the only drawer is the app's own.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('设置');
    await expect(page.getByRole('button', { name: '打开菜单' })).toBeVisible();
    await expect(page.getByRole('button', { name: '设置分区' })).toHaveCount(0);
    await expectTapTarget(page, 'nav[aria-label="设置导航"] [role="button"]');
    await expectNoHorizontalOverflow(page);

    await page.getByRole('button', { name: '个人资料' }).click();
    await expect(routeProbe(page)).toHaveText('/settings?tab=profile');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      '个人资料',
    );
    await expect(page.getByRole('button', { name: '打开菜单' })).toHaveCount(0);

    // The system back gesture pops the section, not the settings page.
    await page.goBack();
    await expect(routeProbe(page)).toHaveText('/settings');
    await expect(page.getByRole('button', { name: '个人资料' })).toBeVisible();

    // So does the bar's back button, without leaving a duplicate entry.
    await page.getByRole('button', { name: '安全与设备' }).click();
    await expect(routeProbe(page)).toHaveText('/settings?tab=security');
    await page.getByRole('button', { name: '返回' }).click();
    await expect(routeProbe(page)).toHaveText('/settings');
    await page.goForward();
    await expect(routeProbe(page)).toHaveText('/settings?tab=security');
  });

  test('a linked section goes back to the list in place', async ({ page }) => {
    await page.goto(`${HARNESS}?route=/settings?tab=profile`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      '个人资料',
    );
    await page.getByRole('button', { name: '返回' }).click();
    await expect(routeProbe(page)).toHaveText('/settings');
    await expect(page.getByRole('button', { name: '个人资料' })).toBeVisible();
  });
});

test.describe('storage sources on a phone', () => {
  test('rows fit the screen and the editor opens as a sheet', async ({
    page,
  }) => {
    await page.goto(`${HARNESS}?route=/settings?tab=storage-sources`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('存储源');
    await expect(
      page.getByText('smb://nas.lan/team-archive-with-a-long-name'),
    ).toBeVisible();
    await expect(page.getByText('2 个工作区在用')).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByRole('button', { name: 'nas-smb 的操作' }).click();
    await page
      .getByRole('dialog', { name: 'nas-smb' })
      .getByRole('button', { name: '编辑' })
      .click();
    const dialog = page.getByRole('dialog', { name: '编辑存储源' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('已设置')).toBeVisible();
    // The password is never prefilled; replacing it reveals an empty field.
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
    await dialog.getByRole('button', { name: '更换密码' }).click();
    await expect(dialog.locator('input[type="password"]')).toHaveValue('');
    // Phone inputs stay at 16px so iOS does not zoom in.
    const fontSizes = await dialog
      .locator('input:not([type="checkbox"]):not([aria-hidden="true"])')
      .evaluateAll((inputs) =>
        inputs.map((input) => parseFloat(getComputedStyle(input).fontSize)),
      );
    for (const size of fontSizes) expect(size).toBeGreaterThanOrEqual(16);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: test.info().outputPath('storage-source-editor.png'),
    });
  });
});

test.describe('pages on a phone', () => {
  test('能力库 names itself in the top bar with one action and ⋯', async ({
    page,
  }) => {
    await page.goto(`${HARNESS}?route=/capabilities/skills`);
    const bar = page.getByTestId('phone-top-bar');
    await expect(bar.getByRole('heading', { level: 1 })).toHaveText('能力库');
    await expect(bar.getByRole('button', { name: '安装技能' })).toBeVisible();
    // The page's own bar keeps only the tabs: no second title.
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

    await bar.getByRole('button', { name: '更多操作' }).click();
    const sheet = page.getByRole('dialog', { name: '能力库操作' });
    await expect(sheet.getByRole('button', { name: '刷新' })).toBeVisible();
    await page.keyboard.press('Escape');

    // The two notes fold into one tappable line until asked for.
    const notice = page.getByRole('button', { name: /展开说明/ });
    await expect(notice).toBeVisible();
    await expectTapTarget(page, 'main button[aria-expanded="false"]');
    await notice.click();
    await expect(page.getByText(/到具体智能体的“能力配置”中/)).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('a skill detail sheet keeps its header while the body scrolls', async ({
    page,
  }) => {
    await page.goto(`${HARNESS}?route=/capabilities/skills`);
    await page.getByRole('button', { name: /pdf-tools/ }).click();
    const sheet = page.getByRole('dialog', { name: '技能详情' });
    await expect(sheet.getByText('第 80 行：技能说明')).toBeAttached();
    // Measure once the sheet has slid into place.
    await sheet.evaluate((element) =>
      Promise.all(
        element.getAnimations({ subtree: true }).map((a) => a.finished),
      ),
    );
    const header = sheet.locator('[data-slot="sheet-header"]');
    const before = await header.boundingBox();
    const body = sheet.locator('[data-slot="sheet-body"]');
    await body.evaluate((element) => {
      element.scrollTop = 600;
    });
    await expect
      .poll(() => body.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect((await header.boundingBox())?.y).toBe(before?.y);
    // The sheet itself does not scroll; only its body does.
    expect(
      await page
        .locator('[data-slot="sheet-content"]')
        .evaluate((element) => element.scrollTop),
    ).toBe(0);
  });

  test('a user row opens its actions as a sheet of 44px rows', async ({
    page,
  }) => {
    await page.goto(`${HARNESS}?route=/users`);
    const bar = page.getByTestId('phone-top-bar');
    await expect(bar.getByRole('heading', { level: 1 })).toHaveText('用户管理');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

    await page.getByRole('button', { name: '成员 1 的操作' }).click();
    const sheet = page.getByRole('dialog', { name: '成员 1 的操作' });
    await expect(sheet.getByRole('button', { name: '删除' })).toBeVisible();
    await expectTapTarget(page, '[role="dialog"] button:not(.sr-only)');
    // The table's first column, which names the row, stays pinned while the
    // table scrolls sideways.
    await page.keyboard.press('Escape');
    expect(
      await page
        .locator('[data-slot="data-table"] td')
        .first()
        .evaluate((element) => getComputedStyle(element).position),
    ).toBe('sticky');
    await expectNoHorizontalOverflow(page);
  });
});
