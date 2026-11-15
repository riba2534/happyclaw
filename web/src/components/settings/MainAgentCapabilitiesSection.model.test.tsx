// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  AgentProfile,
  InheritedModel,
  ModelConfigOption,
} from '../../types';
import { choose, combobox } from './test-helpers';

const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
  governance: vi.fn(),
  loadProfiles: vi.fn(async () => undefined),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  confirm: vi.fn(async () => true),
  state: {} as Record<string, unknown>,
}));

vi.mock('../../stores/confirm', () => ({
  confirmDialog: mocks.confirm,
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock('../../stores/agent-profiles', () => ({
  useAgentProfilesStore: (selector: (state: unknown) => unknown) =>
    selector(mocks.state),
}));
vi.mock('../../stores/skills', () => ({
  useSkillsStore: (selector: (state: unknown) => unknown) =>
    selector({
      skills: [],
      loading: false,
      error: null,
      loadSkills: vi.fn(async () => undefined),
    }),
}));
vi.mock('../../stores/mcp-servers', () => ({
  useMcpServersStore: (selector: (state: unknown) => unknown) =>
    selector({
      servers: [],
      loading: false,
      error: null,
      loadServers: vi.fn(async () => undefined),
    }),
}));
vi.mock('../agents/AgentSkillsPolicyEditor', () => ({
  AgentSkillsPolicyEditor: () => null,
}));
vi.mock('../agents/EffectiveCapabilitiesPreview', () => ({
  EffectiveCapabilitiesPreview: () => null,
}));
vi.mock('../agents/PolicyResourcePicker', () => ({
  PolicyResourcePicker: () => null,
}));

const { MainAgentCapabilitiesSection } =
  await import('./MainAgentCapabilitiesSection');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const FULL = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const CONFIGS: ModelConfigOption[] = [
  {
    id: 'official',
    name: 'Claude 官方',
    type: 'official',
    model: 'opus',
    usable: true,
    models: [
      {
        id: 'opus',
        efforts: [...FULL],
        defaultEffort: 'xhigh',
        contextWindow: 200_000,
        effortsSource: 'registry',
      },
      {
        id: 'sonnet',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
        contextWindow: 200_000,
        effortsSource: 'registry',
      },
      {
        id: 'haiku',
        efforts: [],
        defaultEffort: null,
        contextWindow: 200_000,
        // Declared to take none, unlike a model nothing is known about.
        effortsSource: 'declared',
      },
    ],
  },
  {
    id: 'glm',
    name: 'GLM',
    type: 'third_party',
    model: 'glm-5.3',
    usable: true,
    models: [
      {
        id: 'glm-5.3',
        efforts: [],
        defaultEffort: null,
        contextWindow: 1_000_000,
        effortsSource: 'none',
      },
      {
        id: 'glm-4.6',
        efforts: ['low', 'high'],
        defaultEffort: 'high',
        contextWindow: 128_000,
        effortsSource: 'family',
      },
    ],
  },
];

/** The caller is the system main HappyClaw's owner unless told otherwise. */
function inherited(overrides: Partial<InheritedModel> = {}): InheritedModel {
  return {
    owner_main: null,
    system_main: { model_config_id: 'official', model: 'opus', effort: null },
    system_main_profile_id: 'main',
    ...overrides,
  };
}

function mainProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'main',
    owner_user_id: 'admin',
    name: '主 HappyClaw',
    identity_prompt: '',
    soul_prompt: '',
    agents_prompt: '',
    tools_prompt: '',
    prompt_mode: 'append',
    include_claude_preset: true,
    avatar_emoji: null,
    avatar_color: null,
    avatar_url: null,
    model_config_id: null,
    model: null,
    runtime_policy: {
      reasoning: { effort: 'inherit' },
      context: {
        source: 'managed',
        auto_compact_window: 0,
        auto_compact_percentage: 0,
      },
      skills: { mode: 'inherit', ids: [], host: { mode: 'disabled', ids: [] } },
      mcp: { mode: 'inherit', ids: [] },
    },
    identity_hash: 'hash',
    version: 1,
    is_default: true,
    status: 'active',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function setStore(
  profile: AgentProfile,
  configs = CONFIGS,
  inheritedModel: InheritedModel | null = inherited(),
) {
  mocks.state = {
    profiles: [profile],
    modelConfigs: configs,
    inheritedModel,
    loading: false,
    loadProfiles: mocks.loadProfiles,
    // The store's update is what the section saves through.
    updateProfile: (id: string, data: unknown) =>
      mocks.patch(`/api/agent-profiles/${id}`, data),
    governanceByProfile: {},
    loadProfileGovernance: mocks.governance,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.patch.mockResolvedValue({});
  mocks.governance.mockResolvedValue({ workspaces: [], channel_mounts: [] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function render() {
  await act(async () => {
    root.render(<MainAgentCapabilitiesSection />);
  });
}

const configSelect = () => combobox('主 HappyClaw 模型连接');
const modelSelect = () => combobox('主 HappyClaw 模型');
const effortSelect = () => combobox('主 HappyClaw 推理等级');

async function optionsOf(select: HTMLButtonElement): Promise<string[]> {
  await act(async () => select.click());
  const texts = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].map((item) => item.textContent ?? '');
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  return texts;
}

const saveButton = () =>
  [...container.querySelectorAll('button')].find(
    (item) => item.textContent === '保存模型与能力',
  );

async function save() {
  const button = saveButton();
  if (!button) throw new Error('save button not rendered');
  await act(async () => button.click());
}

describe('the system main HappyClaw', () => {
  test('follows nothing: no 跟随 option, 未设置 while empty, with a hint', async () => {
    setStore(mainProfile());
    await render();
    expect(configSelect().textContent).toBe('未设置');
    expect(container.textContent).toContain('还没有选择模型连接');
    expect(await optionsOf(configSelect())).toEqual([
      'Claude 官方 · opus',
      'GLM · glm-5.3',
    ]);
    expect(modelSelect().disabled).toBe(true);
    // Nothing known to set an effort on: only the model default.
    expect(await optionsOf(effortSelect())).toEqual(['模型默认']);
  });

  test('a bound connection lists every model and drops the hint', async () => {
    setStore(mainProfile({ model_config_id: 'official', model: 'haiku' }));
    await render();
    expect(container.textContent).not.toContain('还没有选择模型连接');
    expect(modelSelect().textContent).toBe('haiku');
    expect(await optionsOf(modelSelect())).toEqual([
      '连接默认（opus）',
      'sonnet',
      'haiku',
    ]);
    expect(saveButton()?.disabled).toBe(true);
  });
});

describe('a user main Agent', () => {
  test('follows the system main HappyClaw, named with what it runs', async () => {
    setStore(
      mainProfile({ id: 'mine' }),
      CONFIGS,
      inherited({ system_main_profile_id: null }),
    );
    await render();
    expect(configSelect().textContent).toBe(
      '跟随主 HappyClaw（Claude 官方 · opus）',
    );
    expect(container.textContent).not.toContain('还没有选择模型连接');
    expect((await optionsOf(configSelect()))[0]).toBe(
      '跟随主 HappyClaw（Claude 官方 · opus）',
    );
    expect(modelSelect().disabled).toBe(true);
    // The followed model's efforts, after its default.
    expect(await optionsOf(effortSelect())).toEqual([
      '模型默认（超高）',
      '低',
      '中',
      '高',
      '超高',
      '最高',
    ]);
  });

  test('reads 未设置 inside the label while the system has no binding', async () => {
    setStore(
      mainProfile({ id: 'mine' }),
      CONFIGS,
      inherited({ system_main: null, system_main_profile_id: null }),
    );
    await render();
    expect(configSelect().textContent).toBe('跟随主 HappyClaw（未设置）');
  });
});

describe('主 HappyClaw model within its connection', () => {
  test('picking a connection, then a model, saves both', async () => {
    setStore(mainProfile());
    await render();
    await choose(configSelect(), 'GLM');
    expect(modelSelect().disabled).toBe(false);
    expect(await optionsOf(modelSelect())).toEqual([
      '连接默认（glm-5.3）',
      'glm-4.6',
    ]);
    await choose(modelSelect(), 'glm-4.6');
    await save();
    expect(mocks.patch).toHaveBeenCalledWith(
      '/api/agent-profiles/main',
      expect.objectContaining({ model_config_id: 'glm', model: 'glm-4.6' }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  test('switching the connection resets the model to its own', async () => {
    setStore(mainProfile({ model_config_id: 'official', model: 'sonnet' }));
    await render();
    expect(modelSelect().textContent).toContain('sonnet');
    await choose(configSelect(), 'GLM');
    expect(modelSelect().textContent).toContain('连接默认（glm-5.3）');
    await save();
    const body = mocks.patch.mock.calls[0][1];
    expect(body).toMatchObject({ model_config_id: 'glm', model: null });
  });

  test('the effort select lists only what the model takes', async () => {
    setStore(mainProfile({ model_config_id: 'official', model: 'sonnet' }));
    await render();
    expect(await optionsOf(effortSelect())).toEqual([
      '模型默认（高）',
      '低',
      '中',
      '高',
    ]);
    await choose(modelSelect(), 'haiku');
    expect(await optionsOf(effortSelect())).toEqual(['模型默认']);
  });

  test('a model without the picked effort returns it to the model default', async () => {
    setStore(
      mainProfile({
        model_config_id: 'official',
        model: 'opus',
        runtime_policy: {
          ...mainProfile().runtime_policy,
          reasoning: { effort: 'max' },
        },
      }),
    );
    await render();
    expect(effortSelect().textContent).toBe('最高');
    await choose(modelSelect(), 'sonnet');
    expect(effortSelect().textContent).toBe('模型默认（高）');
    // A level the next model takes is kept.
    await choose(effortSelect(), '中');
    await choose(modelSelect(), '连接默认（opus）');
    expect(effortSelect().textContent).toBe('中');
    await save();
    expect(mocks.patch.mock.calls[0][1]).toMatchObject({
      runtime_policy: { reasoning: { effort: 'medium' } },
    });
  });

  test('a saved level the model does not list stays visible as saved', async () => {
    setStore(
      mainProfile({
        model_config_id: 'official',
        model: 'haiku',
        runtime_policy: {
          ...mainProfile().runtime_policy,
          reasoning: { effort: 'high' },
        },
      }),
    );
    await render();
    expect(effortSelect().textContent).toBe('高（当前模型不支持）');
    expect(saveButton()?.disabled).toBe(true);
  });

  test('an unchanged model is not sent with another change', async () => {
    setStore(mainProfile({ model_config_id: 'official', model: 'sonnet' }));
    await render();
    await choose(effortSelect(), '中');
    await save();
    expect(mocks.patch.mock.calls[0][1]).not.toHaveProperty('model');
  });

  test('a model the connection no longer offers reads as such', async () => {
    setStore(mainProfile({ model_config_id: 'official' }));
    mocks.patch.mockRejectedValue({
      status: 400,
      message: 'Bad Request',
      body: { code: 'MODEL_NOT_IN_CONNECTION' },
    });
    await render();
    await choose(modelSelect(), 'sonnet');
    await save();
    expect(mocks.toastError).toHaveBeenCalledWith(
      '所选模型已不在该模型配置的模型列表里，请重新选择模型',
    );
  });

  test('saving only the connection leaves the stored host Skills alone', async () => {
    // An admin's main HappyClaw under host_claude runs with every host Skill.
    setStore(
      mainProfile({
        runtime_policy: {
          ...mainProfile().runtime_policy,
          skills: {
            mode: 'inherit',
            ids: [],
            host: { mode: 'inherit', ids: [] },
          },
        },
      }),
    );
    await render();
    await choose(configSelect(), 'GLM');
    await save();
    expect(mocks.patch.mock.calls[0][1]).toEqual({ model_config_id: 'glm' });
  });

  test('host Skills of an older server follow the effective context source', async () => {
    const legacy = mainProfile({ model_config_id: 'official' });
    delete legacy.runtime_policy.skills.host;
    setStore({
      ...legacy,
      effective_runtime_policy: {
        ...legacy.runtime_policy,
        context: { ...legacy.runtime_policy.context!, source: 'host_claude' },
      },
    });
    await render();
    await choose(effortSelect(), '中');
    await save();
    expect(mocks.patch.mock.calls[0][1]).toMatchObject({
      runtime_policy: {
        reasoning: { effort: 'medium' },
        skills: { host: { mode: 'inherit', ids: [] } },
      },
    });
  });

  test('asks before a save interrupts running conversations', async () => {
    setStore(mainProfile());
    mocks.governance.mockResolvedValue({
      workspaces: [
        { name: 'Home', active_conversations: 2 },
        { name: 'Idle', active_conversations: 0 },
      ],
      channel_mounts: [],
    });
    mocks.confirm.mockResolvedValueOnce(false);
    await render();
    await choose(configSelect(), 'GLM');
    await save();
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          '保存会中断 2 个正在进行的对话（「Home」2 个）',
        ),
      }),
    );
    expect(mocks.patch).not.toHaveBeenCalled();

    await save();
    expect(mocks.patch).toHaveBeenCalledOnce();
  });
});

describe('what a vendor says about its models', () => {
  /** The models of a magpie connection whose list names them. */
  const named: Array<
    ModelConfigOption['models'][number] & { displayName: string }
  > = [
    {
      id: 'acme/vx-pro',
      displayName: 'VX Pro',
      efforts: ['low', 'high'],
      defaultEffort: 'high',
      contextWindow: 200_000,
      effortsSource: 'declared',
    },
    {
      id: 'acme/vx-mini',
      displayName: 'VX Mini',
      efforts: [],
      defaultEffort: null,
      contextWindow: null,
      effortsSource: 'declared',
    },
  ];
  const MAGPIE: ModelConfigOption = {
    id: 'mp',
    name: 'Magpie',
    type: 'third_party',
    model: 'acme/vx-pro',
    usable: true,
    models: named,
  };

  test('the connection and model selects name models by the vendor’s name', async () => {
    setStore(mainProfile({ model_config_id: 'mp' }), [...CONFIGS, MAGPIE]);
    await render();
    expect(configSelect().textContent).toBe('Magpie · VX Pro');
    expect(await optionsOf(modelSelect())).toEqual([
      '连接默认（VX Pro）',
      'VX Mini',
    ]);
  });

  test('a model nothing is known about offers every level, unverified', async () => {
    // glm-5.3 is listed with nothing known about its efforts.
    setStore(mainProfile({ model_config_id: 'glm', model: 'glm-5.3' }));
    await render();
    expect(await optionsOf(effortSelect())).toEqual([
      '模型默认',
      '低',
      '中',
      '高',
      '超高',
      '最高',
    ]);
    expect(container.textContent).toContain('未验证：没有这个模型的资料');
    await choose(effortSelect(), '超高');
    await save();
    expect(mocks.patch.mock.calls[0][1]).toMatchObject({
      runtime_policy: { reasoning: { effort: 'xhigh' } },
    });
  });

  test('a model declared to take none offers no level and says so', async () => {
    setStore(mainProfile({ model_config_id: 'mp', model: 'acme/vx-mini' }), [
      ...CONFIGS,
      MAGPIE,
    ]);
    await render();
    expect(await optionsOf(effortSelect())).toEqual(['模型默认']);
    expect(container.textContent).toContain('这个模型不支持推理等级');
    expect(container.textContent).not.toContain('未验证');
  });

  test('moving to an unknown model keeps the picked level', async () => {
    setStore(
      mainProfile({
        model_config_id: 'glm',
        model: 'glm-4.6',
        runtime_policy: {
          ...mainProfile().runtime_policy,
          reasoning: { effort: 'low' },
        },
      }),
    );
    await render();
    await choose(modelSelect(), '连接默认（glm-5.3）');
    expect(effortSelect().textContent).toBe('低');
  });
});
