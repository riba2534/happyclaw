// @vitest-environment happy-dom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { ModelChoice } from '../../lib/session-model-choice';

const get = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', () => ({ api: { get } }));

const { SessionModelChoiceField } = await import('./SessionModelChoiceField');
const { forgetWorkspaceModelOptions } =
  await import('../../lib/session-model-choice');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** A model-options answer: one of each kind of connection. */
const MODEL_OPTIONS = {
  default: {
    source: 'agent',
    modelConfigId: 'glm',
    connectionMissing: false,
    model: 'glm-5.3',
    effort: null,
  },
  options: [
    {
      id: 'glm',
      name: 'GLM',
      kind: 'third_party',
      model: 'glm-5.3',
      usable: true,
      models: [
        {
          id: 'glm-5.3',
          efforts: ['low', 'high'],
          defaultEffort: 'high',
          contextWindow: 200000,
          effortsSource: 'declared',
          // The vendor's name: shown instead of the id.
          displayName: 'GLM 5.3',
        },
        {
          // Declared to take no effort.
          id: 'glm-4.6',
          efforts: [],
          defaultEffort: null,
          contextWindow: null,
          effortsSource: 'declared',
        },
      ],
    },
    {
      id: 'broken',
      name: 'Broken',
      kind: 'third_party',
      model: 'x-1',
      usable: false,
      models: [],
    },
    {
      id: 'gpt',
      name: 'ChatGPT',
      kind: 'codex',
      model: '',
      usable: true,
      codex: {
        defaultModel: 'gpt-5.5',
        defaultEffort: 'medium',
        source: 'live',
        needsReauth: false,
        models: [
          {
            value: 'gpt-5.5',
            label: 'GPT-5.5',
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'medium',
          },
          {
            value: 'gpt-5.5-mini',
            label: 'GPT-5.5 mini',
            efforts: ['low'],
            defaultEffort: 'low',
          },
        ],
      },
    },
    {
      id: 'relogin',
      name: 'Old login',
      kind: 'codex',
      model: '',
      usable: true,
      codex: {
        defaultModel: 'gpt-5',
        defaultEffort: 'medium',
        source: 'fallback',
        needsReauth: true,
        models: [],
      },
    },
  ],
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  get.mockReset();
  forgetWorkspaceModelOptions();
});

const onChange = vi.fn();

/** The field as a form holds it: its value is the last change. */
function Harness({ initial }: { initial: ModelChoice | null }) {
  const [value, setValue] = useState(initial);
  return (
    <SessionModelChoiceField
      workspaceJid="web:dev"
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

async function render(initial: ModelChoice | null = null) {
  onChange.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Harness initial={initial} />));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const select = (label: string) =>
  container!.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
const optionTexts = (label: string) =>
  [...select(label)!.options].map((option) => option.textContent);
const note = () =>
  container!.querySelector('[data-testid="model-choice-note"]');

async function pick(label: string, value: string) {
  const element = select(label)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    )!.set!.call(element, value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('SessionModelChoiceField', () => {
  test('starts on the default, saying what it runs, then lists the connections', async () => {
    get.mockResolvedValue(MODEL_OPTIONS);
    await render();
    expect(get).toHaveBeenCalledWith('/api/groups/web%3Adev/model-options');
    expect(select('模型连接')!.value).toBe('');
    expect(optionTexts('模型连接')).toEqual([
      '跟随智能体',
      'GLM',
      'Broken（缺少凭据）',
      'ChatGPT',
      'Old login（需重新登录）',
    ]);
    // The display name stands for the model.
    expect(note()!.textContent).toBe('GLM · GLM 5.3');
    expect(note()!.className).not.toContain('text-warning');
    // Connections that would fail cannot be picked.
    const disabled = [...select('模型连接')!.options]
      .filter((option) => option.disabled)
      .map((option) => option.value);
    expect(disabled).toEqual(['broken', 'relogin']);
    // Nothing to pick within the default.
    expect(select('连接中的模型')).toBeNull();
    expect(select('推理等级')).toBeNull();
  });

  test('a connection, then its model and effort, are what it emits', async () => {
    get.mockResolvedValue(MODEL_OPTIONS);
    await render();
    await pick('模型连接', 'glm');
    expect(onChange).toHaveBeenLastCalledWith({
      modelConfigId: 'glm',
      model: null,
      effort: null,
    });
    expect(optionTexts('连接中的模型')).toEqual([
      '连接默认模型（GLM 5.3）',
      'GLM 5.3',
      'glm-4.6',
    ]);
    // The connection's own model takes efforts.
    expect(optionTexts('推理等级')).toEqual(['默认（高）', '低', '高']);

    await pick('推理等级', 'low');
    expect(onChange).toHaveBeenLastCalledWith({
      modelConfigId: 'glm',
      model: null,
      effort: 'low',
    });
    // A model that takes no efforts drops the effort and its control.
    await pick('连接中的模型', 'glm-4.6');
    expect(onChange).toHaveBeenLastCalledWith({
      modelConfigId: 'glm',
      model: 'glm-4.6',
      effort: null,
    });
    expect(select('推理等级')).toBeNull();

    await pick('模型连接', '');
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(select('连接中的模型')).toBeNull();
  });

  test('a model nothing is known about offers every effort, unverified', async () => {
    get.mockResolvedValue({
      ...MODEL_OPTIONS,
      options: [
        {
          ...MODEL_OPTIONS.options[0],
          models: [
            {
              id: 'mystery-1',
              efforts: [],
              defaultEffort: null,
              contextWindow: null,
              effortsSource: 'none',
            },
          ],
        },
      ],
    });
    await render({ modelConfigId: 'glm', model: 'mystery-1', effort: null });
    const [first, ...efforts] = optionTexts('推理等级');
    expect(first).toBe('默认');
    expect(efforts).toHaveLength(5);
    for (const text of efforts) expect(text).toMatch(/（未验证）$/);
    await pick('推理等级', 'xhigh');
    expect(onChange).toHaveBeenLastCalledWith({
      modelConfigId: 'glm',
      model: 'mystery-1',
      effort: 'xhigh',
    });
  });

  test('a ChatGPT connection lists the models of its account', async () => {
    get.mockResolvedValue(MODEL_OPTIONS);
    await render({ modelConfigId: 'gpt', model: null, effort: null });
    expect(optionTexts('连接中的模型')).toEqual([
      '连接默认模型（GPT-5.5）',
      'GPT-5.5',
      'GPT-5.5 mini',
    ]);
    expect(optionTexts('推理等级')).toEqual(['默认（中）', '低', '中', '高']);
    await pick('推理等级', 'high');
    // An effort the next model has is kept.
    await pick('连接中的模型', 'gpt-5.5');
    expect(onChange).toHaveBeenLastCalledWith({
      modelConfigId: 'gpt',
      model: 'gpt-5.5',
      effort: 'high',
    });
    // One it lacks is not.
    await pick('连接中的模型', 'gpt-5.5-mini');
    expect(onChange).toHaveBeenLastCalledWith({
      modelConfigId: 'gpt',
      model: 'gpt-5.5-mini',
      effort: null,
    });
  });

  test('a saved choice the list no longer has is shown as it is', async () => {
    get.mockResolvedValue(MODEL_OPTIONS);
    await render({ modelConfigId: 'glm', model: 'glm-old', effort: 'max' });
    expect(select('连接中的模型')!.value).toBe('glm-old');
    expect(optionTexts('连接中的模型')).toContain('glm-old（不在模型列表里）');
    expect(select('推理等级')!.value).toBe('max');
    expect(onChange).not.toHaveBeenCalled();
  });

  test('a default that cannot run says so', async () => {
    get.mockResolvedValue({
      ...MODEL_OPTIONS,
      default: { source: 'none', modelConfigId: null, model: null },
    });
    await render();
    expect(note()!.textContent).toBe('未选择模型，运行会失败；请选择连接');
    expect(note()!.className).toContain('text-warning');
  });

  test('options that cannot be read leave the default', async () => {
    get.mockRejectedValue({ status: 404, message: 'Not Found' });
    await render();
    expect(optionTexts('模型连接')).toEqual(['跟随智能体']);
    expect(note()!.textContent).toBe('无法读取可选模型，将跟随智能体');
  });
});
