import { expect, test, type Locator, type Page } from '@playwright/test';

// Multi-task mode (多任务模式) on a phone and in a desktop window: a session's
// delegated tasks follow its transcript with their status and latest
// summary, stop behind a confirmation and open their worker; a single-task
// workspace shows none of it; the 工作项 page lists delegated tasks apart;
// creating a workspace and its settings choose the work mode.

const HARNESS = '/tests/e2e/multitask-harness.html';
const WS = 'web:alpha';
const SHOTS = '/tmp/mt-web';

function item(
  seq: number,
  title: string,
  stage: string,
  overrides: Record<string, unknown> = {},
) {
  const ended = stage === 'ended';
  return {
    id: `wi-${seq}`,
    seq,
    workspaceJid: WS,
    workspaceFolder: 'alpha',
    workspaceName: 'Alpha 工作区',
    channelJid: `${WS}#agent:main`,
    channelName: null,
    agentId: `worker-${seq}`,
    title,
    sourceMessageId: `delegate:${seq}`,
    sourceRouteJid: `${WS}#agent:main`,
    origin: 'delegated',
    originAgentId: 'main',
    originInputId: 'web:alpha#agent:main-ask',
    originSessionName: '需求梳理',
    mandate: {
      strength: 'explicit',
      requesterImId: null,
      requesterName: '多任务测试',
      requesterListed: true,
      requesterIsOwner: true,
      matchedRules: [],
      settingsVersion: 0,
      writable: true,
    },
    status: ended ? 'ended' : 'open',
    outcome: ended ? 'completed' : null,
    lastReport: null,
    lastSummary: null,
    attention: null,
    attentionMessageId: null,
    approvedAt: null,
    createdAt: '2026-11-01T04:00:30.000Z',
    updatedAt: '2026-11-01T04:30:00.000Z',
    endedAt: null,
    stage,
    ...overrides,
  };
}

const LONG_SUMMARY =
  '已读完 12 个接口定义，正在按模块整理成表格：用户、订单、支付、库存、物流、营销、结算和报表八个模块，每个接口列出路径、参数、返回值、错误码和调用示例，预计还要十分钟。';

const items = [
  // Ended before the person last wrote (04:00): the chat no longer shows it.
  item(1, '补单元测试', 'ended', {
    outcome: 'stopped',
    endedAt: '2026-11-01T03:00:00.000Z',
  }),
  item(2, '升级依赖', 'ended', {
    lastSummary: '依赖已升级，测试全部通过。',
    endedAt: '2026-11-01T05:00:00.000Z',
  }),
  item(3, '整理接口文档', 'working', { lastSummary: LONG_SUMMARY }),
  item(4, '对比两套方案', 'answer', {
    lastReport: 'blocked',
    attention: '要不要把 Redis 集群方案也算进来？',
    lastSummary: '要不要把 Redis 集群方案也算进来？',
  }),
  // The single-task workspace's session, which must never show it.
  item(5, '切换前派出的任务', 'working', {
    workspaceJid: 'web:solo',
    workspaceFolder: 'solo',
    workspaceName: '单任务工作区',
    channelJid: 'web:solo#agent:solo-main',
    originAgentId: 'solo-main',
    originSessionName: '日常',
  }),
  // A team item, for the 工作项 page's other view.
  item(12, '修复登录页报错', 'working', {
    origin: 'team',
    originAgentId: null,
    originInputId: null,
    originSessionName: null,
    channelJid: 'feishu:oc_team',
    channelName: '研发群',
    sourceMessageId: 'om_12',
  }),
];

interface Calls {
  posts: string[];
  patches: { path: string; body: Record<string, unknown> }[];
  creates: Record<string, unknown>[];
  workItemReads: string[];
}

async function open(page: Page, route: string, query = ''): Promise<Calls> {
  const calls: Calls = {
    posts: [],
    patches: [],
    creates: [],
    workItemReads: [],
  };
  // The server's items for this page; a stop ends one for later reads.
  const served = items.map((entry) => ({ ...entry }));
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = decodeURIComponent(url.pathname);
      const workspaceItems = path.match(
        /^\/api\/workspaces\/([^/]+)\/work-items$/,
      );
      if (workspaceItems) {
        calls.workItemReads.push(workspaceItems[1]);
        const status = url.searchParams.get('status');
        return route.fulfill({
          json: {
            items: served.filter(
              (i) =>
                i.workspaceJid === workspaceItems[1] && i.status === status,
            ),
          },
        });
      }
      if (path.endsWith('/work-decisions'))
        return route.fulfill({ json: { decisions: [] } });
      const stop = path.match(/^\/api\/work-items\/([^/]+)\/stop$/);
      if (stop) {
        calls.posts.push(stop[1]);
        const current = served.find((i) => i.id === stop[1])!;
        Object.assign(current, {
          status: 'ended',
          outcome: 'stopped',
          stage: 'ended',
          endedAt: '2026-11-01T06:00:00.000Z',
          updatedAt: '2026-11-01T06:00:00.000Z',
        });
        return route.fulfill({ json: { item: current } });
      }
      const detail = path.match(/^\/api\/work-items\/([^/]+)$/);
      if (detail) {
        const found = served.find((i) => i.id === detail[1]);
        if (!found) return route.fulfill({ status: 404, json: {} });
        return route.fulfill({
          json: {
            item: found,
            events: [
              {
                id: 1,
                workItemId: found.id,
                kind: 'input',
                state: null,
                text: `${found.title}：按模块整理成表格`,
                triggerMessageId: 'assign-1',
                createdAt: '2026-11-01T04:00:30.000Z',
              },
            ],
            subscriptions: [],
          },
        });
      }
      if (path === `/api/groups/${WS}` && request.method() === 'PATCH') {
        const body = request.postDataJSON();
        calls.patches.push({ path, body });
        return route.fulfill({ json: { success: true, ...body } });
      }
      if (path === '/api/groups' && request.method() === 'POST') {
        const body = request.postDataJSON();
        calls.creates.push(body);
        return route.fulfill({
          json: {
            success: true,
            jid: 'web:new',
            group: {
              name: body.name,
              folder: 'new',
              added_at: '2026-11-01T00:00:00.000Z',
              interaction_mode: body.interaction_mode,
              work_mode: body.work_mode,
            },
          },
        });
      }
      // Whatever else the chat asks for (models, usage) is not this spec's.
      return route.fulfill({ status: 404, json: {} });
    },
  );
  await page.goto(`${HARNESS}${query}#${route}`);
  return calls;
}

const tasks = (page: Page) => page.getByRole('region', { name: '后台任务' });

async function expectNoSidewaysOverflow(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

async function expectFingerSized(locator: Locator) {
  const box = await locator.boundingBox();
  // Layout rounds a 44px box to a hair under it.
  expect(box!.width).toBeGreaterThanOrEqual(43.9);
  expect(box!.height).toBeGreaterThanOrEqual(43.9);
}

/** A tap anywhere in the 44×44 square around its centre lands on it. */
async function expectTapArea(locator: Locator) {
  const misses = await locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    return [
      [cx - 21, cy],
      [cx + 21, cy],
      [cx, cy - 21],
      [cx, cy + 21],
    ].filter(
      ([x, y]) => document.elementFromPoint(x, y)?.closest('button') !== node,
    );
  });
  expect(misses).toEqual([]);
}

/** The row of a task; a phone keeps its actions behind ⋯. */
async function openRowAction(
  page: Page,
  title: string,
  action: '查看' | '停止',
  isMobile: boolean,
) {
  const row = tasks(page).getByRole('listitem').filter({ hasText: title });
  if (isMobile) {
    const more = row.getByRole('button', { name: `${title} 的操作` });
    await expectTapArea(more);
    await more.click();
    await page
      .getByRole('dialog', { name: title })
      .getByRole('button', {
        name: action === '查看' ? '查看 Worker 会话' : '停止',
      })
      .click();
  } else {
    await row.getByRole('button', { name: action }).click();
  }
}

test('a multi-task session lists its delegated tasks after the transcript', async ({
  page,
}) => {
  await open(page, '/chat/alpha?agent=main');
  await expect(tasks(page)).toBeVisible();
  await expect(tasks(page)).toContainText('后台任务· 2 个进行中');
  await expect(tasks(page).getByRole('listitem')).toHaveText([
    /#2 升级依赖已完成依赖已升级/,
    /#3 整理接口文档进行中已读完 12 个接口定义/,
    /#4 对比两套方案等你回答要不要把 Redis 集群方案也算进来？/,
  ]);
  // The latest summary is cut to two lines; hovering shows all of it.
  const summary = tasks(page).getByTitle(LONG_SUMMARY);
  const lines = await summary.evaluate((node) => {
    const clamp = node.parentElement!;
    return (
      clamp.getBoundingClientRect().height /
      parseFloat(getComputedStyle(clamp).lineHeight)
    );
  });
  expect(lines).toBeLessThanOrEqual(2.05);
  // Below the last reply, above the composer.
  const reply = page.getByText('已派出 #3 整理接口文档');
  expect((await tasks(page).boundingBox())!.y).toBeGreaterThan(
    (await reply.boundingBox())!.y,
  );
  await expectNoSidewaysOverflow(page);
  await page.screenshot({
    path: `${SHOTS}/chat-cards-${test.info().project.name}.png`,
  });
});

test('stopping a task asks first; 查看 opens its worker', async ({
  page,
  isMobile,
}) => {
  const calls = await open(page, '/chat/alpha?agent=main');
  await openRowAction(page, '#3 整理接口文档', '停止', isMobile);
  const dialog = page.getByRole('alertdialog', {
    name: '停止 #3 整理接口文档？',
  });
  await expect(dialog).toContainText('Agent 会收到停止的通知');
  await dialog.getByRole('button', { name: '取消' }).click();
  expect(calls.posts).toEqual([]);

  await openRowAction(page, '#3 整理接口文档', '停止', isMobile);
  await dialog.getByRole('button', { name: '停止' }).click();
  await expect.poll(() => calls.posts).toEqual(['wi-3']);
  await expect(
    tasks(page).getByRole('listitem').filter({ hasText: '#3 整理接口文档' }),
  ).toContainText('已停止');

  await openRowAction(page, '#4 对比两套方案', '查看', isMobile);
  await expect(page.getByTestId('route')).toHaveText(
    '/chat/alpha?agent=worker-4',
  );
});

test('a single-task workspace shows nothing of it', async ({ page }) => {
  const calls = await open(page, '/chat/solo?agent=solo-main');
  await expect(page.getByText('你好！')).toBeVisible();
  await expect(tasks(page)).toHaveCount(0);
  await expect(page.getByText('后台任务')).toHaveCount(0);
  expect(calls.workItemReads).toEqual([]);
});

test('a guest reads the tasks and cannot stop them', async ({
  page,
  isMobile,
}) => {
  await open(page, '/chat/alpha?agent=main', '?role=guest');
  await expect(tasks(page).getByRole('listitem')).toHaveCount(3);
  if (isMobile) {
    await tasks(page)
      .getByRole('button', { name: '#3 整理接口文档 的操作' })
      .click();
    const sheet = page.getByRole('dialog', { name: '#3 整理接口文档' });
    await expect(
      sheet.getByRole('button', { name: '查看 Worker 会话' }),
    ).toBeVisible();
    await expect(sheet.getByRole('button', { name: '停止' })).toHaveCount(0);
  } else {
    await expect(tasks(page).getByRole('button', { name: '查看' })).toHaveCount(
      3,
    );
    await expect(tasks(page).getByRole('button', { name: '停止' })).toHaveCount(
      0,
    );
  }
});

test('leaving multi-task with tasks out warns, then the cards go', async ({
  page,
  isMobile,
}) => {
  const calls = await open(page, '/chat/alpha?agent=main');
  await expect(tasks(page)).toBeVisible();
  if (isMobile) {
    await page.getByRole('button', { name: '更多选项' }).click();
    await page.getByRole('button', { name: '工作区设置' }).click();
  } else {
    await page.getByRole('button', { name: '工作区设置' }).click();
  }
  const dialog = page.getByRole('dialog', { name: '工作区设置' });
  const workMode = dialog.getByRole('group', { name: '工作方式' });
  await expect(workMode.getByRole('radio', { name: /多任务/ })).toBeChecked();
  await expect(dialog).not.toContainText('之后不再派新任务');
  await workMode.getByText('单任务（默认）').click();
  await expect(dialog.getByRole('status')).toHaveText(
    '已派出的任务会继续完成并汇报，之后不再派新任务。',
  );
  await expectNoSidewaysOverflow(page);
  await page.screenshot({
    path: `${SHOTS}/settings-${test.info().project.name}.png`,
  });
  await dialog.getByRole('button', { name: '保存更改' }).click();
  await expect
    .poll(() => calls.patches)
    .toEqual([{ path: `/api/groups/${WS}`, body: { work_mode: 'single' } }]);
  await expect(dialog).toBeHidden();
  await expect(tasks(page)).toHaveCount(0);
});

test('工作项: delegated tasks list apart from the team items', async ({
  page,
  isMobile,
}) => {
  await open(page, '/work');
  const views = page.getByRole('group', { name: '工作项来源' });
  await expect(
    views.getByRole('button', { name: '团队工作项' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', { name: /#12 修复登录页报错/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /#3 整理接口文档/ }),
  ).toHaveCount(0);
  if (isMobile)
    await expectFingerSized(views.getByRole('button', { name: '派出的任务' }));

  await views.getByRole('button', { name: '派出的任务' }).click();
  await expect(
    page.getByRole('button', { name: /#12 修复登录页报错/ }),
  ).toHaveCount(0);
  const row = page.getByRole('button', { name: /#3 整理接口文档/ });
  await expect(row).toContainText('进行中');
  await expect(row).toContainText('Alpha 工作区 · 需求梳理');
  await expect(page.getByRole('region', { name: '需要我处理' })).toContainText(
    '#4 对比两套方案',
  );
  await expectNoSidewaysOverflow(page);
  await page.screenshot({
    path: `${SHOTS}/work-delegated-${test.info().project.name}.png`,
  });

  await row.click();
  await expect(page.getByTestId('route')).toHaveText('/work/wi-3');
  const detail = isMobile ? page.locator('body') : page.locator('main').last();
  await expect(detail).toContainText('来源会话');
  await expect(detail).toContainText('需求梳理');
  await expect(detail).toContainText('整理接口文档：按模块整理成表格');
  await expect(detail).not.toContainText('订阅的话题');
  await expectNoSidewaysOverflow(page);
});

test('a new workspace chooses its work mode, single by default', async ({
  page,
  isMobile,
}) => {
  const calls = await open(page, '/create');
  const dialog = page.getByRole('dialog', { name: '为智能体新建工作区' });
  const workMode = dialog.getByRole('group', { name: '工作方式' });
  await expect(workMode.getByRole('radio', { name: /单任务/ })).toBeChecked();
  await expect(workMode).toContainText(
    '消息按顺序处理，一条处理完再处理下一条。',
  );
  const choices = workMode.locator('label');
  await expect(choices).toHaveCount(2);
  if (isMobile)
    for (const choice of await choices.all()) await expectFingerSized(choice);

  await workMode.getByText('多任务').click();
  await expect(workMode).toContainText(
    '较大的任务交给后台 Worker 处理，对话不会被卡住，完成后由 Agent 汇报结果。',
  );
  await expectNoSidewaysOverflow(page);
  await page.screenshot({
    path: `${SHOTS}/create-${test.info().project.name}.png`,
  });
  await dialog.getByLabel('工作区名称').fill('并行调研');
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(page.getByTestId('created')).toHaveText('web:new');
  expect(calls.creates).toEqual([
    expect.objectContaining({ name: '并行调研', work_mode: 'multi' }),
  ]);
});
