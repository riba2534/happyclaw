import { expect, test, type Page, type TestInfo } from '@playwright/test';

// Deployment mode and workspace root over the single-user-host harness (the
// real AppLayout, Settings and Setup pages; every /api request answered
// here): what single-user host mode hides and redirects, the 工作区根目录
// field, switching 部署方式, and the setup wizard's first question.

const HARNESS = '/tests/e2e/single-user-host-harness.html';
const SHOTS = '/tmp/ws-web';

const open = (page: Page, route: string, mode = 'multi_user') =>
  page.goto(`${HARNESS}?route=${encodeURIComponent(route)}&mode=${mode}`);

const shot = (page: Page, info: TestInfo, name: string) =>
  page.screenshot({
    path: `${SHOTS}/${name}-${info.project.name}.png`,
    fullPage: true,
  });

interface HostIntegration {
  [key: string]: unknown;
}

function hostIntegration(overrides: HostIntegration = {}): HostIntegration {
  return {
    adminHostOnlyMode: false,
    mainAgentContextSource: 'managed',
    mainAgentAutoCompactWindow: 0,
    mainAgentAutoCompactPercentage: 0,
    externalClaudeDir: '',
    pluginAutoScan: true,
    workspaceRoot: '',
    workspaceRootEffective: '/home/me/happyclaw-workspaces',
    workspaceRootSource: 'default',
    workspaceRootFallbackReason: 'inside_install_dir',
    workspaceRootFallbackWarning: null,
    deploymentMode: 'multi_user',
    deploymentModeConfigured: '',
    deploymentModeSource: 'default',
    ...overrides,
  };
}

const systemSettings = {
  containerTimeout: 1_800_000,
  idleTimeout: 1_800_000,
  containerMaxOutputSize: 10_485_760,
  maxConcurrentContainers: 20,
  maxLoginAttempts: 5,
  loginLockoutMinutes: 15,
  fallbackModel: '',
  allowMemberGuests: false,
};

interface Backend {
  host: HostIntegration;
  puts: Record<string, unknown>[];
  setups: Record<string, unknown>[];
  /** Answer the next deployment mode switch with the other-users 409. */
  refuseSwitch: boolean;
}

async function mockBackend(page: Page, host = hostIntegration()) {
  const backend: Backend = {
    host,
    puts: [],
    setups: [],
    refuseSwitch: false,
  };
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/config/host-integration') {
        if (request.method() === 'PUT') {
          const body = request.postDataJSON() as Record<string, unknown>;
          backend.puts.push(body);
          if (body.workspaceRoot === 'relative/dir') {
            return route.fulfill({
              status: 400,
              json: {
                error: '工作区根目录必须是绝对路径（可以用 ~ 开头）。',
                code: 'WORKSPACE_ROOT_INVALID',
                reason: 'not_absolute',
              },
            });
          }
          if (
            body.deploymentMode === 'single_user_host' &&
            backend.refuseSwitch
          ) {
            backend.refuseSwitch = false;
            return route.fulfill({
              status: 409,
              json: {
                error: '单人宿主机模式只允许一个用户；请先停用其他账号。',
                code: 'SINGLE_USER_HOST_OTHER_USERS',
                users: [
                  { id: 'u-1', username: 'alice', role: 'member' },
                  { id: 'u-2', username: 'viewer', role: 'guest' },
                ],
              },
            });
          }
          if (typeof body.deploymentMode === 'string') {
            backend.host = {
              ...backend.host,
              deploymentMode: body.deploymentMode,
              deploymentModeConfigured: body.deploymentMode,
              deploymentModeSource: 'settings',
            };
          }
          if (typeof body.workspaceRoot === 'string') {
            backend.host = {
              ...backend.host,
              workspaceRoot: body.workspaceRoot,
              workspaceRootEffective:
                body.workspaceRoot || '/home/me/happyclaw-workspaces',
              workspaceRootSource: body.workspaceRoot ? 'settings' : 'default',
              workspaceRootFallbackReason: null,
            };
          }
          return route.fulfill({ json: backend.host });
        }
        return route.fulfill({ json: backend.host });
      }
      if (path === '/api/config/system') {
        return route.fulfill({ json: systemSettings });
      }
      if (path === '/api/auth/setup') {
        backend.setups.push(request.postDataJSON());
        return route.fulfill({
          json: { success: true, user: { id: 'admin', role: 'admin' } },
        });
      }
      if (path === '/api/auth/status') {
        return route.fulfill({
          json: { initialized: false, deploymentMode: 'multi_user' },
        });
      }
      return route.fulfill({ status: 404, json: { error: 'not mocked' } });
    },
  );
  return backend;
}

const routeProbe = (page: Page) => page.getByTestId('route');
const settingsNav = (page: Page) =>
  page.locator('nav[aria-label="设置导航"]:visible');

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
}

const MULTI_USER_TABS = ['注册策略', '用户与访问', '访客', '计费管理'];

test.describe('single-user host mode hides the multi-user surfaces', () => {
  test('settings drops registration, users, guests and billing', async ({
    page,
  }) => {
    await mockBackend(page);
    await open(page, '/settings', 'single_user_host');
    const nav = settingsNav(page);
    await expect(nav.getByText('宿主机集成')).toBeVisible();
    for (const tab of MULTI_USER_TABS) {
      await expect(nav.getByText(tab, { exact: true })).toHaveCount(0);
    }
  });

  test('multi_user keeps them', async ({ page }) => {
    await mockBackend(page);
    await open(page, '/settings');
    const nav = settingsNav(page);
    for (const tab of MULTI_USER_TABS) {
      await expect(nav.getByText(tab, { exact: true })).toBeVisible();
    }
  });

  for (const [path, title] of [
    ['/users', '用户管理页'],
    ['/billing', '账单页'],
  ]) {
    test(`${path} redirects to settings, and opens in multi_user`, async ({
      page,
    }) => {
      await mockBackend(page);
      await open(page, path, 'single_user_host');
      await expect(routeProbe(page)).toHaveText('/settings');
      await open(page, path);
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
    });
  }

  test('a hidden settings tab falls back to the default section', async ({
    page,
  }) => {
    await mockBackend(page);
    await open(page, '/settings?tab=users', 'single_user_host');
    await expect(page.getByRole('heading', { name: '模型配置' })).toHaveCount(
      1,
    );
  });

  test('system settings keep the host timeouts and login limits, not Docker concurrency', async ({
    page,
  }, info) => {
    await mockBackend(page);
    await open(page, '/settings?tab=system', 'single_user_host');
    await expect(page.getByText('默认任务最大运行时间')).toBeVisible();
    await expect(page.getByText('工作区运行器空闲保留时间')).toBeVisible();
    await expect(page.getByText('运行日志保留上限')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: '登录与注册限流' }),
    ).toBeVisible();
    await expect(page.getByText('Docker 容器并发上限')).toHaveCount(0);
    await expect(page.getByText('允许普通成员创建访客')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await shot(page, info, 'system-single-user');

    await open(page, '/settings?tab=system');
    await expect(page.getByText('Docker 容器并发上限')).toBeVisible();
  });
});

test.describe('settings: host integration', () => {
  test('workspace root: effective value, fallback notice, inline 400, reset', async ({
    page,
  }, info) => {
    const backend = await mockBackend(page);
    await open(page, '/settings?tab=host-integration');
    const field = page.getByLabel('工作区根目录');
    await expect(field).toHaveValue('');
    await expect(field).toHaveAttribute(
      'placeholder',
      '/home/me/happyclaw-workspaces',
    );
    await expect(page.getByTestId('workspace-root-effective')).toContainText(
      '/home/me/happyclaw-workspaces',
    );
    await expect(page.getByTestId('workspace-root-effective')).toContainText(
      '默认值',
    );
    await expect(
      page.getByRole('status').filter({ hasText: '不能用' }),
    ).toContainText('不能放在 HappyClaw 安装目录里');
    // A phone's text inputs are at least 16px so iOS does not zoom.
    const fontSize = await field.evaluate((element) =>
      parseFloat(getComputedStyle(element).fontSize),
    );
    if (info.project.name.includes('mobile')) {
      expect(fontSize).toBeGreaterThanOrEqual(16);
    }
    await expectNoHorizontalOverflow(page);
    await shot(page, info, 'host-integration');

    const save = page.getByRole('button', { name: '保存宿主机设置' });
    await field.fill('relative/dir');
    await save.click();
    await expect(
      page.getByRole('alert').filter({ hasText: '绝对路径' }),
    ).toBeVisible();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    // Only what the form edits; the derived fields stay out of the body.
    expect(Object.keys(backend.puts.at(-1) ?? {}).sort()).toEqual(
      [
        'adminHostOnlyMode',
        'externalClaudeDir',
        'mainAgentAutoCompactPercentage',
        'mainAgentAutoCompactWindow',
        'mainAgentContextSource',
        'pluginAutoScan',
        'workspaceRoot',
      ].sort(),
    );
    await shot(page, info, 'host-integration-invalid');

    await field.fill('/srv/agents');
    await save.click();
    await expect(page.getByTestId('workspace-root-effective')).toContainText(
      '/srv/agents',
    );
    await expect(page.getByTestId('workspace-root-effective')).toContainText(
      '系统设置',
    );

    // Clearing it saves '' and goes back to the default.
    await field.fill('');
    await save.click();
    await expect(page.getByTestId('workspace-root-effective')).toContainText(
      '默认值',
    );
    expect(backend.puts.at(-1)?.workspaceRoot).toBe('');
  });

  test('workspace root: with the fallback unusable too, says new workspaces stay in data/groups', async ({
    page,
  }, info) => {
    await mockBackend(
      page,
      hostIntegration({
        workspaceRootEffective: null,
        workspaceRootFallbackReason: 'claude_md_ancestor',
        workspaceRootFallbackWarning: 'claude_md_ancestor',
      }),
    );
    await open(page, '/settings?tab=host-integration');
    const effective = page.getByTestId('workspace-root-effective');
    await expect(effective).toContainText('当前没有可用的根目录');
    await expect(effective).toContainText('data/groups/<文件夹>');
    await expect(effective).not.toContainText('当前生效');
    const notice = page.getByRole('status').filter({ hasText: '不能用' });
    await expect(notice).toContainText('CLAUDE.md');
    await expect(notice).not.toContainText('已改用上面的目录');
    await expect(
      page.getByText('备用目录 ~/happyclaw-workspaces 也不能用'),
    ).toBeVisible();
    await expect(page.getByLabel('工作区根目录')).toHaveAttribute(
      'placeholder',
      '',
    );
    await expectNoHorizontalOverflow(page);
    await shot(page, info, 'host-integration-no-root');
  });

  test('switching the deployment mode confirms, lists the users blocking it, then applies', async ({
    page,
  }, info) => {
    const backend = await mockBackend(page);
    backend.refuseSwitch = true;
    await open(page, '/settings?tab=host-integration');
    const single = page.getByRole('radio', { name: /单人宿主机/ });
    const multi = page.getByRole('radio', { name: /多人/ });
    await expect(multi).toBeChecked();

    // Cancelling changes nothing.
    await single.locator('xpath=..').click();
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    await expect(dialog).toContainText('切换到单人宿主机模式？');
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(multi).toBeChecked();
    expect(backend.puts).toHaveLength(0);

    await single.locator('xpath=..').click();
    await dialog.getByRole('button', { name: '切换' }).click();
    const refusal = page
      .getByRole('alert')
      .filter({ hasText: '请先停用其他账号' });
    await expect(refusal).toBeVisible();
    await expect(
      refusal.getByRole('list', { name: '仍在使用的其他账号' }),
    ).toContainText('alice');
    await expect(refusal).toContainText('viewer');
    await expect(multi).toBeChecked();
    await expectNoHorizontalOverflow(page);
    await shot(page, info, 'deployment-mode-refused');

    // With the others deactivated the switch goes through and the
    // multi-user sections leave the settings navigation.
    await single.locator('xpath=..').click();
    await dialog.getByRole('button', { name: '切换' }).click();
    await expect(single).toBeChecked();
    expect(backend.puts.at(-1)).toEqual({ deploymentMode: 'single_user_host' });
    await expect(refusal).toHaveCount(0);
    await expect(page.getByLabel('管理员纯宿主机模式')).toBeDisabled();
    await expect(page.getByLabel('管理员纯宿主机模式')).toBeChecked();
    if (!info.project.name.includes('mobile')) {
      await expect(
        settingsNav(page).getByText('用户与访问', { exact: true }),
      ).toHaveCount(0);
    }
    await shot(page, info, 'deployment-mode-single');
  });
});

test.describe('setup wizard', () => {
  test('asks how the instance will be used and sends it with the admin', async ({
    page,
  }, info) => {
    const backend = await mockBackend(page);
    await page.goto(`${HARNESS}?route=/setup&setup=1`);
    await expect(page.getByText('你打算怎么用？')).toBeVisible();
    const single = page.getByRole('radio', { name: /单人宿主机（推荐）/ });
    await expect(single).toBeChecked();
    // Each choice card is a comfortable tap target.
    for (const box of await page
      .locator('label:has(input[name="deployment_mode"])')
      .evaluateAll((labels) =>
        labels.map((label) => label.getBoundingClientRect().height),
      )) {
      expect(box).toBeGreaterThanOrEqual(44);
    }
    await expectNoHorizontalOverflow(page);
    await shot(page, info, 'setup');

    await page.getByRole('radio', { name: /多人/ }).locator('xpath=..').click();
    await page
      .getByRole('radio', { name: /单人宿主机/ })
      .locator('xpath=..')
      .click();
    await page.getByLabel('用户名').fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('password-123');
    await page.getByLabel('确认密码').fill('password-123');
    await page.getByRole('button', { name: '创建账号并下一步' }).click();
    await expect(routeProbe(page)).toHaveText('/setup/providers');
    expect(backend.setups).toEqual([
      {
        username: 'admin',
        password: 'password-123',
        deployment_mode: 'single_user_host',
      },
    ]);
  });
});
