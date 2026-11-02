// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { UnifiedProviderPublic, WebFetchPreflightPolicy } from './types';
import { button, click, flush, makeProvider, text, type } from './test-helpers';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    put: mocks.put,
  },
}));
vi.mock('../../stores/confirm', () => ({ confirmDialog: mocks.confirm }));

const { ConnectionDetailDialog } = await import('./ConnectionDetailDialog');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROVIDERS = '/api/config/claude/providers';

let root: Root;
let container: HTMLDivElement;
const onChanged = vi.fn();
const onClose = vi.fn();
const setNotice = vi.fn();
const setError = vi.fn();

/** GET answers: the impact count, else the catalog request fails (offline). */
function answerGets(stoppedRunners = 2) {
  mocks.get.mockImplementation(async (path: string) => {
    if (path.endsWith('/impact')) return { activeRunners: 1, stoppedRunners };
    throw new Error('offline');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  answerGets();
  mocks.confirm.mockResolvedValue(true);
  mocks.patch.mockImplementation(async (_path: string, body: object) => ({
    provider: { ...current, ...body, updatedAt: 'later' },
  }));
  mocks.put.mockResolvedValue({});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

let current: UnifiedProviderPublic;

async function render(provider: UnifiedProviderPublic | null) {
  if (provider) current = provider;
  await act(async () => {
    root.render(
      <ConnectionDetailDialog
        provider={provider}
        onClose={onClose}
        onChanged={onChanged}
        setNotice={setNotice}
        setError={setError}
      />,
    );
  });
  await flush();
}

const officialProvider = makeProvider({
  id: 'claude',
  name: 'Claude 官方',
  type: 'official',
  anthropicBaseUrl: '',
  anthropicModel: '',
  anthropicAuthMode: null,
  hasAnthropicAuthToken: false,
  anthropicAuthTokenMasked: null,
  hasClaudeOAuthCredentials: true,
  claudeOAuthCredentialsExpiresAt: Date.now() - 1000,
  claudeOAuthCredentialsAccessTokenMasked: 'sk-a***',
  claudeAuthKind: 'oauth',
  claudeOAuthAccountEmail: 'owner@example.com',
  claudeOAuthSubscriptionType: 'max',
  claudeOAuthNeedsReLogin: true,
  claudeOAuthLastRefreshError: {
    kind: 'invalid_grant',
    message: 'Refresh token was revoked',
    at: 1,
  },
  models: [{ id: 'opus' }, { id: 'sonnet' }],
});

const codexProvider = makeProvider({
  id: 'chatgpt',
  name: 'ChatGPT 订阅',
  anthropicBaseUrl: '__codex_gateway__',
  anthropicModel: 'gpt-6-sol',
  anthropicAuthMode: null,
  hasCodexOAuthCredentials: true,
  codexOAuthCredentialsExpiresAt: Date.now() + 3_600_000,
  codexOAuthCredentialsEmail: 'owner@example.com',
  codexOAuthCredentialsPlanType: 'pro',
  codexOAuthNeedsReauth: true,
  codexOAuthLastRefreshError: {
    kind: 'reauth_required',
    message: 'refresh_token_reused',
    at: '2026-10-11T00:00:00.000Z',
  },
  codexDefaultEffort: 'high',
  models: [],
});

const legacyProvider = makeProvider({
  id: 'glm',
  name: 'GLM',
  anthropicBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
  anthropicModel: 'glm-5.3',
  anthropicAuthMode: null,
  anthropicAuthTokenMasked: 'glm-***',
  models: [{ id: 'glm-5.3' }, { id: 'glm-5.2', defaultEffort: 'max' }],
  customEnv: { API_TIMEOUT_MS: '3000000', MY_FLAG: 'on' },
});

function select(selector: string): HTMLSelectElement {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`${selector} not found`);
  return element as HTMLSelectElement;
}

async function choose(selector: string, value: string) {
  await act(async () => {
    const element = select(selector);
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('Claude subscription', () => {
  test('shows the account and a needed re-login', async () => {
    await render(officialProvider);
    expect(text()).toContain('授权已失效，需要重新登录 Claude');
    expect(text()).toContain('Refresh token was revoked');
    expect(text()).toContain('owner@example.com（max）');
    expect(text()).toContain('需重新登录');
  });

  test('a pasted credential is sent raw for the server to parse, after confirming', async () => {
    await render(officialProvider);
    await type(
      '#connection-secret',
      '  {"claudeAiOauth":{"accessToken":"a"}}  ',
    );
    await click(button('保存连接设置'));
    await flush();
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.put).toHaveBeenCalledWith(
      `${PROVIDERS}/claude/secrets`,
      { claudeCredentialInput: '{"claudeAiOauth":{"accessToken":"a"}}' },
      120_000,
    );
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  test('the setup-token login asks the server for that profile', async () => {
    mocks.post.mockResolvedValue({
      authorizeUrl: 'https://x.test',
      state: 's',
    });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await render(officialProvider);
    await click(button('改为获取 1 年期 Setup Token'));
    expect(mocks.post).toHaveBeenCalledWith('/api/config/claude/oauth/start', {
      targetProviderId: 'claude',
      profile: 'setup_token',
    });
    expect(open).toHaveBeenCalledWith(
      'https://x.test',
      '_blank',
      'noopener,noreferrer',
    );
  });

  test('the test button runs an account check and reloads the status', async () => {
    mocks.post.mockResolvedValue({
      ok: true,
      probes: [],
      code: null,
      record: {
        ok: true,
        code: null,
        status: 200,
        model: null,
        latencyMs: 80,
        at: '2026-10-28T00:00:00.000Z',
      },
    });
    await render(officialProvider);
    expect(text()).toContain('不消耗额度');
    await click(button('测试连接'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      `${PROVIDERS}/test`,
      { providerId: 'claude' },
      60_000,
    );
    expect(text()).toContain('连接成功');
    // Read again: the server may have stored the header the test proved.
    expect(onChanged).toHaveBeenCalledWith();
  });
});

describe('ChatGPT subscription', () => {
  test('flags a refused refresh and keeps the effective default effort', async () => {
    await render(codexProvider);
    // The account's own plan-filtered catalog, not the global one.
    expect(mocks.get).toHaveBeenCalledWith(
      '/api/config/codex/model-catalog?providerId=chatgpt',
    );
    expect(text()).toContain('ChatGPT 授权已失效，请重新登录');
    expect(text()).toContain('refresh_token_reused');
    expect(select('#codex-effort-select').value).toBe('high');
    // Nothing changed yet: nothing to save.
    expect(button('保存默认模型').disabled).toBe(true);

    await choose('#codex-effort-select', 'medium');
    await click(button('保存默认模型'));
    await flush();
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/chatgpt`,
      { customEnv: { CODEX_REASONING_EFFORT: 'medium' } },
      120_000,
    );
  });

  test('the offline catalog marks the same default effort as the server', async () => {
    await render({
      ...codexProvider,
      anthropicModel: 'gpt-6-astra',
      codexOAuthNeedsReauth: false,
      codexOAuthLastRefreshError: null,
      codexDefaultEffort: undefined,
    });
    const effort = select('#codex-effort-select');
    // No stored or resolved effort: the catalog default (gpt-6.1-sol's) applies.
    expect(effort.value).toBe('low');
    expect(
      [...effort.options].find((option) => option.text.endsWith('（默认）'))
        ?.value,
    ).toBe('low');
    expect(
      [...select('#codex-model-select').options]
        .slice(0, 3)
        .map((option) => option.value),
    ).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol']);
  });

  test('a spent code sends the user back to log in again', async () => {
    mocks.post
      .mockResolvedValueOnce({ authorizeUrl: 'https://x.test', state: 's' })
      .mockRejectedValueOnce({
        status: 400,
        message: '授权码已失效',
        body: { retryable: false },
      });
    vi.spyOn(window, 'open').mockReturnValue(null);
    await render(codexProvider);
    await click(button('重新登录 ChatGPT'));
    await type(
      'input[aria-label^="粘贴 localhost:1455"]',
      'http://localhost:1455/auth/callback?code=c&state=s',
    );
    await click(button('确认'));
    await flush();
    expect(text()).toContain('授权码已失效');
    expect(button('重新登录 ChatGPT')).toBeTruthy();
  });
});

describe('third-party connection settings', () => {
  test('a new key is saved in one PATCH and a legacy auth mode is kept', async () => {
    await render(legacyProvider);
    await type('#connection-secret', 'glm-new-key');
    await click(button('保存连接设置'));
    await flush();
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      { anthropicAuthToken: 'glm-new-key' },
      120_000,
    );
    expect(mocks.put).not.toHaveBeenCalled();
  });

  test('the confirmation states the runners it stops and that history is kept', async () => {
    await render(legacyProvider);
    await type('#connection-base-url', 'https://open.bigmodel.cn/api/paas');
    await click(button('保存连接设置'));
    await flush();
    expect(mocks.get).toHaveBeenCalledWith(`${PROVIDERS}/glm/impact`);
    const message = mocks.confirm.mock.calls[0][0].message as string;
    expect(message).toContain('保存会停止 2 个运行中的会话');
    expect(message).toContain('下一条消息会开启新的 SDK 会话，聊天记录保留');
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      { anthropicBaseUrl: 'https://open.bigmodel.cn/api/paas' },
      120_000,
    );
  });

  test('with nothing to stop the confirmation skips the count; declining saves nothing', async () => {
    answerGets(0);
    mocks.confirm.mockResolvedValue(false);
    await render(legacyProvider);
    await type('#connection-secret', 'k');
    await click(button('保存连接设置'));
    await flush();
    const message = mocks.confirm.mock.calls[0][0].message as string;
    expect(message).not.toContain('停止');
    expect(message).toContain('聊天记录保留');
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  test('a preset connection keeps its address read-only', async () => {
    await render(
      makeProvider({
        presetId: 'deepseek',
        anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
      }),
    );
    const url = document.querySelector(
      '#connection-base-url',
    ) as HTMLInputElement;
    expect(url.readOnly).toBe(true);
    expect(text()).toContain('「DeepSeek」预设的地址');
  });

  test('the select follows a header a test stored, unless the user picked one', async () => {
    await render(legacyProvider);
    const select = () =>
      document.querySelector('#connection-auth-mode') as HTMLSelectElement;
    expect(select().value).toBe('auto');
    // The test stored the header it proved; the reload brings it in.
    await render({
      ...legacyProvider,
      anthropicAuthMode: 'x-api-key',
      updatedAt: 'after-test',
    });
    expect(select().value).toBe('x-api-key');
    // Nothing to save: the stored header is not wiped back to automatic.
    expect(button('保存连接设置').disabled).toBe(true);

    // A header the user picked stays picked across another reload.
    await choose('#connection-auth-mode', 'bearer');
    await render({
      ...legacyProvider,
      anthropicAuthMode: 'x-api-key',
      updatedAt: 'again',
    });
    expect(select().value).toBe('bearer');
    expect(button('保存连接设置').disabled).toBe(false);
  });

  test('the auth header can be set, or handed back to the automatic fallback', async () => {
    await render(legacyProvider);
    const select = () =>
      document.querySelector('#connection-auth-mode') as HTMLSelectElement;
    // No stored header: automatic.
    expect(select().value).toBe('auto');
    await choose('#connection-auth-mode', 'x-api-key');
    await click(button('保存连接设置'));
    await flush();
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      { anthropicAuthMode: 'x-api-key' },
      120_000,
    );

    await act(async () => root.unmount());
    root = createRoot(container);
    mocks.patch.mockClear();
    await render({ ...legacyProvider, anthropicAuthMode: 'bearer' });
    expect(select().value).toBe('bearer');
    await choose('#connection-auth-mode', 'auto');
    await click(button('保存连接设置'));
    await flush();
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      { anthropicAuthMode: null },
      120_000,
    );
  });
});

describe('environment', () => {
  test('shows the stored rows; an emptied one is dropped on save', async () => {
    await render(legacyProvider);
    expect(
      (
        document.querySelector(
          'input[aria-label="第 1 行环境变量 Key"]',
        ) as HTMLInputElement
      ).value,
    ).toBe('API_TIMEOUT_MS');
    await type('input[aria-label="第 1 行环境变量值"]', '');
    await click(button('保存连接设置'));
    await flush();
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      { customEnv: { MY_FLAG: 'on' } },
      120_000,
    );
  });

  test('a model key is refused before anything is sent', async () => {
    await render(legacyProvider);
    await type(
      'input[aria-label="第 2 行环境变量 Key"]',
      'CLAUDE_CODE_SUBAGENT_MODEL',
    );
    expect(text()).toContain('CLAUDE_CODE_SUBAGENT_MODEL 由模型设置决定');
    await click(button('保存连接设置'));
    await flush();
    expect(setError).toHaveBeenCalledWith(
      expect.stringContaining('由模型设置决定'),
    );
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});

describe('model list', () => {
  test('no default, show-in-chat or 1M controls are left', async () => {
    await render(legacyProvider);
    expect(document.querySelector('[role="switch"]')).toBeNull();
    expect(text()).not.toContain('设为默认模型');
    expect(text()).not.toContain('1M 上下文');
  });

  test('the suggestion fills the registry window in one tap', async () => {
    await render(legacyProvider);
    await click(
      [...document.querySelectorAll('button')].find(
        (node) =>
          node.textContent === '建议：1M' &&
          node.parentElement?.textContent?.includes('上下文') &&
          node.closest('li')?.textContent?.startsWith('glm-5.2'),
      ),
    );
    await flush();
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      {
        models: [
          { id: 'glm-5.3' },
          { id: 'glm-5.2', defaultEffort: 'max', contextWindow: 1_000_000 },
        ],
      },
      120_000,
    );
  });

  test('a context window is saved per model, without asking', async () => {
    await render(legacyProvider);
    await choose('select[aria-label="glm-5.2 的上下文长度"]', '128000');
    await flush();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      {
        models: [
          { id: 'glm-5.3' },
          { id: 'glm-5.2', defaultEffort: 'max', contextWindow: 128_000 },
        ],
      },
      120_000,
    );
  });

  test('the default effort lists only the model’s efforts', async () => {
    await render(legacyProvider);
    const options = [
      ...select('select[aria-label="glm-5.2 的默认档位"]').options,
    ].map((option) => option.value);
    // The registry gives glm-5.2 high and max.
    expect(options).toEqual(['', 'high', 'max']);
    expect(select('select[aria-label="glm-5.2 的默认档位"]').value).toBe('max');
    await choose('select[aria-label="glm-5.2 的默认档位"]', '');
    await flush();
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      { models: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }] },
      120_000,
    );
  });

  test('declaring efforts drops a default the model no longer has', async () => {
    await render(legacyProvider);
    const chip = [
      ...document
        .querySelector('[role="group"][aria-label="glm-5.2 的推理等级"]')!
        .querySelectorAll('button'),
    ].find((node) => node.textContent === '最高');
    await click(chip);
    await flush();
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      { models: [{ id: 'glm-5.3' }, { id: 'glm-5.2', efforts: ['high'] }] },
      120_000,
    );
  });

  test('removing the connection model asks, and hands it on', async () => {
    await render(legacyProvider);
    await click(
      document.querySelector('button[aria-label="从连接中删除 glm-5.3"]'),
    );
    await flush();
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      {
        models: [{ id: 'glm-5.2', defaultEffort: 'max' }],
        anthropicModel: 'glm-5.2',
        roles: {},
      },
      120_000,
    );
  });

  test('the last model cannot be removed', async () => {
    await render(makeProvider());
    expect(
      document
        .querySelector('button[aria-label="连接至少保留一个模型"]')
        ?.hasAttribute('disabled'),
    ).toBe(true);
  });

  test('removing a model an Agent uses names the Agent and keeps the model', async () => {
    mocks.patch.mockRejectedValue({
      status: 409,
      message: 'model in use',
      body: {
        code: 'MODEL_IN_USE',
        agents: [{ id: 'a1', name: '写作助手' }],
      },
    });
    await render(legacyProvider);
    await click(
      document.querySelector('button[aria-label="从连接中删除 glm-5.2"]'),
    );
    await flush();
    expect(setError).toHaveBeenCalledWith(
      expect.stringContaining('智能体「写作助手」'),
    );
    expect(text()).toContain('glm-5.2');
  });

  test('获取模型列表 only adds, carrying what the vendor declares', async () => {
    mocks.post.mockResolvedValue({
      ok: true,
      source: 'endpoint',
      models: [
        { id: 'glm-5.3', contextWindow: 128_000 },
        { id: 'glm-5.4', contextWindow: 400_000, efforts: ['high'] },
        { id: 'vendor-new' },
      ],
    });
    await render(legacyProvider);
    await click(button('获取模型列表'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      `${PROVIDERS}/discover-models`,
      { providerId: 'glm' },
      45_000,
    );
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      {
        models: [
          { id: 'glm-5.3' },
          { id: 'glm-5.2', defaultEffort: 'max' },
          { id: 'glm-5.4', contextWindow: 400_000, efforts: ['high'] },
          // Unknown: every effort declared, like the add flow.
          {
            id: 'vendor-new',
            efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
        ],
      },
      120_000,
    );
    expect(setNotice).toHaveBeenCalledWith('新增 2 个模型');
  });

  test('a model already listed is not added twice, [1m] or not', async () => {
    await render(legacyProvider);
    await type('input[aria-label="手动添加模型"]', 'glm-5.2[1m]');
    await click(button('添加'));
    await flush();
    expect(setError).toHaveBeenCalledWith('列表里已经有 glm-5.2');
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  test('a manual model is added without asking', async () => {
    await render(legacyProvider);
    await type('input[aria-label="手动添加模型"]', 'glm-6[1m]');
    await click(button('添加'));
    await flush();
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      {
        models: [
          { id: 'glm-5.3' },
          { id: 'glm-5.2', defaultEffort: 'max' },
          {
            id: 'glm-6',
            contextWindow: 1_000_000,
            efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
        ],
      },
      120_000,
    );
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});

describe('后台与子代理', () => {
  test('roles are picked from the connection’s models and saved at once', async () => {
    await render({ ...legacyProvider, roles: { smallFast: 'glm-5.2' } });
    expect(select('#connection-role-smallFast').value).toBe('glm-5.2');
    expect(select('#connection-role-subagent').value).toBe('');
    expect(
      [...select('#connection-role-subagent').options].map((o) => o.value),
    ).toEqual(['', 'glm-5.3', 'glm-5.2']);
    await choose('#connection-role-subagent', 'glm-5.3');
    await flush();
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      { roles: { smallFast: 'glm-5.2', subagent: 'glm-5.3' } },
      120_000,
    );
    await choose('#connection-role-smallFast', '');
    await flush();
    expect(mocks.patch).toHaveBeenLastCalledWith(
      `${PROVIDERS}/glm`,
      { roles: { subagent: 'glm-5.3' } },
      120_000,
    );
  });

  test('an official refresh does not declare the vendor window (the 1M opt-in)', async () => {
    mocks.post.mockResolvedValue({
      ok: true,
      source: 'endpoint',
      models: [{ id: 'claude-opus-5-5', contextWindow: 1_000_000 }],
    });
    await render(officialProvider);
    await click(button('获取模型列表'));
    await flush();
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/claude`,
      {
        models: [{ id: 'opus' }, { id: 'sonnet' }, { id: 'claude-opus-5-5' }],
      },
      120_000,
    );
  });

  test('official connections have no roles', async () => {
    await render(officialProvider);
    expect(text()).not.toContain('后台与子代理');
  });
});

describe('connection WebFetch policy', () => {
  const field = '#connection-web-fetch-preflight';

  function answerPolicyGets(provider: UnifiedProviderPublic | undefined) {
    mocks.get.mockImplementation(async (path: string) => {
      if (path === PROVIDERS) {
        return {
          providers: [
            makeProvider({ id: 'unrelated', webFetchPreflightPolicy: 'check' }),
            ...(provider ? [provider] : []),
          ],
        };
      }
      if (path.endsWith('/impact'))
        return { activeRunners: 1, stoppedRunners: 2 };
      throw new Error('offline');
    });
  }

  test.each([
    ['Claude subscription', officialProvider],
    [
      'Anthropic API',
      makeProvider({
        type: 'official',
        claudeAuthKind: 'api_key',
        hasAnthropicApiKey: true,
      }),
    ],
    ['ChatGPT subscription', codexProvider],
    ['preset', makeProvider({ presetId: 'deepseek' })],
    ['custom', legacyProvider],
  ])('shows the policy and saves it for %s', async (_kind, provider) => {
    const persisted = { ...provider, webFetchPreflightPolicy: 'skip' as const };
    answerPolicyGets(persisted);
    await render(provider);
    expect(select(field).value).toBe('check');
    expect([...select(field).options].map((option) => option.text)).toEqual([
      '开启检查（默认）',
      '跳过检查',
    ]);
    expect(button('保存连接设置').disabled).toBe(true);
    await choose(field, 'skip');
    await click(button('保存连接设置'));
    await flush();
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/${provider.id}`,
      { webFetchPreflightPolicy: 'skip' },
      120_000,
    );
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalledWith(
      `${PROVIDERS}/${provider.id}/impact`,
    );
    expect(mocks.get).toHaveBeenCalledWith(PROVIDERS);
    expect(onChanged).toHaveBeenCalledWith(persisted);
    expect(setNotice).toHaveBeenCalledWith(
      '网页抓取设置已保存，新消息将使用新设置',
    );
  });

  test.each([undefined, 'inherit'] as const)(
    'shows check for a legacy %s policy without writing',
    async (policy) => {
      await render({
        ...legacyProvider,
        webFetchPreflightPolicy: policy,
      } as unknown as UnifiedProviderPublic);
      expect(select(field).value).toBe('check');
      expect([...select(field).options].map((option) => option.value)).toEqual([
        'check',
        'skip',
      ]);
      expect(text()).not.toContain('遵循原生配置');
      expect(button('保存连接设置').disabled).toBe(true);
      expect(mocks.patch).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['check', 'skip'],
    ['skip', 'check'],
  ] as const)(
    'persists %s → %s and shows the saved value after reopening',
    async (from, to) => {
      const provider = { ...legacyProvider, webFetchPreflightPolicy: from };
      const persisted = { ...provider, webFetchPreflightPolicy: to };
      answerPolicyGets(persisted);
      await render(provider);
      expect(select(field).value).toBe(from);
      await choose(field, to);
      await click(button('保存连接设置'));
      await flush();
      expect(onChanged).toHaveBeenCalledWith(persisted);
      await render(null);
      await render(persisted);
      expect(select(field).value).toBe(to);
      expect(button('保存连接设置').disabled).toBe(true);
    },
  );

  test('does not write a cancelled draft or carry it to another connection', async () => {
    await render(legacyProvider);
    await choose(field, 'skip');
    await render(null);
    await render({ ...officialProvider, webFetchPreflightPolicy: 'check' });
    expect(select(field).value).toBe('check');
    expect(button('保存连接设置').disabled).toBe(true);
    await render(legacyProvider);
    expect(select(field).value).toBe('check');
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalledWith(PROVIDERS);
  });

  test('follows a reloaded value until a local draft is made', async () => {
    await render(legacyProvider);
    await render({ ...legacyProvider, webFetchPreflightPolicy: 'skip' });
    expect(select(field).value).toBe('skip');
    await choose(field, 'check');
    await render({ ...legacyProvider, webFetchPreflightPolicy: 'skip' });
    expect(select(field).value).toBe('check');
    expect(button('保存连接设置').disabled).toBe(false);
  });

  test.each([
    'patch',
    'readback',
    'missing connection',
    'missing field',
    'mismatch',
  ])('keeps the draft retryable after %s failure', async (failure) => {
    const persisted = {
      ...legacyProvider,
      webFetchPreflightPolicy: 'skip' as const,
    };
    if (failure === 'patch') {
      mocks.patch.mockRejectedValueOnce(new Error('write failed'));
    } else if (failure === 'readback') {
      mocks.get.mockRejectedValue(new Error('read failed'));
    } else {
      answerPolicyGets(
        failure === 'missing connection'
          ? undefined
          : failure === 'missing field'
            ? legacyProvider
            : { ...persisted, webFetchPreflightPolicy: 'check' },
      );
    }
    await render(legacyProvider);
    await choose(field, 'skip');
    await click(button('保存连接设置'));
    await flush();
    expect(select(field).value).toBe('skip');
    expect(button('保存连接设置').disabled).toBe(false);
    expect(onChanged).not.toHaveBeenCalled();
    expect(setNotice).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalled();

    answerPolicyGets(persisted);
    await click(button('保存连接设置'));
    await flush();
    expect(onChanged).toHaveBeenCalledWith(persisted);
  });

  test.each([undefined, 'inherit'] as const)(
    'does not accept a legacy %s readback as a confirmed check save',
    async (policy) => {
      await render({ ...legacyProvider, webFetchPreflightPolicy: 'skip' });
      answerPolicyGets({
        ...legacyProvider,
        webFetchPreflightPolicy: policy,
      } as unknown as UnifiedProviderPublic);
      await choose(field, 'check');
      await click(button('保存连接设置'));
      await flush();
      expect(setError).toHaveBeenCalledWith('未确认网页抓取设置已保存，请重试');
      expect(onChanged).not.toHaveBeenCalled();
      expect(select(field).value).toBe('check');
      expect(button('保存连接设置').disabled).toBe(false);
    },
  );

  test.each(['readback', 'persisted 503'])(
    'can restore the previous policy after an unconfirmed %s save',
    async (failure) => {
      const provider = {
        ...legacyProvider,
        webFetchPreflightPolicy: 'check' as const,
      };
      await render(provider);
      if (failure === 'readback') {
        mocks.get.mockRejectedValue(new Error('read failed'));
      } else {
        mocks.patch.mockRejectedValueOnce({
          status: 503,
          message: '设置已保存，运行时刷新失败',
          body: { persisted: true },
        });
      }
      await choose(field, 'skip');
      await click(button('保存连接设置'));
      await flush();

      // The failed response did not update the cached check value. The
      // server may already hold skip, so choosing check is still a write.
      await choose(field, 'check');
      expect(button('保存连接设置').disabled).toBe(false);
      expect(text()).toContain('上次网页抓取设置保存尚未确认');
      answerPolicyGets(provider);
      await click(button('保存连接设置'));
      await flush();
      expect(mocks.patch).toHaveBeenLastCalledWith(
        `${PROVIDERS}/glm`,
        { webFetchPreflightPolicy: 'check' },
        120_000,
      );
      expect(onChanged).toHaveBeenCalledWith(provider);
      await render(provider);
      expect(button('保存连接设置').disabled).toBe(true);
      expect(text()).not.toContain('上次网页抓取设置保存尚未确认');
    },
  );

  test('a background reload cannot confirm a policy whose save did not finish', async () => {
    await render(legacyProvider);
    mocks.patch.mockRejectedValueOnce({
      status: 503,
      message: '设置已保存，运行时刷新失败',
      body: { persisted: true },
    });
    await choose(field, 'skip');
    await click(button('保存连接设置'));
    await flush();

    const persisted = {
      ...legacyProvider,
      webFetchPreflightPolicy: 'skip' as const,
    };
    // A connection test may reload the persisted fields even though the
    // previous update never confirmed that the runner refresh succeeded.
    await render(persisted);
    expect(select(field).value).toBe('skip');
    expect(button('保存连接设置').disabled).toBe(false);
    expect(text()).toContain('上次网页抓取设置保存尚未确认');
    answerPolicyGets(persisted);
    await click(button('保存连接设置'));
    await flush();
    expect(mocks.patch).toHaveBeenLastCalledWith(
      `${PROVIDERS}/glm`,
      { webFetchPreflightPolicy: 'skip' },
      120_000,
    );
    expect(onChanged).toHaveBeenCalledWith(persisted);
    expect(button('保存连接设置').disabled).toBe(true);
    expect(text()).not.toContain('上次网页抓取设置保存尚未确认');
  });

  test('can restore the policy when its save succeeded but official credentials failed', async () => {
    const provider = makeProvider({
      id: 'official-api',
      type: 'official',
      claudeAuthKind: 'api_key',
      hasAnthropicApiKey: true,
      webFetchPreflightPolicy: 'check',
    });
    answerPolicyGets({ ...provider, webFetchPreflightPolicy: 'skip' });
    mocks.put.mockRejectedValueOnce(new Error('credential write failed'));
    await render(provider);
    await choose(field, 'skip');
    await type('#connection-secret', 'new-api-key');
    await click(button('保存连接设置'));
    await flush();
    expect(mocks.get).toHaveBeenCalledWith(PROVIDERS);
    expect(mocks.put).toHaveBeenCalledWith(
      `${PROVIDERS}/official-api/secrets`,
      { anthropicApiKey: 'new-api-key' },
      120_000,
    );
    expect(onChanged).not.toHaveBeenCalled();
    expect(setNotice).not.toHaveBeenCalled();

    // Discarding both edits still needs to undo the already-persisted policy.
    await type('#connection-secret', '');
    await choose(field, 'check');
    expect(button('保存连接设置').disabled).toBe(false);
    expect(text()).toContain('上次网页抓取设置保存尚未确认');
    answerPolicyGets(provider);
    await click(button('保存连接设置'));
    await flush();
    expect(mocks.patch).toHaveBeenLastCalledWith(
      `${PROVIDERS}/official-api`,
      { webFetchPreflightPolicy: 'check' },
      120_000,
    );
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith(provider);
    expect(button('保存连接设置').disabled).toBe(true);
    expect(text()).not.toContain('上次网页抓取设置保存尚未确认');
  });

  test('keeps the confirmed policy when a post-credential list refresh fails', async () => {
    const { ClaudeProviderSection } = await import('./ClaudeProviderSection');
    const provider = makeProvider({
      id: 'official-api',
      name: '官方 API',
      type: 'official',
      claudeAuthKind: 'api_key',
      hasAnthropicApiKey: true,
      webFetchPreflightPolicy: 'check',
    });
    const persisted = { ...provider, webFetchPreflightPolicy: 'skip' as const };
    current = provider;
    let lists = 0;
    mocks.get.mockImplementation(async (path: string) => {
      if (path === PROVIDERS) {
        lists += 1;
        if (lists === 1) return { providers: [provider] };
        if (lists === 2) return { providers: [persisted] };
        throw new Error('list refresh failed');
      }
      if (path.endsWith('/impact'))
        return { activeRunners: 1, stoppedRunners: 2 };
      throw new Error('offline');
    });
    await act(async () => {
      root.render(
        <ClaudeProviderSection setNotice={setNotice} setError={setError} />,
      );
    });
    await flush();
    await click(
      document.querySelector('[role="button"][aria-label="编辑「官方 API」"]'),
    );
    await choose(field, 'skip');
    await type('#connection-secret', 'new-api-key');
    await click(button('保存连接设置'));
    await flush();

    expect(mocks.put).toHaveBeenCalledWith(
      `${PROVIDERS}/official-api/secrets`,
      { anthropicApiKey: 'new-api-key' },
      120_000,
    );
    expect(lists).toBe(3);
    expect(setError).toHaveBeenCalledWith('list refresh failed');
    expect(select(field).value).toBe('skip');
    expect(button('保存连接设置').disabled).toBe(true);
    expect(text()).not.toContain('上次网页抓取设置保存尚未确认');
  });

  test('keeps the protocol confirmation when a new key is saved with the policy', async () => {
    const persisted = {
      ...legacyProvider,
      webFetchPreflightPolicy: 'skip' as WebFetchPreflightPolicy,
      anthropicAuthTokenMasked: 'new-***',
    };
    answerPolicyGets(persisted);
    await render(legacyProvider);
    await choose(field, 'skip');
    await type('#connection-secret', 'new-key');
    await click(button('保存连接设置'));
    await flush();
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      { webFetchPreflightPolicy: 'skip', anthropicAuthToken: 'new-key' },
      120_000,
    );
    expect(onChanged).toHaveBeenCalledWith(persisted);
  });
});
