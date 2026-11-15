// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  button,
  click,
  findButton,
  flush,
  makeProvider,
  text,
  type,
} from './test-helpers';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    put: mocks.put,
  },
}));

const { AddModelWizard } = await import('./AddModelWizard');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROVIDERS = '/api/config/claude/providers';
const DISCOVER = `${PROVIDERS}/discover-models`;
const TEST = `${PROVIDERS}/test`;

let root: Root;
let container: HTMLDivElement;
const onDone = vi.fn();
const onConnectionCreated = vi.fn();

/** Answers by path; a value may be a function of the body. */
function answer(routes: Record<string, unknown>) {
  mocks.post.mockImplementation(async (path: string, body: unknown) => {
    const route = routes[path];
    if (route === undefined) throw new Error(`unexpected POST ${path}`);
    return typeof route === 'function' ? route(body) : route;
  });
}

const OK_TEST = {
  ok: true,
  probes: [{ model: 'm', ok: true, status: 200, latencyMs: 321 }],
  code: null,
  authMode: 'bearer',
};

function failedTest(code: string, status: number, message = 'refused') {
  return {
    ok: false,
    probes: [{ model: 'm', ok: false, status, latencyMs: 50, message }],
    code,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockRejectedValue(new Error('offline'));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

const PREFILL = {
  API_TIMEOUT_MS: '3000000',
  CLAUDE_CODE_NO_FLICKER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

const DEEPSEEK_MODELS = [
  { id: 'deepseek-flash', contextWindow: 1_048_576 },
  { id: 'deepseek-v4-pro', contextWindow: 1_048_576 },
];

async function render() {
  await act(async () => {
    root.render(
      <AddModelWizard
        onDone={onDone}
        onConnectionCreated={onConnectionCreated}
        onCancel={() => {}}
        layout="page"
      />,
    );
  });
}

function buttonContaining(fragment: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(fragment),
  );
  if (!match) throw new Error(`button containing "${fragment}" not found`);
  return match;
}

function checkbox(id: string): HTMLElement | null {
  return document.querySelector(`[role="checkbox"][aria-label="使用 ${id}"]`);
}

const field = (selector: string) =>
  document.querySelector(selector) as HTMLInputElement | null;

async function next() {
  await click(button('下一步'));
  await flush();
}

describe('vendor preset', () => {
  test('checks the preset and known models, leaves unknown ones unchecked and saves what the test found', async () => {
    answer({
      [DISCOVER]: {
        ok: true,
        source: 'endpoint',
        authMode: 'bearer',
        models: [
          { id: 'deepseek-flash' },
          { id: 'deepseek-v4-pro' },
          { id: 'deepseek-chat' },
          { id: 'glm-5.3' },
        ],
      },
      [TEST]: OK_TEST,
      [PROVIDERS]: makeProvider({ id: 'new', name: 'DeepSeek' }),
    });
    await render();
    await click(buttonContaining('api.deepseek.com'));

    // The address is the preset's and cannot be edited.
    expect(field('#wizard-preset-url')?.value).toBe(
      'https://api.deepseek.com/anthropic',
    );
    expect(field('#wizard-preset-url')?.readOnly).toBe(true);
    expect(findButton('下一步')?.disabled).toBe(true);
    await type('#wizard-api-key', 'sk-ds');
    await next();

    expect(mocks.post).toHaveBeenCalledWith(
      DISCOVER,
      {
        type: 'third_party',
        presetId: 'deepseek',
        anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
        anthropicAuthToken: 'sk-ds',
        customEnv: PREFILL,
      },
      45_000,
    );
    expect(checkbox('deepseek-flash')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(checkbox('deepseek-v4-pro')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    // The registry knows glm-5.3, nothing knows deepseek-chat.
    expect(checkbox('glm-5.3')?.getAttribute('aria-checked')).toBe('true');
    expect(checkbox('deepseek-chat')?.getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(text()).toContain('已选 3 / 共 4');
    // No default radio, no 1M switch.
    expect(document.querySelector('input[type="radio"]')).toBeNull();
    expect(text()).not.toContain('1M 上下文');
    await click(checkbox('glm-5.3'));

    await next();
    expect(mocks.post).toHaveBeenCalledWith(
      TEST,
      {
        type: 'third_party',
        presetId: 'deepseek',
        anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
        anthropicAuthToken: 'sk-ds',
        customEnv: PREFILL,
        anthropicModel: 'deepseek-flash',
      },
      60_000,
    );
    expect(text()).toContain('连接成功');
    expect(document.querySelector('#wizard-pool')).toBeNull();
    expect(text()).not.toContain('自动池');

    await click(button('保存'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(PROVIDERS, {
      name: 'DeepSeek',
      type: 'third_party',
      presetId: 'deepseek',
      anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
      anthropicAuthToken: 'sk-ds',
      customEnv: PREFILL,
      // The first checked model, silently.
      anthropicModel: 'deepseek-flash',
      models: DEEPSEEK_MODELS,
      roles: {},
      anthropicAuthMode: 'bearer',
    });
    // The saved connection is tested once more so its status is stored.
    expect(mocks.post).toHaveBeenLastCalledWith(
      TEST,
      { providerId: 'new' },
      60_000,
    );
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'new' }),
      true,
    );
  });

  test('a failed discovery says why and still finishes with the preset models', async () => {
    answer({
      [DISCOVER]: {
        ok: false,
        code: 'AUTH_FORBIDDEN',
        status: 403,
        message: 'plan does not include models API',
      },
      [TEST]: OK_TEST,
      [PROVIDERS]: makeProvider({ id: 'new' }),
    });
    await render();
    await click(buttonContaining('api.deepseek.com'));
    await type('#wizard-api-key', 'sk-ds');
    await next();
    expect(text()).toContain('没能获取模型列表：没有访问权限');
    expect(text()).toContain('仍可使用下方的模型或手动添加');
    expect(text()).toContain('plan does not include models API');
    expect(checkbox('deepseek-flash')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    await next();
    await click(button('保存'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      PROVIDERS,
      expect.objectContaining({
        models: DEEPSEEK_MODELS,
        // The list proved nothing, so the test's header is kept.
        anthropicAuthMode: 'bearer',
      }),
    );
  });

  test('a refused key keeps the user on 连接 with the reason under the key', async () => {
    answer({
      [DISCOVER]: (body: { anthropicAuthToken: string }) =>
        body.anthropicAuthToken === 'sk-bad'
          ? {
              ok: false,
              code: 'AUTH_INVALID',
              status: 401,
              message: 'invalid x-api-key',
            }
          : { ok: true, source: 'endpoint', models: [] },
    });
    await render();
    await click(buttonContaining('api.deepseek.com'));
    await type('#wizard-api-key', 'sk-bad');
    await next();
    expect(field('#wizard-api-key')).not.toBeNull();
    expect(field('#wizard-api-key')?.getAttribute('aria-invalid')).toBe('true');
    expect(text()).toContain('密钥无效：检查 API Key 是否完整');
    expect(checkbox('deepseek-flash')).toBeNull();
    // The same key is asked about again, and refused again.
    await next();
    expect(
      mocks.post.mock.calls.filter(([path]) => path === DISCOVER),
    ).toHaveLength(2);
    expect(field('#wizard-api-key')).not.toBeNull();

    // A new key clears the reason and gets through.
    await type('#wizard-api-key', 'sk-good');
    expect(text()).not.toContain('密钥无效');
    await next();
    expect(checkbox('deepseek-flash')).not.toBeNull();
  });

  test('custom headers travel with the draft, and a refusal with them moves on', async () => {
    answer({
      [DISCOVER]: {
        ok: false,
        code: 'AUTH_INVALID',
        status: 401,
        message: 'missing X-Api-Token',
      },
      [TEST]: OK_TEST,
      [PROVIDERS]: makeProvider({ id: 'relay' }),
    });
    await render();
    await click(buttonContaining('自定义兼容地址'));
    await type('#wizard-base-url', 'https://relay.example.test');
    await type('#wizard-api-key', 'sk');
    await click(button('添加'));
    await type(
      'input[aria-label="第 4 行环境变量 Key"]',
      'ANTHROPIC_CUSTOM_HEADERS',
    );
    await type('textarea[aria-label="第 4 行环境变量值"]', 'X-Api-Token: t1');
    await next();
    expect(mocks.post).toHaveBeenCalledWith(
      DISCOVER,
      {
        type: 'third_party',
        anthropicBaseUrl: 'https://relay.example.test',
        anthropicAuthToken: 'sk',
        customEnv: {
          ...PREFILL,
          ANTHROPIC_CUSTOM_HEADERS: 'X-Api-Token: t1',
        },
      },
      45_000,
    );
    // The refusal may be about the headers, not the key: on to the models.
    expect(field('#wizard-api-key')).toBeNull();
    expect(text()).toContain('没能获取模型列表：密钥无效');
    await type('input[aria-label="手动添加模型"]', 'relay-model');
    await click(button('添加'));
    await next();
    await click(button('保存'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      PROVIDERS,
      expect.objectContaining({
        customEnv: {
          ...PREFILL,
          ANTHROPIC_CUSTOM_HEADERS: 'X-Api-Token: t1',
        },
      }),
    );
  });

  test('a header proved by the model list wins over the test report', async () => {
    answer({
      [DISCOVER]: {
        ok: true,
        source: 'endpoint',
        authMode: 'x-api-key',
        models: [{ id: 'glm-5.2' }],
      },
      [TEST]: { ...OK_TEST, authMode: 'bearer' },
      [PROVIDERS]: makeProvider({ id: 'new' }),
    });
    await render();
    await click(buttonContaining('自定义兼容地址'));
    await type('#wizard-base-url', 'https://relay.example.test');
    await type('#wizard-api-key', 'sk');
    await next();
    await next();
    await click(button('保存'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      PROVIDERS,
      expect.objectContaining({ anthropicAuthMode: 'x-api-key' }),
    );
  });

  test('全选 and 清空 act on the search results; the first checked model is the connection model', async () => {
    answer({
      [DISCOVER]: {
        ok: true,
        source: 'endpoint',
        models: [{ id: 'relay-a' }, { id: 'relay-b' }, { id: 'other-c' }],
      },
      [TEST]: OK_TEST,
    });
    await render();
    await click(buttonContaining('自定义兼容地址'));
    await type('#wizard-base-url', 'https://relay.example.test');
    await type('#wizard-api-key', 'sk');
    await next();
    // Unknown models arrive unchecked, and the step cannot go on without one.
    expect(text()).toContain('已选 0 / 共 3');
    expect(button('下一步').disabled).toBe(true);

    await type('input[aria-label="搜索模型"]', 'relay');
    expect(checkbox('other-c')).toBeNull();
    await click(button('全选'));
    expect(text()).toContain('已选 2 / 共 3');
    await type('input[aria-label="搜索模型"]', '');
    expect(checkbox('other-c')?.getAttribute('aria-checked')).toBe('false');

    await click(checkbox('other-c'));
    await type('input[aria-label="搜索模型"]', 'relay-a');
    await click(button('清空'));
    expect(checkbox('relay-a')?.getAttribute('aria-checked')).toBe('false');
    await type('input[aria-label="搜索模型"]', '');
    expect(checkbox('relay-b')?.getAttribute('aria-checked')).toBe('true');
    expect(text()).toContain('已选 2 / 共 3');

    await next();
    expect(mocks.post).toHaveBeenCalledWith(
      TEST,
      expect.objectContaining({ anthropicModel: 'relay-b' }),
      60_000,
    );
  });

  test('context, efforts and roles go with the saved models', async () => {
    answer({
      [DISCOVER]: {
        ok: true,
        source: 'endpoint',
        models: [
          { id: 'glm-5.3' },
          { id: 'gpt-6.1-terra' },
          {
            id: 'vendor-x',
            efforts: ['low', 'high'],
            defaultEffort: 'high',
            contextWindow: 400_000,
          },
          { id: 'relay-unknown' },
        ],
      },
      [TEST]: OK_TEST,
      [PROVIDERS]: makeProvider({ id: 'new' }),
    });
    await render();
    await click(buttonContaining('自定义兼容地址'));
    await type('#wizard-base-url', 'https://relay.example.test');
    await type('#wizard-api-key', 'sk');
    await next();
    await click(checkbox('gpt-6.1-terra'));
    await click(checkbox('vendor-x'));
    await click(checkbox('relay-unknown'));

    // A family guess and an unknown model are marked.
    const efforts = (id: string) =>
      document.querySelector(`[role="group"][aria-label="${id} 的推理等级"]`)!;
    expect(efforts('gpt-6.1-terra').textContent).toContain('推断');
    expect(efforts('relay-unknown').textContent).toContain('未验证');
    expect(efforts('glm-5.3').textContent).not.toContain('未验证');

    // Trimming an unverified list makes it the user's.
    const chip = [...efforts('relay-unknown').querySelectorAll('button')].find(
      (node) => node.textContent === '最高',
    );
    await click(chip);
    expect(efforts('relay-unknown').textContent).not.toContain('未验证');

    // A window picked from the list.
    const window = document.querySelector(
      'select[aria-label="relay-unknown 的上下文长度"]',
    ) as HTMLSelectElement;
    expect(window.value).toBe('');
    // Left empty, Claude Code runs it at 200K; nothing to suggest.
    expect(window.selectedOptions[0].textContent).toContain('未填（按 200K）');
    expect(
      document.querySelector('select[aria-label="glm-5.3 的上下文长度"]')
        ?.parentElement?.parentElement?.textContent,
    ).not.toContain('建议');
    await act(async () => {
      window.value = '256000';
      window.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const role = (id: string, value: string) =>
      act(async () => {
        const select = field(id) as unknown as HTMLSelectElement;
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    await role('#connection-role-subagent', 'gpt-6.1-terra');
    await role('#connection-role-smallFast', 'relay-unknown');
    await role('#connection-role-opus', 'glm-5.3');

    await next();
    await click(button('保存'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      PROVIDERS,
      expect.objectContaining({
        anthropicModel: 'glm-5.3',
        models: [
          // A third-party connection declares the registry's window, so
          // launches use it; a family guess lends no window.
          { id: 'glm-5.3', contextWindow: 1_000_000 },
          { id: 'gpt-6.1-terra' },
          {
            id: 'vendor-x',
            contextWindow: 400_000,
            efforts: ['low', 'high'],
            defaultEffort: 'high',
          },
          {
            id: 'relay-unknown',
            contextWindow: 256_000,
            efforts: ['low', 'medium', 'high', 'xhigh'],
          },
        ],
        roles: {
          subagent: 'gpt-6.1-terra',
          smallFast: 'relay-unknown',
          opus: 'glm-5.3',
        },
      }),
    );
  });

  test('a role on a model unchecked later is not saved', async () => {
    answer({
      [DISCOVER]: {
        ok: true,
        source: 'endpoint',
        models: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }],
      },
      [TEST]: OK_TEST,
      [PROVIDERS]: makeProvider({ id: 'new' }),
    });
    await render();
    await click(buttonContaining('自定义兼容地址'));
    await type('#wizard-base-url', 'https://relay.example.test');
    await type('#wizard-api-key', 'sk');
    await next();
    await act(async () => {
      const select = field(
        '#connection-role-subagent',
      ) as unknown as HTMLSelectElement;
      select.value = 'glm-5.2';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click(checkbox('glm-5.2'));
    await next();
    await click(button('保存'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      PROVIDERS,
      expect.objectContaining({
        models: [{ id: 'glm-5.3', contextWindow: 1_000_000 }],
        roles: {},
      }),
    );
  });
});

describe('environment', () => {
  async function openCustom() {
    answer({
      [DISCOVER]: { ok: true, source: 'endpoint', models: [] },
      [TEST]: OK_TEST,
      [PROVIDERS]: makeProvider({ id: 'new' }),
    });
    await render();
    await click(buttonContaining('自定义兼容地址'));
    await type('#wizard-base-url', 'https://relay.example.test');
    await type('#wizard-api-key', 'sk');
  }
  const keyInput = (n: number) =>
    field(`input[aria-label="第 ${n} 行环境变量 Key"]`);

  test('starts with exactly the three runtime defaults', async () => {
    await openCustom();
    expect(
      [1, 2, 3].map((n) => [
        keyInput(n)?.value,
        field(`input[aria-label="第 ${n} 行环境变量值"]`)?.value,
      ]),
    ).toEqual(Object.entries(PREFILL));
    expect(keyInput(4)).toBeNull();
  });

  test('a deleted row and an emptied value are not saved', async () => {
    await openCustom();
    await type('input[aria-label="第 2 行环境变量值"]', '');
    await click(
      document.querySelectorAll('button[aria-label="删除环境变量"]')[0],
    );
    await next();
    await type('input[aria-label="手动添加模型"]', 'relay-model');
    await click(button('添加'));
    await next();
    await click(button('保存'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      PROVIDERS,
      expect.objectContaining({
        customEnv: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      }),
    );
  });

  test('a model key is refused: 由模型设置决定', async () => {
    await openCustom();
    await click(button('添加'));
    await type('input[aria-label="第 4 行环境变量 Key"]', 'ANTHROPIC_MODEL');
    await type('input[aria-label="第 4 行环境变量值"]', 'glm-5.3');
    expect(text()).toContain('ANTHROPIC_MODEL 由模型设置决定');
    expect(button('下一步').disabled).toBe(true);
    await type(
      'input[aria-label="第 4 行环境变量 Key"]',
      'CLAUDE_CODE_EFFORT_LEVEL',
    );
    expect(text()).toContain('CLAUDE_CODE_EFFORT_LEVEL 由模型设置决定');
    await type('input[aria-label="第 4 行环境变量 Key"]', 'MY_FLAG');
    expect(text()).not.toContain('由模型设置决定');
    expect(button('下一步').disabled).toBe(false);
  });

  test('every third-party source offers it; official ones do not', async () => {
    await render();
    await click(buttonContaining('api.deepseek.com'));
    expect(text()).toContain('高级设置 · 环境变量');
    await click(button('上一步'));
    await click(buttonContaining('Anthropic API Key'));
    expect(text()).not.toContain('高级设置 · 环境变量');
  });
});

describe('custom address', () => {
  test('suggests a preset after typing stops, never switches by itself, keeps the draft', async () => {
    vi.useFakeTimers();
    await render();
    await click(buttonContaining('自定义兼容地址'));
    await type('#wizard-base-url', 'https://API.deepseek.com/anthropic/');
    await type('#wizard-api-key', 'sk-kept');
    expect(text()).not.toContain('看起来是');
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(text()).toContain('看起来是「DeepSeek」');
    // Still the custom form.
    expect(field('#wizard-base-url')).not.toBeNull();

    await click(button('按预设配置'));
    expect(field('#wizard-preset-url')?.value).toBe(
      'https://api.deepseek.com/anthropic',
    );
    expect(field('#wizard-api-key')?.value).toBe('sk-kept');
  });

  test('继续自定义 dismisses the suggestion for that address', async () => {
    vi.useFakeTimers();
    await render();
    await click(buttonContaining('自定义兼容地址'));
    await type('#wizard-base-url', 'https://api.moonshot.cn/anthropic');
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await click(button('继续自定义'));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(text()).not.toContain('看起来是');
    expect(field('#wizard-base-url')?.value).toBe(
      'https://api.moonshot.cn/anthropic',
    );
  });

  test('an address shared by two presets suggests nothing', async () => {
    vi.useFakeTimers();
    await render();
    await click(buttonContaining('自定义兼容地址'));
    // 智谱 GLM and its Coding Plan share this endpoint.
    await type('#wizard-base-url', 'https://open.bigmodel.cn/api/anthropic');
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(text()).not.toContain('看起来是');
  });

  test('a custom address finishes with a model typed by hand when listing fails', async () => {
    answer({
      [DISCOVER]: {
        ok: false,
        code: 'ENDPOINT_NOT_FOUND',
        status: 404,
        message: '',
      },
      // No header proved anywhere: none is saved, the server keeps its rule.
      [TEST]: { ...OK_TEST, authMode: undefined },
      [PROVIDERS]: makeProvider({ id: 'relay' }),
    });
    await render();
    await click(buttonContaining('自定义兼容地址'));
    // Importing a pasted alias is not offered.
    expect(text()).not.toContain('导入');
    expect(document.querySelector('textarea')).toBeNull();
    await type('#wizard-base-url', 'https://relay.example.test/anthropic');
    await type('#wizard-api-key', 'sk-fake');
    await next();
    expect(text()).toContain('没能获取模型列表：地址不对');
    await type('input[aria-label="手动添加模型"]', 'relay-model');
    await click(button('添加'));
    await next();
    await click(button('保存'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(PROVIDERS, {
      name: 'relay.example.test',
      type: 'third_party',
      anthropicBaseUrl: 'https://relay.example.test/anthropic',
      anthropicAuthToken: 'sk-fake',
      customEnv: PREFILL,
      anthropicModel: 'relay-model',
      models: [
        {
          id: 'relay-model',
          efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
      ],
      roles: {},
    });
  });

  test('a model typed with [1m] comes in with a 1M window', async () => {
    answer({
      [DISCOVER]: { ok: true, source: 'endpoint', models: [] },
    });
    await render();
    await click(buttonContaining('自定义兼容地址'));
    await type('#wizard-base-url', 'https://relay.example.test');
    await type('#wizard-api-key', 'sk');
    await next();
    await type('input[aria-label="手动添加模型"]', 'relay-x[1m]');
    await click(button('添加'));
    expect(checkbox('relay-x')?.getAttribute('aria-checked')).toBe('true');
    expect(
      (
        document.querySelector(
          'select[aria-label="relay-x 的上下文长度"]',
        ) as HTMLSelectElement
      ).value,
    ).toBe('1000000');
  });
});

describe('test before saving', () => {
  async function reachSave(routes: Record<string, unknown>) {
    answer({
      [DISCOVER]: { ok: true, source: 'endpoint', models: [] },
      [PROVIDERS]: makeProvider({ id: 'new' }),
      ...routes,
    });
    await render();
    await click(buttonContaining('api.deepseek.com'));
    await type('#wizard-api-key', 'sk-bad');
    await next();
    await next();
  }

  test('an invalid key blocks saving until the key changes', async () => {
    await reachSave({
      [TEST]: failedTest('AUTH_INVALID', 401, 'invalid x-api-key'),
    });
    expect(text()).toContain('密钥无效');
    expect(text()).toContain('密钥无效时不能保存');
    expect(button('保存').disabled).toBe(true);
    await click(button('保存'));
    expect(mocks.post).not.toHaveBeenCalledWith(PROVIDERS, expect.anything());

    answer({
      [DISCOVER]: { ok: true, source: 'endpoint', models: [] },
      [TEST]: OK_TEST,
      [PROVIDERS]: makeProvider({ id: 'new' }),
    });
    await click(button('上一步'));
    await click(button('上一步'));
    await type('#wizard-api-key', 'sk-good');
    await next();
    await next();
    expect(button('保存').disabled).toBe(false);
  });

  test('another failure may still be saved, as unverified', async () => {
    await reachSave({ [TEST]: failedTest('RATE_LIMITED', 429) });
    expect(text()).toContain('请求过于频繁');
    await click(button('仍然保存（未验证）'));
    await flush();
    expect(onDone).toHaveBeenCalledWith(expect.anything(), false);
  });

  test('going back and forth without changes does not test again', async () => {
    await reachSave({ [TEST]: OK_TEST });
    await click(button('上一步'));
    await next();
    const tests = mocks.post.mock.calls.filter(([path]) => path === TEST);
    expect(tests).toHaveLength(1);
  });
});

describe('late answers', () => {
  test('a model list for an older key is dropped', async () => {
    let answerFirst!: (value: unknown) => void;
    mocks.post.mockImplementation(async (path: string, body: unknown) => {
      if (path !== DISCOVER) throw new Error(path);
      if (
        (body as { anthropicAuthToken: string }).anthropicAuthToken === 'sk-a'
      ) {
        return new Promise((resolve) => {
          answerFirst = resolve;
        });
      }
      return { ok: true, source: 'endpoint', models: [{ id: 'model-b' }] };
    });
    await render();
    await click(buttonContaining('自定义兼容地址'));
    await type('#wizard-base-url', 'https://relay.example.test');
    await type('#wizard-api-key', 'sk-a');
    await next();
    // Still reading the list for sk-a: the user stays on 连接.
    expect(field('#wizard-api-key')).not.toBeNull();
    expect(button('下一步').disabled).toBe(true);
    // A new key is a new draft; its answer is the one that counts.
    await type('#wizard-api-key', 'sk-b');
    expect(button('下一步').disabled).toBe(false);
    await next();
    expect(checkbox('model-b')).not.toBeNull();
    await act(async () => {
      answerFirst({
        ok: true,
        source: 'endpoint',
        models: [{ id: 'model-a' }],
      });
    });
    await flush();
    expect(checkbox('model-a')).toBeNull();
    expect(text()).toContain('获取到 1 个模型');
  });

  test('a test result for an older connection model is dropped', async () => {
    let answerFirst!: (value: unknown) => void;
    let tests = 0;
    answer({
      [DISCOVER]: { ok: true, source: 'endpoint', models: [] },
      [TEST]: () => {
        tests += 1;
        return tests === 1
          ? new Promise((resolve) => {
              answerFirst = resolve;
            })
          : OK_TEST;
      },
    });
    await render();
    await click(buttonContaining('api.deepseek.com'));
    await type('#wizard-api-key', 'sk');
    await next();
    await next();
    await click(button('上一步'));
    await click(checkbox('deepseek-flash'));
    await next();
    expect(text()).toContain('连接成功');
    await act(async () => {
      answerFirst(failedTest('AUTH_INVALID', 401));
    });
    await flush();
    expect(text()).toContain('连接成功');
    expect(text()).not.toContain('密钥无效');
  });
});

describe('official kinds', () => {
  async function typedOnRelayThenOfficial(pickWindow?: string) {
    answer({
      [DISCOVER]: { ok: true, source: 'endpoint', models: [] },
      [TEST]: OK_TEST,
      [PROVIDERS]: makeProvider({ id: 'api', type: 'official' }),
    });
    await render();
    await click(buttonContaining('自定义兼容地址'));
    await type('#wizard-base-url', 'https://relay.example.test');
    await type('#wizard-api-key', 'sk');
    await next();
    await type('input[aria-label="手动添加模型"]', 'claude-opus-4-7');
    await click(button('添加'));
    const window = () =>
      document.querySelector(
        'select[aria-label="claude-opus-4-7 的上下文长度"]',
      ) as HTMLSelectElement;
    // On a relay the suggestion is declared.
    expect(window().value).toBe('1000000');
    if (pickWindow) {
      await act(async () => {
        window().value = pickWindow;
        window().dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    await click(button('上一步'));
    await click(button('上一步'));
    await click(buttonContaining('Anthropic API Key'));
    await type('#wizard-api-key', 'sk-ant-1');
    await next();
    return window;
  }

  test('a typed model keeps no suggested window when the source turns official', async () => {
    const window = await typedOnRelayThenOfficial();
    expect(window().value).toBe('');
    expect(text()).toContain('建议：1M');
    await next();
    await click(button('保存'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      PROVIDERS,
      expect.objectContaining({ models: [{ id: 'claude-opus-4-7' }] }),
    );
  });

  test('a window the user picked survives the switch to official', async () => {
    const window = await typedOnRelayThenOfficial('256000');
    expect(window().value).toBe('256000');
    await next();
    await click(button('保存'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      PROVIDERS,
      expect.objectContaining({
        models: [{ id: 'claude-opus-4-7', contextWindow: 256_000 }],
      }),
    );
  });

  test('an Anthropic API key checks known models and never claims a window it was not given', async () => {
    answer({
      [DISCOVER]: {
        ok: true,
        source: 'endpoint',
        models: [
          {
            id: 'claude-opus-5-5',
            name: 'Claude Opus 5.5',
            contextWindow: 1_000_000,
          },
          { id: 'claude-internal-x' },
        ],
      },
      [TEST]: OK_TEST,
      [PROVIDERS]: makeProvider({ id: 'api', type: 'official' }),
    });
    await render();
    await click(buttonContaining('Anthropic API Key'));
    await type('#wizard-api-key', 'sk-ant-1');
    await next();
    expect(mocks.post).toHaveBeenCalledWith(
      DISCOVER,
      { type: 'official', anthropicApiKey: 'sk-ant-1' },
      45_000,
    );
    expect(checkbox('claude-opus-5-5')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(checkbox('claude-internal-x')?.getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(text()).not.toContain('不指定');
    // The registry window is only offered: picking it is the 1M opt-in.
    expect(
      (
        document.querySelector(
          'select[aria-label="claude-opus-5-5 的上下文长度"]',
        ) as HTMLSelectElement
      ).value,
    ).toBe('');
    expect(text()).toContain('建议：1M');
    // A model typed by hand is no different.
    await type('input[aria-label="手动添加模型"]', 'claude-sonnet-5-5');
    await click(button('添加'));
    // Official connections have no tiers to assign.
    expect(text()).not.toContain('后台与子代理');
    await next();
    expect(mocks.post).toHaveBeenCalledWith(
      TEST,
      {
        type: 'official',
        anthropicApiKey: 'sk-ant-1',
        anthropicModel: 'claude-opus-5-5',
      },
      60_000,
    );
    await click(button('保存'));
    await flush();
    // 1M on an official connection is the billed opt-in: only a deliberate
    // pick declares it.
    expect(mocks.post).toHaveBeenCalledWith(PROVIDERS, {
      name: 'Anthropic API Key',
      type: 'official',
      anthropicApiKey: 'sk-ant-1',
      anthropicModel: 'claude-opus-5-5',
      // The vendor's name comes along with the model.
      models: [
        { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
        { id: 'claude-sonnet-5-5' },
      ],
    });
  });

  test('a pasted setup-token is checked before saving and an invalid one blocks', async () => {
    answer({
      [DISCOVER]: {
        ok: true,
        source: 'builtin',
        models: [{ id: 'opus' }, { id: 'sonnet' }],
      },
      [TEST]: failedTest('AUTH_INVALID', 401),
    });
    await render();
    await click(buttonContaining('Claude 订阅'));
    await type('#wizard-claude-credential', ' sk-ant-oat01-x ');
    await next();
    expect(mocks.post).toHaveBeenCalledWith(
      DISCOVER,
      { type: 'official', claudeCredentialInput: 'sk-ant-oat01-x' },
      45_000,
    );
    // Built-in aliases are what a subscription runs: offered checked.
    expect(checkbox('opus')?.getAttribute('aria-checked')).toBe('true');
    await next();
    expect(mocks.post).toHaveBeenCalledWith(
      TEST,
      {
        type: 'official',
        claudeCredentialInput: 'sk-ant-oat01-x',
        anthropicModel: 'opus',
      },
      60_000,
    );
    expect(button('保存').disabled).toBe(true);
  });

  test('a Claude login creates the connection, then the wizard updates it', async () => {
    const created = makeProvider({
      id: 'claude-new',
      name: '官方 Claude (a@example.com)',
      type: 'official',
      anthropicBaseUrl: '',
      anthropicModel: '',
      models: [],
      hasAnthropicAuthToken: false,
      hasClaudeOAuthCredentials: true,
      claudeAuthKind: 'oauth',
      claudeOAuthAccountEmail: 'a@example.com',
    });
    answer({
      '/api/config/claude/oauth/start': {
        authorizeUrl: 'https://claude.test/auth',
        state: 's1',
      },
      '/api/config/claude/oauth/callback': created,
      [DISCOVER]: {
        ok: true,
        source: 'builtin',
        models: [{ id: 'opus' }, { id: 'sonnet' }, { id: 'haiku' }],
      },
      [TEST]: { ...OK_TEST, authMode: undefined },
    });
    mocks.patch.mockResolvedValue({ provider: created });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await render();
    await click(buttonContaining('Claude 订阅'));
    await click(button('登录 Claude'));
    expect(open).toHaveBeenCalledWith(
      'https://claude.test/auth',
      '_blank',
      'noopener,noreferrer',
    );
    await type('input[aria-label="粘贴授权码"]', 'code#s1');
    await click(button('确认'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      '/api/config/claude/oauth/callback',
      { state: 's1', code: 'code#s1' },
      60_000,
    );
    expect(onConnectionCreated).toHaveBeenCalledWith(created);
    expect(mocks.post).toHaveBeenCalledWith(
      DISCOVER,
      { providerId: 'claude-new' },
      45_000,
    );
    await next();
    expect(mocks.post).toHaveBeenCalledWith(
      TEST,
      { providerId: 'claude-new' },
      60_000,
    );
    // The saved connection is tested by id: another first model is no
    // reason to send the same check again.
    await click(button('上一步'));
    await click(checkbox('opus'));
    await next();
    expect(
      mocks.post.mock.calls.filter(([path]) => path === TEST),
    ).toHaveLength(1);
    await click(button('保存'));
    await flush();
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/claude-new`,
      {
        models: [{ id: 'sonnet' }, { id: 'haiku' }],
        anthropicModel: 'sonnet',
      },
      120_000,
    );
    expect(mocks.post).not.toHaveBeenCalledWith(PROVIDERS, expect.anything());
    expect(onDone).toHaveBeenCalledWith(created, true);
  });

  test('a ChatGPT login picks its default model from the account catalog', async () => {
    const created = makeProvider({
      id: 'gpt',
      name: 'ChatGPT 订阅',
      anthropicModel: 'gpt-6.1-sol',
      models: [],
      hasCodexOAuthCredentials: true,
      codexDefaultEffort: 'low',
    });
    answer({
      '/api/config/codex/oauth/start': {
        authorizeUrl: 'https://auth.openai.test',
        state: 's2',
      },
      '/api/config/codex/oauth/callback': created,
      [TEST]: { ...OK_TEST, authMode: undefined },
    });
    mocks.get.mockResolvedValue({
      models: [
        {
          value: 'gpt-6.1-sol',
          label: 'gpt-6.1-sol',
          efforts: ['low', 'medium', 'high'],
          defaultEffort: 'low',
        },
        {
          value: 'gpt-6-astra',
          label: 'gpt-6-astra',
          efforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
        },
      ],
      defaultModel: 'gpt-6.1-sol',
      defaultEffort: 'low',
    });
    mocks.patch.mockResolvedValue({ provider: created });
    vi.spyOn(window, 'open').mockReturnValue(null);
    await render();
    await click(buttonContaining('ChatGPT 订阅'));
    await click(button('登录 ChatGPT'));
    await type(
      'input[aria-label="粘贴 localhost:1455 回调完整地址"]',
      'http://localhost:1455/auth/callback?code=c&state=s2',
    );
    await click(button('确认'));
    await flush();
    expect(mocks.get).toHaveBeenCalledWith(
      '/api/config/codex/model-catalog?providerId=gpt',
    );
    const select = field('#codex-model-select') as unknown as HTMLSelectElement;
    expect(select.value).toBe('gpt-6.1-sol');
    await act(async () => {
      select.value = 'gpt-6-astra';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await next();
    await click(button('保存'));
    await flush();
    // The effort it had is offered by the new model, so only the model changes.
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/gpt`,
      { anthropicModel: 'gpt-6-astra' },
      120_000,
    );
  });
});

describe('magpie', () => {
  const FULL = ['low', 'medium', 'high', 'xhigh', 'max'];
  const MAGPIE_MODELS = [
    // Claude Code's discovery alias for a row of one list, not a model.
    {
      id: 'anthropic/magpie-1',
      name: 'Claude Opus 4.7',
      magpieLabel: 'Claude Opus 4.7',
    },
    {
      id: 'acme/vx-pro',
      name: 'VX Pro',
      maxOutputTokens: 128_000,
      vendor: 'Relay A',
      efforts: ['low', 'medium', 'high'],
      magpieLabel: 'VX Pro · Relay A',
    },
    // Declared to take no effort although it reasons.
    {
      id: 'acme/vx-mini',
      name: 'VX Mini',
      vendor: 'Relay A',
      efforts: [],
      thinks: true,
      magpieLabel: 'VX Mini · Relay A',
    },
    // Nothing said about efforts.
    { id: 'acme/vx-lab', magpieLabel: 'vx-lab' },
  ];

  const efforts = (id: string) =>
    document.querySelector(`[role="group"][aria-label="${id} 的推理等级"]`);

  async function pick(id: string) {
    if (checkbox(id)?.getAttribute('aria-checked') !== 'true') {
      await click(checkbox(id));
    }
  }

  async function chooseMagpie() {
    await render();
    await click(buttonContaining('Magpie'));
  }

  test('starts from the gateway’s usual address and an app key, both editable', async () => {
    await chooseMagpie();
    const url = field('#wizard-preset-url');
    expect(url?.value).toBe('http://127.0.0.1:3425');
    expect(url?.readOnly).toBe(false);
    expect(field('#wizard-api-key')?.value).toBe('magpie-happyclaw');
    expect(text()).toContain('本机的 magpie 接受任意密钥');
    // No other address to switch to: the address is the draft's own.
    expect(text()).not.toContain('改用自定义地址');
    expect(button('下一步').disabled).toBe(false);
    await type('#wizard-preset-url', 'ftp://host');
    expect(text()).toContain('只支持 http(s) 地址');
    await type('#wizard-preset-url', '');
    expect(button('下一步').disabled).toBe(true);
  });

  test('skips the WebFetch check by default and says why', async () => {
    await chooseMagpie();
    const select = field(
      '#wizard-web-fetch-preflight',
    ) as unknown as HTMLSelectElement;
    expect(select.value).toBe('skip');
    expect(text()).toContain('先把域名发到 api.anthropic.com 检查');
    // Only magpie offers it here.
    await click(button('上一步'));
    await click(buttonContaining('api.deepseek.com'));
    expect(field('#wizard-web-fetch-preflight')).toBeNull();
  });

  test('saves the address, the gateway and what magpie says about each model', async () => {
    answer({
      [DISCOVER]: {
        ok: true,
        source: 'endpoint',
        gateway: 'magpie',
        authMode: 'bearer',
        models: MAGPIE_MODELS,
      },
      [TEST]: OK_TEST,
      [PROVIDERS]: makeProvider({ id: 'mp', name: 'Magpie' }),
    });
    await chooseMagpie();
    await type('#wizard-preset-url', 'http://10.0.0.5:3425');
    await next();
    expect(mocks.post).toHaveBeenCalledWith(
      DISCOVER,
      {
        type: 'third_party',
        presetId: 'magpie',
        anthropicBaseUrl: 'http://10.0.0.5:3425',
        anthropicAuthToken: 'magpie-happyclaw',
        customEnv: PREFILL,
      },
      45_000,
    );
    // The alias is never offered, nor counted.
    expect(checkbox('anthropic/magpie-1')).toBeNull();
    expect(text()).toContain('获取到 3 个模型');
    await pick('acme/vx-pro');
    await pick('acme/vx-mini');
    await pick('acme/vx-lab');
    expect(text()).toContain('VX Pro · Relay A · 最长回复 128K');

    // Declared to take none: shown as such, never filled in.
    expect(efforts('acme/vx-mini')?.textContent).toContain('不传档位');
    expect(efforts('acme/vx-mini')?.textContent).not.toContain('未验证');
    // Nothing known: every level, unverified.
    expect(efforts('acme/vx-lab')?.textContent).toContain('未验证');

    await next();
    await click(button('保存'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      PROVIDERS,
      expect.objectContaining({
        type: 'third_party',
        presetId: 'magpie',
        anthropicBaseUrl: 'http://10.0.0.5:3425',
        anthropicAuthToken: 'magpie-happyclaw',
        gateway: 'magpie',
        webFetchPreflightPolicy: 'skip',
        anthropicModel: 'acme/vx-pro',
        models: [
          {
            id: 'acme/vx-pro',
            displayName: 'VX Pro',
            maxOutputTokens: 128_000,
            vendor: 'Relay A',
            efforts: ['low', 'medium', 'high'],
          },
          {
            id: 'acme/vx-mini',
            displayName: 'VX Mini',
            vendor: 'Relay A',
            efforts: [],
            thinks: true,
          },
          { id: 'acme/vx-lab', efforts: FULL },
        ],
      }),
    );
  });

  test('the WebFetch check may be kept', async () => {
    answer({
      [DISCOVER]: {
        ok: true,
        source: 'endpoint',
        gateway: 'magpie',
        models: [MAGPIE_MODELS[1]],
      },
      [TEST]: OK_TEST,
      [PROVIDERS]: makeProvider({ id: 'mp' }),
    });
    await chooseMagpie();
    await act(async () => {
      const select = field(
        '#wizard-web-fetch-preflight',
      ) as unknown as HTMLSelectElement;
      select.value = 'check';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await next();
    await pick('acme/vx-pro');
    await next();
    await click(button('保存'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      PROVIDERS,
      expect.objectContaining({ webFetchPreflightPolicy: 'check' }),
    );
  });

  test('a connection without a model is refused, and the reason is shown', async () => {
    answer({
      [DISCOVER]: {
        ok: true,
        source: 'endpoint',
        gateway: 'magpie',
        models: [MAGPIE_MODELS[1]],
      },
      [TEST]: OK_TEST,
      [PROVIDERS]: async () => {
        throw {
          status: 400,
          message: 'magpie connection needs a model',
          body: { code: 'MAGPIE_MODELS_REQUIRED' },
        };
      },
    });
    await chooseMagpie();
    await next();
    // Nothing checked: the step cannot go on.
    expect(button('下一步').disabled).toBe(true);
    await pick('acme/vx-pro');
    await next();
    await click(button('保存'));
    await flush();
    expect(text()).toContain('magpie 连接至少要有一个模型');
    expect(onDone).not.toHaveBeenCalled();
  });

  test('leaving magpie for a vendor drops the app key', async () => {
    await chooseMagpie();
    await click(button('上一步'));
    await click(buttonContaining('api.deepseek.com'));
    expect(field('#wizard-api-key')?.value).toBe('');
    // A key the user typed is theirs and stays.
    await type('#wizard-api-key', 'sk-own');
    await click(button('上一步'));
    await click(buttonContaining('Magpie'));
    expect(field('#wizard-api-key')?.value).toBe('sk-own');
  });

  test('a custom address the list shows to be magpie is saved as magpie', async () => {
    answer({
      [DISCOVER]: {
        ok: true,
        source: 'endpoint',
        gateway: 'magpie',
        models: [MAGPIE_MODELS[1]],
      },
      [TEST]: OK_TEST,
      [PROVIDERS]: makeProvider({ id: 'mp' }),
    });
    await render();
    await click(buttonContaining('自定义兼容地址'));
    await type('#wizard-base-url', 'https://magpie.example.test');
    await type('#wizard-api-key', 'sk');
    await next();
    await pick('acme/vx-pro');
    await next();
    await click(button('保存'));
    await flush();
    const body = mocks.post.mock.calls.find(([path]) => path === PROVIDERS)![1];
    expect(body).toMatchObject({
      anthropicBaseUrl: 'https://magpie.example.test',
      gateway: 'magpie',
    });
    // Only the preset decides the WebFetch check up front.
    expect(body).not.toHaveProperty('webFetchPreflightPolicy');
    expect(body).not.toHaveProperty('presetId');
  });
});

describe('background model hint', () => {
  test('suggests a cheap model while 轻量后台模型 follows the turn’s model', async () => {
    answer({
      [DISCOVER]: {
        ok: true,
        source: 'endpoint',
        models: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }],
      },
    });
    await render();
    await click(buttonContaining('自定义兼容地址'));
    await type('#wizard-base-url', 'https://relay.example.test');
    await type('#wizard-api-key', 'sk');
    await next();
    expect(text()).toContain('建议选一个便宜的模型');
    await act(async () => {
      const select = field(
        '#connection-role-smallFast',
      ) as unknown as HTMLSelectElement;
      select.value = 'glm-5.2';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(text()).not.toContain('建议选一个便宜的模型');
  });

  test('a single model has nothing cheaper to suggest', async () => {
    answer({
      [DISCOVER]: { ok: true, source: 'endpoint', models: [{ id: 'glm-5.3' }] },
    });
    await render();
    await click(buttonContaining('自定义兼容地址'));
    await type('#wizard-base-url', 'https://relay.example.test');
    await type('#wizard-api-key', 'sk');
    await next();
    expect(text()).toContain('轻量后台模型');
    expect(text()).not.toContain('建议选一个便宜的模型');
  });
});
