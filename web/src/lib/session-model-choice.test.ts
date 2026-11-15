import { afterEach, describe, expect, test, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ api: { get } }));

const {
  describeDefaultChoice,
  describeModelChoice,
  forgetWorkspaceModelOptions,
  loadWorkspaceModelOptions,
} = await import('./session-model-choice');

type Options = Parameters<typeof describeDefaultChoice>[0];

const glm = {
  id: 'glm',
  name: 'GLM',
  kind: 'third_party' as const,
  model: 'glm-5.3',
  usable: true,
  models: [{ id: 'glm-5.3', efforts: ['high'], defaultEffort: 'high' }],
};
const chatgpt = {
  id: 'gpt',
  name: 'ChatGPT',
  kind: 'codex' as const,
  model: '',
  usable: true,
  codex: {
    defaultModel: 'gpt-5.5',
    defaultEffort: 'medium',
    needsReauth: false,
    models: [{ value: 'gpt-5.5', label: 'GPT-5.5', efforts: ['medium'] }],
  },
};

function options(
  defaults: Partial<Options['default']>,
  connections: Options['options'] = [glm, chatgpt],
): Options {
  return {
    default: { source: 'agent', modelConfigId: 'glm', ...defaults },
    options: connections,
  };
}

afterEach(() => {
  get.mockReset();
  forgetWorkspaceModelOptions();
});

describe('what following the default runs', () => {
  test.each([
    [options({ model: 'glm-5.3', effort: 'high' }), 'GLM · glm-5.3 · 高'],
    [options({ model: null }), 'GLM'],
    // A ChatGPT connection is named by its model.
    [options({ modelConfigId: 'gpt', model: 'gpt-5.5' }), 'GPT-5.5'],
    [
      options({ connectionMissing: true }),
      '连接不可用，绑定的连接已删除或缺少凭据',
    ],
    [
      options({ source: 'workspace_env', modelConfigId: null }),
      '使用工作区自带的 Provider 环境变量',
    ],
    [
      options({ source: 'none', modelConfigId: null }),
      '未选择模型，运行会失败；请选择连接',
    ],
    [
      options({ source: 'none', modelConfigId: null }, []),
      '还没有可用的模型，运行会失败',
    ],
  ])('%#', (given, expected) => {
    expect(describeDefaultChoice(given)).toBe(expected);
  });
});

describe('a choice in a line', () => {
  test('names the connection, the model and the effort', () => {
    const all = options({});
    expect(
      describeModelChoice(
        { modelConfigId: 'gpt', model: 'gpt-5.5', effort: 'medium' },
        all,
      ),
    ).toBe('ChatGPT · GPT-5.5 · 中');
    expect(
      describeModelChoice(
        { modelConfigId: 'glm', model: null, effort: null },
        all,
      ),
    ).toBe('GLM · 连接默认模型');
    // A connection gone from the options, or options not read: the ids.
    expect(
      describeModelChoice(
        { modelConfigId: 'old', model: 'm-1', effort: null },
        all,
      ),
    ).toBe('old · m-1');
    expect(
      describeModelChoice(
        { modelConfigId: 'glm', model: 'glm-5.3', effort: 'high' },
        null,
      ),
    ).toBe('glm · glm-5.3 · 高');
  });
});

describe('loading the options', () => {
  test('one request per workspace; a refresh asks again; a failure is not kept', async () => {
    get.mockResolvedValue(options({}));
    await Promise.all([
      loadWorkspaceModelOptions('web:a'),
      loadWorkspaceModelOptions('web:a'),
    ]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/api/groups/web%3Aa/model-options');
    await loadWorkspaceModelOptions('web:a', { refresh: true });
    expect(get).toHaveBeenCalledTimes(2);

    get.mockRejectedValueOnce({ status: 403, message: 'Forbidden' });
    await expect(loadWorkspaceModelOptions('web:b')).rejects.toMatchObject({
      status: 403,
    });
    await loadWorkspaceModelOptions('web:b');
    expect(get).toHaveBeenCalledTimes(4);
  });

  test('signing in or out forgets them', async () => {
    const { resetUserScopedStores } = await import('../stores/user-scope');
    get.mockResolvedValue(options({}));
    await loadWorkspaceModelOptions('web:a');
    resetUserScopedStores();
    await loadWorkspaceModelOptions('web:a');
    expect(get).toHaveBeenCalledTimes(2);
  });

  test('an answer without options reads as one with none', async () => {
    get.mockResolvedValue({});
    await expect(loadWorkspaceModelOptions('web:a')).resolves.toEqual({
      default: { source: 'none', modelConfigId: null },
      options: [],
    });
  });
});
