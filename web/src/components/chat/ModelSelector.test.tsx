// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  SessionModelOption,
  SessionModelSelection,
} from './ModelSelector';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  canManage: false,
}));

vi.mock('../../api/client', () => ({
  api: { get: mocks.get, put: mocks.put },
}));
vi.mock('../../stores/auth', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ hasPermission: () => mocks.canManage }),
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

const { ModelSelector, describeDefaultModel, resolveEffortContext } =
  await import('./ModelSelector');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function selection(
  overrides: Partial<SessionModelSelection> = {},
): SessionModelSelection {
  return {
    selectedModelConfigId: null,
    default: { source: 'pool', modelConfigId: null, enabledCount: 2 },
    options: [
      {
        id: 'official',
        name: 'Claude 官方',
        kind: 'official',
        enabled: true,
        model: 'opus',
      },
      {
        id: 'glm',
        name: 'GLM',
        kind: 'third_party',
        enabled: false,
        model: 'glm-5.3[1m]',
      },
    ],
    ...overrides,
  };
}

const FULL = ['low', 'medium', 'high', 'xhigh', 'max'];

/** A selection with one ChatGPT login next to a Claude one. */
function chatGptSelection(
  overrides: Partial<SessionModelSelection> = {},
  codex: Partial<NonNullable<SessionModelOption['codex']>> = {},
  option: Partial<SessionModelOption> = {},
): SessionModelSelection {
  return {
    selectedModelConfigId: null,
    default: { source: 'pool', modelConfigId: null, enabledCount: 2 },
    options: [
      {
        id: 'official',
        name: 'Claude 官方',
        kind: 'official',
        enabled: true,
        model: 'opus',
      },
      {
        id: 'chatgpt',
        name: 'ChatGPT 订阅',
        kind: 'codex',
        enabled: true,
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
              efforts: FULL,
              defaultEffort: 'low',
            },
            {
              value: 'gpt-6-astra',
              label: 'gpt-6-astra（旗舰·最强推理）',
              efforts: FULL,
              defaultEffort: 'medium',
            },
            {
              value: 'gpt-5.5',
              label: 'gpt-5.5（遗留）',
              efforts: ['low', 'medium', 'high'],
              defaultEffort: 'medium',
            },
          ],
          ...codex,
        },
        ...option,
      },
    ],
    ...overrides,
  };
}

/** Two connections that list their models (a current server). */
function connectionSelection(
  overrides: Partial<SessionModelSelection> = {},
): SessionModelSelection {
  return {
    selectedModelConfigId: null,
    selectedModel: null,
    selectedEffort: null,
    default: { source: 'pool', modelConfigId: null, enabledCount: 2 },
    options: [
      {
        id: 'official',
        name: 'Claude 官方',
        kind: 'official',
        enabled: true,
        model: 'opus',
        usable: true,
        models: [
          { id: 'opus', hidden: false },
          { id: 'sonnet', hidden: false },
          { id: 'haiku', hidden: true },
        ],
      },
      {
        id: 'glm',
        name: 'GLM',
        kind: 'third_party',
        enabled: false,
        model: 'glm-5.3[1m]',
        usable: true,
        models: [
          { id: 'glm-5.3[1m]', hidden: false },
          { id: 'glm-4.6', hidden: false },
        ],
      },
    ],
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canManage = false;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function render(agentId: string | null, canChange = true) {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <ModelSelector
          groupJid="web:ws"
          agentId={agentId}
          canChange={canChange}
        />
      </MemoryRouter>,
    );
  });
}

async function rerender(canChange = true) {
  await act(async () => root.unmount());
  root = createRoot(container);
  await render(null, canChange);
}

function trigger(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label^="模型："]',
  );
  if (!button) throw new Error('model selector trigger not rendered');
  return button;
}

async function open() {
  await act(async () => trigger().click());
}

const rows = () => [
  ...document.querySelectorAll<HTMLButtonElement>('[data-model-row]'),
];
/** The first line of each row: the model (or the default) it stands for. */
const titles = () => rows().map((row) => row.getAttribute('title'));
const row = (title: string) =>
  rows().find((item) => item.getAttribute('title') === title);
const detail = (title: string) =>
  row(title)?.querySelectorAll('span span')[1]?.textContent ?? '';
const checked = () =>
  rows().filter((item) => item.getAttribute('aria-checked') === 'true');

/** The reasoning effort control next to the model; null when hidden. */
const effortTrigger = () =>
  container.querySelector<HTMLButtonElement>(
    'button[aria-label$="选择推理等级"]',
  );
async function openEffort() {
  await act(async () => {
    effortTrigger()!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  });
}
const effortItems = () => [
  ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
];
const effortItem = (text: string) =>
  effortItems().find((item) => item.textContent === text);

/** A connection whose models take reasoning efforts (a current server). */
function effortSelection(
  overrides: Partial<SessionModelSelection> = {},
): SessionModelSelection {
  const base = connectionSelection(overrides);
  return {
    ...base,
    options: [
      {
        ...base.options[0],
        models: [
          {
            id: 'opus',
            hidden: false,
            efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
            defaultEffort: 'xhigh',
          },
          {
            id: 'sonnet',
            hidden: false,
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'high',
          },
          { id: 'haiku', hidden: false },
        ],
      },
      base.options[1],
    ],
  };
}

const railButton = (label: string) =>
  document.querySelector<HTMLButtonElement>(
    `[role="group"][aria-label="模型配置"] button[aria-label="${label}"]`,
  );

async function search(value: string) {
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="搜索模型"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(element: HTMLElement | null | undefined) {
  if (!element) throw new Error('element not found');
  await act(async () => element.click());
}

describe('describeDefaultModel', () => {
  test('names the configuration the global default resolves to', () => {
    expect(
      describeDefaultModel(
        selection({
          default: { source: 'default', modelConfigId: 'glm', enabledCount: 3 },
        }),
      ),
    ).toBe('GLM');
  });

  test('names a ChatGPT default by the model it runs', () => {
    expect(
      describeDefaultModel(
        chatGptSelection({
          default: {
            source: 'default',
            modelConfigId: 'chatgpt',
            enabledCount: 2,
          },
        }),
      ),
    ).toBe('gpt-6.1-sol');
  });

  test('names the configuration an Agent or single provider resolves to', () => {
    expect(
      describeDefaultModel(
        selection({
          default: { source: 'agent', modelConfigId: 'glm', enabledCount: 1 },
        }),
      ),
    ).toBe('GLM');
    expect(describeDefaultModel(selection())).toBe('自动 · 2 个');
  });

  test('adds the model the server says the default runs', () => {
    expect(
      describeDefaultModel(
        selection({
          default: {
            source: 'agent',
            modelConfigId: 'glm',
            enabledCount: 1,
            model: 'glm-5.2[1m]',
          },
        }),
      ),
    ).toBe('GLM · glm-5.2（1M）');
    // A ChatGPT default is named by that model alone.
    expect(
      describeDefaultModel(
        chatGptSelection({
          default: {
            source: 'agent',
            modelConfigId: 'chatgpt',
            enabledCount: 2,
            model: 'gpt-6-astra',
          },
        }),
      ),
    ).toBe('gpt-6-astra');
    // The pool has no model of its own.
    expect(
      describeDefaultModel(
        selection({
          default: {
            source: 'pool',
            modelConfigId: null,
            enabledCount: 2,
            model: null,
          },
        }),
      ),
    ).toBe('自动 · 2 个');
  });

  test('the effort of a followed default is the model the server resolved', () => {
    const context = resolveEffortContext(
      chatGptSelection({
        default: {
          source: 'agent',
          modelConfigId: 'chatgpt',
          enabledCount: 2,
          model: 'gpt-5.5',
        },
      }),
    );
    expect(context?.model).toBe('gpt-5.5');
    expect(context?.efforts).toEqual(['low', 'medium', 'high']);
    expect(context?.picked).toBe(false);
    expect(context?.pinnedModel).toBeNull();
  });
});

describe('the trigger', () => {
  test('loads the conversation selection and names what the default runs, without a 默认 prefix', async () => {
    mocks.get.mockResolvedValue(selection());
    await render('session-1');
    expect(mocks.get).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection?agentId=session-1',
    );
    expect(trigger().textContent).toBe('自动 · 2 个');
    expect(trigger().disabled).toBe(false);

    mocks.get.mockResolvedValue(
      connectionSelection({
        default: {
          source: 'default',
          modelConfigId: 'glm',
          enabledCount: 2,
          model: 'glm-5.3[1m]',
        },
      }),
    );
    await rerender();
    expect(trigger().textContent).toBe('glm-5.3');
    expect(trigger().getAttribute('aria-label')).toBe(
      '模型：GLM · glm-5.3（1M）',
    );
  });

  test('names the picked model and is read-only without Modify', async () => {
    mocks.get.mockResolvedValue(selection({ selectedModelConfigId: 'glm' }));
    await render(null, false);
    expect(mocks.get).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
    );
    expect(trigger().textContent).toBe('glm-5.3');
    expect(trigger().disabled).toBe(true);
    // The full 「连接 · 模型」 is still readable.
    expect(trigger().title).toBe('GLM · glm-5.3（1M）');
  });

  test('is plain text at rest and filled on hover or while open', async () => {
    mocks.get.mockResolvedValue(connectionSelection());
    await render(null);
    const classes = [...trigger().classList];
    expect(classes).toEqual(
      expect.arrayContaining([
        'h-[30px]',
        'rounded-full',
        'text-label',
        'hover:bg-surface-hover',
        'data-[state=open]:bg-surface-hover',
      ]),
    );
    expect(classes.some((name) => name.startsWith('border'))).toBe(false);
    // The name truncates; the chevron stays.
    expect(trigger().querySelector('.truncate')).not.toBeNull();
    expect(trigger().querySelector('svg')).not.toBeNull();
    await open();
    expect(trigger().getAttribute('data-state')).toBe('open');
  });

  test('starts with the vendor mark of the model in use', async () => {
    mocks.get.mockResolvedValue(
      connectionSelection({ selectedModelConfigId: 'official' }),
    );
    await render(null);
    expect(
      trigger().querySelector('[data-vendor]')?.getAttribute('data-vendor'),
    ).toBe('anthropic');

    mocks.get.mockResolvedValue(
      chatGptSelection({ selectedModelConfigId: 'chatgpt' }),
    );
    await rerender();
    expect(
      trigger().querySelector('[data-vendor]')?.getAttribute('data-vendor'),
    ).toBe('openai');
    // The effort is a control of its own, not part of the model's label.
    expect(trigger().textContent).toBe('gpt-6.1-sol');
  });

  test('the full label shows in a tooltip', async () => {
    mocks.get.mockResolvedValue(
      connectionSelection({
        selectedModelConfigId: 'glm',
        selectedModel: 'glm-4.6',
      }),
    );
    await render(null);
    expect(trigger().title).toBe('');
    await act(async () => trigger().focus());
    expect(
      document.querySelector('[data-slot="tooltip-content"]')?.textContent,
    ).toContain('GLM · glm-4.6');
  });

  test('closing the panel does not pop the tooltip up over the pick', async () => {
    mocks.get.mockResolvedValue(connectionSelection());
    mocks.put.mockResolvedValue(
      connectionSelection({
        selectedModelConfigId: 'official',
        selectedModel: 'sonnet',
      }),
    );
    await render(null);
    await open();
    await click(row('sonnet'));
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
    // Leaving and coming back shows it again.
    await act(async () => {
      trigger().dispatchEvent(new PointerEvent('pointerleave'));
      trigger().blur();
    });
    await act(async () => trigger().focus());
    expect(
      document.querySelector('[data-slot="tooltip-content"]')?.textContent,
    ).toContain('Claude 官方 · sonnet');
  });

  test('stays hidden when no model configuration exists', async () => {
    mocks.get.mockResolvedValue(selection({ options: [] }));
    await render(null);
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('the panel', () => {
  test('lists the default and every model as two-line rows, the one in use checked', async () => {
    mocks.get.mockResolvedValue(
      connectionSelection({
        selectedModelConfigId: 'glm',
        selectedModel: 'glm-4.6',
      }),
    );
    await render(null);
    await open();
    expect(titles()).toEqual([
      '默认 · 自动 · 2 个',
      'opus',
      'sonnet',
      'glm-5.3',
      'glm-4.6',
    ]);
    // Second line: the connection, the 1M window, then any note.
    expect(detail('glm-5.3')).toBe('GLM · 1M 上下文');
    expect(detail('opus')).toBe('Claude 官方');
    // Pool membership is Settings' business.
    expect(document.body.textContent).not.toContain('未启用');
    expect(checked().map((item) => item.getAttribute('title'))).toEqual([
      'glm-4.6',
    ]);
    expect(checked()[0].querySelector('svg.lucide-check')).not.toBeNull();
  });

  test('rows and the rail carry vendor marks, with a monogram for an unknown relay', async () => {
    const base = connectionSelection();
    mocks.get.mockResolvedValue({
      ...base,
      options: [
        ...base.options,
        {
          id: 'relay',
          name: 'Relay 中转',
          kind: 'third_party',
          enabled: true,
          model: 'house-model',
          usable: true,
          models: [{ id: 'house-model', hidden: false }],
        },
      ],
    });
    await render(null);
    await open();
    const vendor = (element: Element | null | undefined) =>
      element?.querySelector('[data-vendor]')?.getAttribute('data-vendor') ??
      null;
    expect(vendor(row('opus'))).toBe('anthropic');
    expect(vendor(row('glm-4.6'))).toBe('zhipu');
    expect(vendor(railButton('Claude 官方'))).toBe('anthropic');
    expect(vendor(railButton('GLM'))).toBe('zhipu');
    // Nothing says who makes it: the first letter of the connection.
    expect(vendor(row('house-model'))).toBeNull();
    expect(railButton('Relay 中转')?.textContent).toBe('R');
  });

  test('the rail filters by connection and 全部 brings everything back', async () => {
    mocks.get.mockResolvedValue(connectionSelection());
    await render(null);
    await open();
    expect(railButton('全部')?.getAttribute('aria-pressed')).toBe('true');
    await click(railButton('GLM'));
    expect(railButton('GLM')?.getAttribute('aria-pressed')).toBe('true');
    expect(titles()).toEqual(['glm-5.3', 'glm-4.6']);
    await click(railButton('全部'));
    expect(titles()).toHaveLength(5);
  });

  test('search looks through every connection, whatever the rail shows', async () => {
    mocks.get.mockResolvedValue(connectionSelection());
    await render(null);
    await open();
    await click(railButton('GLM'));
    await search('SON');
    expect(titles()).toEqual(['sonnet']);
    await search('glm');
    // A connection's name matches all of its models.
    expect(titles()).toEqual(['glm-5.3', 'glm-4.6']);
    await search('nothing-like-this');
    expect(rows()).toHaveLength(0);
    expect(document.body.textContent).toContain('没有匹配的模型');
  });

  test('offers 管理模型配置 to whoever may manage them', async () => {
    mocks.get.mockResolvedValue(connectionSelection());
    await render(null);
    await open();
    expect(document.body.textContent).not.toContain('管理模型配置');

    mocks.canManage = true;
    await rerender();
    await open();
    const manage = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '管理模型配置',
    );
    await click(manage);
    expect(trigger().getAttribute('data-state')).toBe('closed');
  });

  test('a configuration without a credential is shown but not selectable', async () => {
    mocks.get.mockResolvedValue(
      selection({
        options: [
          ...selection().options,
          {
            id: 'copy',
            name: 'GLM (副本)',
            kind: 'third_party',
            enabled: false,
            model: 'glm-5.2',
            usable: false,
          },
        ],
      }),
    );
    await render(null);
    await open();
    expect(detail('glm-5.2')).toContain('缺少凭据');
    expect(row('glm-5.2')?.disabled).toBe(true);
  });

  test('picking a configuration from an older server sends only the configuration', async () => {
    mocks.get.mockResolvedValue(selection());
    mocks.put.mockResolvedValue(selection({ selectedModelConfigId: 'glm' }));
    await render('session-1');
    await open();
    expect(titles()).toEqual(['默认 · 自动 · 2 个', 'opus', 'glm-5.3']);
    await click(row('glm-5.3'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      { agentId: 'session-1', modelConfigId: 'glm' },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      '已切换到「GLM · glm-5.3（1M）」，从下一条消息开始生效',
    );
    expect(trigger().textContent).toBe('glm-5.3');
    // The panel closes once something is picked.
    expect(rows()).toHaveLength(0);
  });
});

describe('models of a configuration', () => {
  test('picking a model of a configuration pins it for the conversation', async () => {
    mocks.get.mockResolvedValue(connectionSelection());
    mocks.put.mockResolvedValue(
      connectionSelection({
        selectedModelConfigId: 'glm',
        selectedModel: 'glm-4.6',
      }),
    );
    await render(null);
    await open();
    await click(row('glm-4.6'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      { agentId: null, modelConfigId: 'glm', model: 'glm-4.6' },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      '已切换到「GLM · glm-4.6」，从下一条消息开始生效',
    );
  });

  test('the default model row follows the configuration with the request older servers know', async () => {
    mocks.get.mockResolvedValue(
      connectionSelection({
        selectedModelConfigId: 'glm',
        selectedModel: 'glm-4.6',
      }),
    );
    mocks.put.mockResolvedValue(
      connectionSelection({ selectedModelConfigId: 'glm' }),
    );
    await render(null);
    await open();
    await click(row('glm-5.3'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      { agentId: null, modelConfigId: 'glm' },
    );
  });

  test('a hidden model the conversation runs on stays visible and checked', async () => {
    mocks.get.mockResolvedValue(
      connectionSelection({
        selectedModelConfigId: 'official',
        selectedModel: 'haiku',
      }),
    );
    await render(null);
    await open();
    expect(titles()).toContain('haiku');
    expect(detail('haiku')).toContain('已隐藏');
    expect(checked().map((item) => item.getAttribute('title'))).toEqual([
      'haiku',
    ]);
  });

  test('a model the list no longer has stays visible and checked', async () => {
    mocks.get.mockResolvedValue(
      connectionSelection({
        selectedModelConfigId: 'glm',
        selectedModel: 'glm-4.0',
      }),
    );
    await render(null);
    await open();
    expect(detail('glm-4.0')).toContain('不在模型列表里');
    expect(checked()[0].getAttribute('title')).toBe('glm-4.0');
    // Choosing it again changes nothing.
    await click(checked()[0]);
    expect(mocks.put).not.toHaveBeenCalled();
  });

  test('a configuration without a credential lists its models disabled', async () => {
    const base = connectionSelection();
    mocks.get.mockResolvedValue({
      ...base,
      options: [base.options[0], { ...base.options[1], usable: false }],
    });
    await render(null);
    await open();
    expect(row('glm-4.6')?.disabled).toBe(true);
    expect(detail('glm-4.6')).toContain('缺少凭据');
    expect(row('sonnet')?.disabled).toBe(false);
  });

  test('a relay without a model of its own lets the relay decide', async () => {
    const base = connectionSelection();
    mocks.get.mockResolvedValue({
      ...base,
      options: [
        base.options[0],
        {
          ...base.options[1],
          model: '',
          models: [{ id: 'glm-4.6', hidden: false }],
        },
      ],
    });
    mocks.put.mockResolvedValue(base);
    await render(null);
    await open();
    await click(row('由中转站决定'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      { agentId: null, modelConfigId: 'glm' },
    );
  });

  test('a refused model reads as such and reloads the selection', async () => {
    mocks.get.mockResolvedValue(connectionSelection());
    mocks.put.mockRejectedValue({
      status: 400,
      message: 'model not in connection',
      body: { code: 'MODEL_NOT_IN_CONNECTION' },
    });
    await render(null);
    await open();
    await click(row('glm-4.6'));
    expect(mocks.toastError).toHaveBeenCalledWith(
      '所选模型已不在该模型配置的模型列表里，请重新选择模型',
    );
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });
});

describe('ChatGPT models', () => {
  test('lists a login models by name only', async () => {
    mocks.get.mockResolvedValue(chatGptSelection());
    await render(null);
    await open();
    expect(titles()).toEqual([
      '默认 · 自动 · 2 个',
      'opus',
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-5.5',
    ]);
    // The catalog may still carry commentary; the picker never shows it.
    expect(document.body.textContent).not.toMatch(
      /主力编码|旗舰|遗留|配置默认/,
    );
    expect(detail('gpt-6-astra')).toBe('ChatGPT 订阅');
    // ChatGPT shows the OpenAI mark, Claude the Anthropic one.
    expect(
      railButton('ChatGPT 订阅')
        ?.querySelector('[data-vendor]')
        ?.getAttribute('data-vendor'),
    ).toBe('openai');
    expect(
      railButton('Claude 官方')
        ?.querySelector('[data-vendor]')
        ?.getAttribute('data-vendor'),
    ).toBe('anthropic');
    expect(document.body.textContent).toContain('推理等级在输入框旁调整');
  });

  test('a stored model the account list lacks stays visible and checked', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-unlisted',
      }),
    );
    await render(null);
    await open();
    expect(checked()[0].getAttribute('title')).toBe('gpt-unlisted');
    expect(detail('gpt-unlisted')).toContain('不在账号的模型列表里');
    await click(checked()[0]);
    expect(mocks.put).not.toHaveBeenCalled();
  });

  test('picking a model saves it with the effort it still supports', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-6.1-sol',
        selectedEffort: 'high',
      }),
    );
    mocks.put.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-6-astra',
        selectedEffort: 'high',
      }),
    );
    await render('session-1');
    await open();
    await click(row('gpt-6-astra'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      {
        agentId: 'session-1',
        modelConfigId: 'chatgpt',
        model: 'gpt-6-astra',
        effort: 'high',
      },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      '已切换到「ChatGPT 订阅 · gpt-6-astra」，从下一条消息开始生效',
    );
  });

  test('a model without the picked effort returns to its default and says so', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-6.1-sol',
        selectedEffort: 'max',
      }),
    );
    mocks.put.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-5.5',
      }),
    );
    await render(null);
    await open();
    await click(row('gpt-5.5'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      {
        agentId: null,
        modelConfigId: 'chatgpt',
        model: 'gpt-5.5',
        effort: null,
      },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining('该模型不支持最高，推理等级已恢复为默认（中）'),
    );
  });

  test('the default row drops the model and the effort with it', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-6-astra',
        selectedEffort: 'high',
      }),
    );
    mocks.put.mockResolvedValue(chatGptSelection());
    await render(null);
    await open();
    await click(row('默认 · 自动 · 2 个'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      { agentId: null, modelConfigId: null },
    );
    // The configuration's own model is a pick of the configuration alone.
    mocks.put.mockResolvedValue(
      chatGptSelection({ selectedModelConfigId: 'chatgpt' }),
    );
    await open();
    await click(row('gpt-6.1-sol'));
    expect(mocks.put).toHaveBeenLastCalledWith(
      '/api/groups/web%3Aws/model-selection',
      { agentId: null, modelConfigId: 'chatgpt', model: null, effort: null },
    );
  });

  test('a login that has to be redone cannot be picked', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({}, { needsReauth: true }, {}),
    );
    await render(null);
    await open();
    expect(row('gpt-6-astra')?.disabled).toBe(true);
    expect(detail('gpt-6-astra')).toContain('需重新登录');
    expect(row('opus')?.disabled).toBe(false);
  });

  test('looks again when the panel opens while the list is only a fallback', async () => {
    mocks.get.mockResolvedValue(chatGptSelection({}, { source: 'builtin' }));
    await render(null);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    const live = chatGptSelection(
      {},
      {
        source: 'live',
        models: [
          {
            value: 'gpt-7-new',
            label: 'gpt-7-new',
            efforts: FULL,
            defaultEffort: 'medium',
          },
        ],
        defaultModel: 'gpt-7-new',
      },
    );
    mocks.get.mockResolvedValue(live);
    // Within a few seconds of the first load nothing is asked again.
    await open();
    expect(mocks.get).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 10_000);
      await act(async () => root.unmount());
      root = createRoot(container);
      mocks.get.mockClear();
      mocks.get.mockResolvedValueOnce(
        chatGptSelection({}, { source: 'builtin' }),
      );
      await render(null);
      vi.setSystemTime(Date.now() + 10_000);
      mocks.get.mockResolvedValue(live);
      await open();
      expect(mocks.get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('never puts an older selection back over one that was just saved', async () => {
    vi.useFakeTimers();
    try {
      mocks.get.mockResolvedValueOnce(
        chatGptSelection({}, { source: 'builtin' }),
      );
      await render(null);
      vi.setSystemTime(Date.now() + 10_000);
      // The look-up the panel starts is slow; the save overtakes it.
      let answerLookUp!: (value: SessionModelSelection) => void;
      mocks.get.mockReturnValueOnce(
        new Promise<SessionModelSelection>((resolve) => {
          answerLookUp = resolve;
        }),
      );
      mocks.put.mockResolvedValue(
        chatGptSelection({
          selectedModelConfigId: 'chatgpt',
          selectedModel: 'gpt-6-astra',
        }),
      );
      await open();
      await click(row('gpt-6-astra'));
      expect(trigger().textContent).toContain('gpt-6-astra');
      await act(async () => {
        answerLookUp(chatGptSelection({}, { source: 'live' }));
      });
      expect(trigger().textContent).toContain('gpt-6-astra');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reasoning effort', () => {
  test('appears only when the model in use takes efforts', async () => {
    // Older servers list no efforts for a connection's models.
    mocks.get.mockResolvedValue(connectionSelection());
    await render(null);
    expect(effortTrigger()).toBeNull();

    // Following the pool: no model, so no effort.
    mocks.get.mockResolvedValue(effortSelection());
    await rerender();
    expect(effortTrigger()).toBeNull();

    mocks.get.mockResolvedValue(
      effortSelection({
        selectedModelConfigId: 'official',
        selectedModel: 'haiku',
      }),
    );
    await rerender();
    expect(effortTrigger()).toBeNull();

    mocks.get.mockResolvedValue(
      effortSelection({ selectedModelConfigId: 'official' }),
    );
    await rerender();
    expect(effortTrigger()).not.toBeNull();
    // It follows the model control.
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.indexOf(effortTrigger()!)).toBeGreaterThan(
      buttons.indexOf(trigger()),
    );
  });

  test('shows the level in use, the model default until one is picked', async () => {
    mocks.get.mockResolvedValue(
      effortSelection({ selectedModelConfigId: 'official' }),
    );
    await render(null);
    expect(effortTrigger()!.textContent).toBe('超高');
    // Screen readers hear the level too.
    expect(effortTrigger()!.getAttribute('aria-label')).toBe(
      '推理等级：默认（超高），选择推理等级',
    );
    await act(async () => effortTrigger()!.focus());
    expect(
      document.querySelector('[data-slot="tooltip-content"]')?.textContent,
    ).toContain('选择推理等级');

    mocks.get.mockResolvedValue(
      effortSelection({
        selectedModelConfigId: 'official',
        selectedEffort: 'low',
      }),
    );
    await rerender();
    expect(effortTrigger()!.textContent).toBe('低');
    expect(effortTrigger()!.getAttribute('aria-label')).toBe(
      '推理等级：低，选择推理等级',
    );
  });

  test('reads 选择推理等级 when Claude Code picks the level itself', async () => {
    // An official login with nothing configured: the server knows no level.
    const base = effortSelection({
      default: {
        source: 'default',
        modelConfigId: 'official',
        enabledCount: 2,
        model: 'opus',
        effort: null,
      },
    });
    base.options[0].models![0] = {
      id: 'opus',
      hidden: false,
      efforts: ['low', 'high'],
    };
    mocks.get.mockResolvedValue(base);
    mocks.put.mockResolvedValue({
      ...base,
      selectedModelConfigId: 'official',
      selectedModel: 'opus',
      selectedEffort: 'high',
    });
    await render(null);
    expect(effortTrigger()!.textContent).toBe('选择推理等级');
    expect(effortTrigger()!.getAttribute('aria-label')).toBe(
      '推理等级：默认，选择推理等级',
    );
    await openEffort();
    // 默认 stands alone, with no level after it.
    expect(effortItems().map((item) => item.textContent)).toEqual([
      '默认',
      '低',
      '高',
    ]);
    expect(effortItem('默认')?.getAttribute('aria-checked')).toBe('true');
    await click(effortItem('高'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      {
        agentId: null,
        modelConfigId: 'official',
        model: 'opus',
        effort: 'high',
      },
    );
    expect(effortTrigger()!.textContent).toBe('高');
  });

  test('lists 默认 and the model levels, and saves a pick for the conversation', async () => {
    mocks.get.mockResolvedValue(
      effortSelection({
        selectedModelConfigId: 'official',
        selectedModel: 'sonnet',
      }),
    );
    mocks.put.mockResolvedValue(
      effortSelection({
        selectedModelConfigId: 'official',
        selectedModel: 'sonnet',
        selectedEffort: 'medium',
      }),
    );
    await render('session-1');
    await openEffort();
    expect(effortItems().map((item) => item.textContent)).toEqual([
      '默认 · 高',
      '低',
      '中',
      '高',
    ]);
    expect(effortItem('默认 · 高')?.getAttribute('aria-checked')).toBe('true');
    await click(effortItem('中'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      {
        agentId: 'session-1',
        modelConfigId: 'official',
        model: 'sonnet',
        effort: 'medium',
      },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      '推理等级已设为中，从下一条消息开始生效',
    );
    expect(effortTrigger()!.textContent).toBe('中');
  });

  test('picking a level while on 默认 names the default connection and model', async () => {
    const following = effortSelection({
      default: {
        source: 'default',
        modelConfigId: 'official',
        enabledCount: 2,
        model: 'opus',
        effort: 'high',
      },
    });
    mocks.get.mockResolvedValue(following);
    mocks.put.mockResolvedValue({
      ...following,
      selectedModelConfigId: 'official',
      selectedModel: 'opus',
      selectedEffort: 'max',
    });
    await render(null);
    // The default's own level (an Agent's, say) wins over the model's.
    expect(effortTrigger()!.textContent).toBe('高');
    await openEffort();
    // Already following the default: choosing it again sends nothing.
    await click(effortItem('默认 · 高'));
    expect(mocks.put).not.toHaveBeenCalled();
    await openEffort();
    await click(effortItem('最高'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      {
        agentId: null,
        modelConfigId: 'official',
        model: 'opus',
        effort: 'max',
      },
    );
  });

  test('默认 clears a picked level', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedEffort: 'max',
      }),
    );
    mocks.put.mockResolvedValue(
      chatGptSelection({ selectedModelConfigId: 'chatgpt' }),
    );
    await render(null);
    expect(effortTrigger()!.textContent).toBe('最高');
    await openEffort();
    await click(effortItem('默认 · 低'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      { agentId: null, modelConfigId: 'chatgpt', model: null, effort: null },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      '已恢复默认推理等级，从下一条消息开始生效',
    );
  });

  test('focus that moved on while the menu closed stays where it went', async () => {
    const pinned = effortSelection({
      selectedModelConfigId: 'official',
      selectedModel: 'sonnet',
    });
    mocks.get.mockResolvedValue(pinned);
    mocks.put.mockResolvedValue({ ...pinned, selectedEffort: 'medium' });
    await render(null);
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    await openEffort();
    // The closed menu hands focus back on a timer; hold it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await act(async () => effortItem('中')!.click());
      expect(document.querySelector('[role="menu"]')).toBeNull();
      elsewhere.focus();
      await act(async () => vi.runOnlyPendingTimers());
    } finally {
      vi.useRealTimers();
    }
    expect(document.activeElement).toBe(elsewhere);

    // Otherwise the menu returns focus to its trigger.
    await openEffort();
    await click(effortItem('高'));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(document.activeElement).toBe(effortTrigger());
  });

  test('a ChatGPT model lists the levels the server allows this user', async () => {
    const withUltra = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    mocks.get.mockResolvedValue(
      chatGptSelection(
        { selectedModelConfigId: 'chatgpt', selectedModel: 'gpt-6-astra' },
        {
          models: [
            {
              value: 'gpt-6-astra',
              label: 'gpt-6-astra',
              efforts: withUltra,
              defaultEffort: 'medium',
            },
          ],
        },
      ),
    );
    await render(null);
    await openEffort();
    expect(effortItem('极限')).toBeDefined();

    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-6-astra',
      }),
    );
    await rerender();
    await openEffort();
    expect(effortItem('极限')).toBeUndefined();
  });

  test('a model switch keeps a level the new model takes, and clears one it does not', async () => {
    mocks.get.mockResolvedValue(
      effortSelection({
        selectedModelConfigId: 'official',
        selectedEffort: 'xhigh',
      }),
    );
    mocks.put.mockResolvedValue(
      effortSelection({
        selectedModelConfigId: 'official',
        selectedModel: 'sonnet',
      }),
    );
    await render(null);
    await open();
    await click(row('sonnet'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      {
        agentId: null,
        modelConfigId: 'official',
        model: 'sonnet',
        effort: null,
      },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining('该模型不支持超高，推理等级已恢复为默认（高）'),
    );

    // 高 is a level sonnet has too.
    mocks.get.mockResolvedValue(
      effortSelection({
        selectedModelConfigId: 'official',
        selectedEffort: 'high',
      }),
    );
    await rerender();
    await open();
    await click(row('sonnet'));
    expect(mocks.put).toHaveBeenLastCalledWith(
      '/api/groups/web%3Aws/model-selection',
      {
        agentId: null,
        modelConfigId: 'official',
        model: 'sonnet',
        effort: 'high',
      },
    );
  });

  test('is read-only without Modify, and while the login must be redone', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({ selectedModelConfigId: 'chatgpt' }),
    );
    await render(null, false);
    expect(effortTrigger()!.disabled).toBe(true);
    // The level in use is still readable.
    expect(effortTrigger()!.textContent).toBe('低');

    mocks.get.mockResolvedValue(
      chatGptSelection(
        { selectedModelConfigId: 'chatgpt' },
        { needsReauth: true },
      ),
    );
    await rerender();
    expect(effortTrigger()!.disabled).toBe(true);
  });

  test('is hidden when the model in use is not in the account list', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-unlisted',
      }),
    );
    await render(null);
    expect(trigger().textContent).toBe('gpt-unlisted');
    expect(effortTrigger()).toBeNull();
  });

  test('a refused level reads as such and reloads what the server holds', async () => {
    mocks.get.mockResolvedValue(
      effortSelection({ selectedModelConfigId: 'official' }),
    );
    mocks.put.mockRejectedValue({
      status: 400,
      message: 'effort not supported',
      body: { code: 'EFFORT_NOT_SUPPORTED' },
    });
    await render(null);
    await openEffort();
    await click(effortItem('低'));
    expect(mocks.toastError).toHaveBeenCalledWith(
      '这个模型不支持所选的推理等级，请重新选择',
    );
    // Picked again from the server's state.
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(effortTrigger()!.textContent).toBe('超高');
  });
});

const PHONE = '(max-width: 1023px) and (pointer: coarse)';
const NARROW = '(max-width: 639px)';

/** Media queries answer as on a device matching `matching`. */
function emulate(...matching: string[]) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: matching.includes(query),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

const pill = () =>
  container.querySelector<HTMLButtonElement>('button[data-model-pill]');
const sheet = () =>
  document.querySelector<HTMLElement>('[data-slot="sheet-content"]');
const segments = () =>
  document.querySelector<HTMLFieldSetElement>('[data-effort-segments]');
const segment = (text: string) =>
  [...(segments()?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent === text,
  );

describe('on a phone', () => {
  beforeEach(() => emulate(PHONE, NARROW));
  afterEach(() => vi.restoreAllMocks());

  test('one 12px pill names the model and its level', async () => {
    mocks.get.mockResolvedValue(
      effortSelection({ selectedModelConfigId: 'official' }),
    );
    await render(null);
    expect(trigger()).toBe(pill());
    expect(effortTrigger()).toBeNull();
    expect(pill()!.textContent).toBe('opus·超高');
    expect(pill()!.getAttribute('aria-label')).toBe(
      '模型：Claude 官方 · opus，推理等级：默认（超高）',
    );
    expect(pill()!.className).toContain('h-[34px]');
    expect(pill()!.className).toContain('text-caption');
    expect(pill()!.className).toContain('font-medium');
    // The model name gives way first; the level stays whole.
    const [name, level] = [...pill()!.querySelectorAll(':scope > span')].slice(
      1,
    );
    expect(name.className).toContain('truncate');
    expect(level.className).toContain('shrink-0');
    expect(pill()!.querySelector('[data-vendor="anthropic"]')).not.toBeNull();

    // A model without efforts: the model alone.
    mocks.get.mockResolvedValue(
      effortSelection({
        selectedModelConfigId: 'official',
        selectedModel: 'haiku',
      }),
    );
    await rerender();
    expect(pill()!.textContent).toBe('haiku');
    expect(pill()!.getAttribute('aria-label')).toBe(
      '模型：Claude 官方 · haiku',
    );
  });

  test('a level Claude Code picks itself leaves the pill to the model', async () => {
    const base = effortSelection({ selectedModelConfigId: 'official' });
    base.options[0].models![0] = {
      id: 'opus',
      hidden: false,
      efforts: ['low', 'high'],
    };
    mocks.get.mockResolvedValue(base);
    await render(null);
    expect(pill()!.textContent).toBe('opus');
    expect(pill()!.getAttribute('aria-label')).toBe(
      '模型：Claude 官方 · opus，推理等级：默认',
    );
  });

  test('the sheet opens at half height with the levels under the model in use', async () => {
    const pinned = effortSelection({ selectedModelConfigId: 'official' });
    mocks.get.mockResolvedValue(pinned);
    mocks.put.mockResolvedValue({ ...pinned, selectedEffort: 'high' });
    await render(null);
    await open();
    expect(sheet()?.dataset.snap).toBe('half');
    expect(segments()?.previousElementSibling).toBe(checked()[0]);
    expect(checked()[0].getAttribute('title')).toBe('opus');
    expect(
      [...segments()!.querySelectorAll('button')].map(
        (button) => button.textContent,
      ),
    ).toEqual(['默认', '低', '中', '高', '超高', '最高']);
    expect(segment('默认')?.getAttribute('aria-pressed')).toBe('true');
    expect(segments()!.textContent).toContain('推理等级 · 默认超高');
    // Screen readers hear the default level with the group.
    expect(
      segments()!.querySelector('[role="group"]')?.getAttribute('aria-label'),
    ).toBe('推理等级（默认超高）');
    expect(document.body.textContent).not.toContain('推理等级在输入框旁调整');

    await click(segment('高'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      { agentId: null, modelConfigId: 'official', model: null, effort: 'high' },
    );
    // Applied in place: the sheet stays, the pick is pressed.
    expect(sheet()).not.toBeNull();
    expect(segment('高')?.getAttribute('aria-pressed')).toBe('true');
    expect(pill()!.textContent).toBe('opus·高');
  });

  test('following the default, the levels sit under 默认 and name its model', async () => {
    const following = effortSelection({
      default: {
        source: 'default',
        modelConfigId: 'official',
        enabledCount: 2,
        model: 'opus',
        effort: 'high',
      },
    });
    mocks.get.mockResolvedValue(following);
    mocks.put.mockResolvedValue(following);
    await render(null);
    await open();
    expect(checked()[0].getAttribute('title')).toMatch(/^默认/);
    expect(segments()?.previousElementSibling).toBe(checked()[0]);
    await click(segment('最高'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      {
        agentId: null,
        modelConfigId: 'official',
        model: 'opus',
        effort: 'max',
      },
    );
  });

  test('the sheet gives the rows the width and drops the footnote', async () => {
    mocks.get.mockResolvedValue(
      effortSelection({ selectedModelConfigId: 'official' }),
    );
    await render(null);
    await open();
    expect(sheet()!.querySelector('[aria-label="模型配置"]')).toBeNull();
    expect(sheet()!.textContent).not.toContain('切换模型会开启新的底层会话');
    expect(checked()).toHaveLength(1);
  });

  test('a model without efforts gets no row', async () => {
    mocks.get.mockResolvedValue(
      effortSelection({
        selectedModelConfigId: 'official',
        selectedModel: 'haiku',
      }),
    );
    await render(null);
    await open();
    expect(checked()[0].getAttribute('title')).toBe('haiku');
    expect(segments()).toBeNull();
  });

  test('the levels are read-only while the login must be redone', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection(
        { selectedModelConfigId: 'chatgpt' },
        { needsReauth: true },
      ),
    );
    await render(null);
    await open();
    expect(segments()!.disabled).toBe(true);
    await click(segment('高'));
    expect(mocks.put).not.toHaveBeenCalled();
  });
});

describe('in a narrow window with a mouse', () => {
  beforeEach(() => emulate(NARROW));
  afterEach(() => vi.restoreAllMocks());

  test('keeps the separate effort control and opens the sheet without levels', async () => {
    mocks.get.mockResolvedValue(
      effortSelection({ selectedModelConfigId: 'official' }),
    );
    await render(null);
    expect(pill()).toBeNull();
    expect(effortTrigger()!.textContent).toBe('超高');
    await open();
    expect(sheet()?.dataset.snap).toBe('half');
    expect(segments()).toBeNull();
    expect(document.body.textContent).toContain('推理等级在输入框旁调整');
  });
});
