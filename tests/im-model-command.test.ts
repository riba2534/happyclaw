/**
 * IM `/model` against a real database and a fixed set of saved connections:
 * what it shows, how a numbered or named pick is checked and saved (the
 * workspace owner chooses), and that a refusal changes nothing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-im-model-'));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: root,
    GROUPS_DIR: path.join(root, 'groups'),
    STORE_DIR: path.join(root, 'db'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const BIG_MODELS = Array.from({ length: 25 }, (_, index) => ({
  id: `big-${index + 1}`,
}));

vi.mock('../src/runtime-config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    getContainerEnvConfig: () => ({}),
    getProviders: () => [
      {
        id: 'official',
        name: 'Claude 官方',
        type: 'official',
        enabled: true,
        anthropicModel: 'opus',
        anthropicApiKey: 'sk-ant-key',
        codexOAuthCredentials: null,
      },
      {
        id: 'glm',
        name: 'GLM',
        type: 'third_party',
        enabled: true,
        anthropicBaseUrl: 'https://glm.example.test',
        anthropicModel: 'glm-5.3',
        anthropicAuthToken: 'glm-token',
        models: [
          { id: 'glm-5.3', contextWindow: 1_000_000 },
          { id: 'glm-5.3-air' },
        ],
        codexOAuthCredentials: null,
      },
      {
        id: 'relay',
        name: '中转',
        type: 'third_party',
        enabled: true,
        anthropicBaseUrl: 'https://relay.example.test',
        anthropicModel: 'glm-5.3',
        anthropicAuthToken: 'relay-token',
        models: [
          { id: 'glm-5.3' },
          // Names the vendor gives; the last word of one reads like an effort.
          { id: 'kimi-k3', displayName: 'Kimi K3' },
          { id: 'kimi-k3-max', displayName: 'Kimi K3 max' },
        ],
        codexOAuthCredentials: null,
      },
      {
        id: 'copy',
        name: 'GLM (副本)',
        type: 'third_party',
        enabled: true,
        anthropicBaseUrl: 'https://glm.example.test',
        anthropicModel: 'glm-5.3',
        anthropicAuthToken: '',
        models: [{ id: 'glm-5.3' }],
        codexOAuthCredentials: null,
      },
      {
        id: 'big',
        name: 'Big',
        type: 'third_party',
        enabled: true,
        anthropicBaseUrl: 'https://big.example.test',
        anthropicModel: 'big-1',
        anthropicAuthToken: 'big-token',
        models: BIG_MODELS,
        codexOAuthCredentials: null,
      },
    ],
  };
});

const db = await import('../src/db.js');
const { runModelCommand, MODEL_COMMAND_PAGE_SIZE } =
  await import('../src/im-model-command.js');

const OWNER = 'im-model-owner';
const WORKSPACE = 'web:im-model-ws';
const FOLDER = 'im-model-ws';
const SESSION = 'im-model-session';

let drains: Array<{ jids: readonly string[]; target: string | null }> = [];

function run(args: string): string {
  return runModelCommand({
    args,
    workspace: db.getRegisteredGroup(WORKSPACE)!,
    workspaceJid: WORKSPACE,
    agentId: SESSION,
    chooser: db.getUserById(OWNER)!,
    runners: {
      drainRunnersForModelSelection: (jids, target) => {
        drains.push({ jids, target });
        return 1;
      },
    },
  });
}

const stored = () => db.getSessionModelSelectionDetail(FOLDER, SESSION);

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: OWNER,
    username: OWNER,
    password_hash: 'test-only',
    display_name: OWNER,
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
  db.setRegisteredGroup(WORKSPACE, {
    name: 'IM model',
    folder: FOLDER,
    added_at: now,
    executionMode: 'container',
    created_by: OWNER,
    is_home: false,
  } as never);
  db.createAgent({
    id: SESSION,
    group_folder: FOLDER,
    chat_jid: WORKSPACE,
    name: 'Bound',
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: OWNER,
    created_at: now,
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  } as never);
  const main = db.getOrCreateDefaultAgentProfile(OWNER);
  db.updateAgentProfile(main.id, OWNER, { modelConfigId: 'glm', model: null });
});

beforeEach(() => {
  drains = [];
  db.setSessionModelSelection(FOLDER, SESSION, null);
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('/model shows', () => {
  test('the model in use, where it comes from, and the numbered connections', () => {
    const reply = run('');
    expect(reply.split('\n')).toEqual([
      expect.stringMatching(/^当前模型：GLM · glm-5\.3 · 档位 high（跟随/),
      '连接：',
      '1. Claude 官方',
      '2. GLM（当前）',
      '3. 中转',
      '4. GLM (副本)（缺少凭据）',
      '5. Big',
      expect.stringContaining('/model <编号>.<模型编号> [档位] 切换'),
    ]);
  });

  test('a session pick as its own choice', () => {
    db.setSessionModelSelection(FOLDER, SESSION, 'relay', OWNER, {
      model: 'kimi-k3',
    });
    const reply = run('');
    expect(reply).toContain('当前模型：中转 · kimi-k3（本会话选择）');
    expect(reply).toContain('3. 中转（当前）');
  });

  test("a connection's numbered models, paged", () => {
    expect(run('2').split('\n')).toEqual([
      'GLM 的模型：',
      '1. glm-5.3 · 档位 low/high/max（当前）',
      // Nothing is known about its efforts.
      '2. glm-5.3-air · 档位未验证',
      '发送 /model 2.<编号> [档位] 切换。',
    ]);
    const first = run('5').split('\n');
    expect(first[0]).toBe('Big 的模型（第 1/2 页）：');
    expect(first).toHaveLength(MODEL_COMMAND_PAGE_SIZE + 2);
    expect(first.at(-1)).toContain('/model 5 2 看下一页');
    const second = run('5 2').split('\n');
    expect(second[0]).toBe('Big 的模型（第 2/2 页）：');
    expect(second[1]).toBe('21. big-21 · 档位未验证');
    expect(run('5 3')).toBe('Big 的模型只有 2 页。');
    expect(run('9')).toBe('没有编号为 9 的连接，发送 /model 查看列表。');
  });
});

describe('/model picks', () => {
  test('by number, with an effort, as the owner, retiring the runner', () => {
    expect(run('2.1 max')).toBe(
      '已切换到 GLM · glm-5.3 · 档位 max，下一条消息起生效。',
    );
    expect(stored()).toEqual({
      modelConfigId: 'glm',
      model: 'glm-5.3',
      effort: 'max',
      updatedBy: OWNER,
    });
    expect(drains).toEqual([
      { jids: [`${WORKSPACE}#agent:${SESSION}`], target: null },
    ]);
  });

  test('by a unique model name, case-insensitively', () => {
    expect(run('KIMI-K3')).toBe('已切换到 中转 · kimi-k3，下一条消息起生效。');
    expect(stored()).toMatchObject({
      modelConfigId: 'relay',
      model: 'kimi-k3',
    });
    // The last word is an effort when the rest names a model.
    expect(run('opus high')).toBe(
      '已切换到 Claude 官方 · opus · 档位 high，下一条消息起生效。',
    );
    expect(stored()).toMatchObject({
      modelConfigId: 'official',
      effort: 'high',
    });
  });

  test("by the vendor's name, whose last word may read like an effort", () => {
    expect(run('3').split('\n').slice(1, 4)).toEqual([
      '1. glm-5.3 · 档位 low/high/max',
      '2. Kimi K3（kimi-k3） · 档位 low/high/max',
      '3. Kimi K3 max（kimi-k3-max） · 档位未验证',
    ]);
    expect(run('kimi k3 max')).toBe(
      '已切换到 中转 · kimi-k3-max，下一条消息起生效。',
    );
    expect(stored()).toMatchObject({ model: 'kimi-k3-max', effort: null });
    // Otherwise a trailing word after a name is its effort.
    expect(run('Kimi K3 high')).toBe(
      '已切换到 中转 · kimi-k3 · 档位 high，下一条消息起生效。',
    );
    expect(stored()).toMatchObject({ model: 'kimi-k3', effort: 'high' });
  });

  test('a name several connections offer asks for the number', () => {
    expect(run('glm-5.3').split('\n')).toEqual([
      '多个连接都有这个模型，请用编号选择：',
      '/model 2.1 → GLM · glm-5.3',
      '/model 3.1 → 中转 · glm-5.3',
      '/model 4.1 → GLM (副本) · glm-5.3',
    ]);
    expect(stored()).toBeNull();
  });

  test('default clears the pick', () => {
    run('2.2');
    expect(run('default')).toMatch(/^已恢复默认：GLM · glm-5\.3/);
    expect(stored()).toBeNull();
  });

  test('a refused pick says why and changes nothing', () => {
    run('3.2');
    drains = [];
    expect(run('2.1 medium')).toBe('⚠️ 模型 glm-5.3 不支持推理档位 medium');
    expect(run('4.1')).toMatch(/^⚠️ 该模型配置缺少凭据/);
    expect(run('2.9')).toBe(
      'GLM 没有编号为 9 的模型，发送 /model 2 查看列表。',
    );
    expect(run('nothing-like-it')).toBe(
      '没有找到模型 nothing-like-it，发送 /model 查看连接和模型。',
    );
    expect(stored()).toMatchObject({
      modelConfigId: 'relay',
      model: 'kimi-k3',
    });
    expect(drains).toEqual([]);
  });
});
