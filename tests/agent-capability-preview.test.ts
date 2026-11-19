import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-preview-'));
const dataDir = path.join(root, 'data');
const groupsDir = path.join(dataDir, 'groups');
const externalDir = path.join(root, '.claude');
const pluginMcpPath = path.join(
  dataDir,
  'plugins',
  'runtime',
  'owner',
  'snapshots',
  'snapshot-a',
  'market',
  'search-plugin',
  '.mcp.json',
);

vi.mock('../src/config.js', () => ({
  DATA_DIR: dataDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/runtime-config.js', () => ({
  getEffectiveExternalDir: () => externalDir,
}));

const { buildAgentCapabilityPreview } =
  await import('../src/agent-capability-preview.js');

function writeSkill(dir: string, id: string): void {
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.writeFileSync(path.join(dir, id, 'SKILL.md'), `---\nname: ${id}\n---\n`);
}

function writeDisabledSkill(dir: string, id: string): void {
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.writeFileSync(
    path.join(dir, id, 'SKILL.md.disabled'),
    `---\nname: ${id}\n---\n`,
  );
}

beforeAll(() => {
  fs.mkdirSync(path.dirname(pluginMcpPath), { recursive: true });
  fs.mkdirSync(path.join(path.dirname(pluginMcpPath), '.claude-plugin'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(path.dirname(pluginMcpPath), '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'search-plugin' }),
  );
  fs.writeFileSync(
    pluginMcpPath,
    JSON.stringify({ search: { command: 'plugin-search-v1' } }),
  );
  fs.mkdirSync(path.join(dataDir, 'plugins', 'users', 'owner'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dataDir, 'plugins', 'users', 'owner', 'plugins.json'),
    JSON.stringify({
      schemaVersion: 1,
      enabled: {
        'search-plugin@market': {
          enabled: true,
          marketplace: 'market',
          plugin: 'search-plugin',
          snapshot: 'snapshot-a',
          enabledAt: '2026-07-21T00:00:00.000Z',
        },
      },
    }),
  );
  writeSkill(path.join(externalDir, 'skills'), 'shared');
  writeSkill(path.join(externalDir, 'skills'), 'disabled-collision');
  writeSkill(path.join(dataDir, 'skills', 'owner'), 'shared');
  writeSkill(path.join(dataDir, 'skills', 'owner'), 'managed-only');
  writeDisabledSkill(
    path.join(dataDir, 'skills', 'owner'),
    'disabled-collision',
  );
  writeSkill(path.join(groupsDir, 'workspace', '.claude', 'skills'), 'shared');
  fs.mkdirSync(path.join(externalDir, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(externalDir, 'CLAUDE.md'), '# host');
  fs.writeFileSync(path.join(externalDir, 'rules', 'rule.md'), '# rule');
  fs.mkdirSync(path.join(externalDir, 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(externalDir, 'agents', 'researcher.md'),
    '# agent',
  );
  fs.writeFileSync(path.join(externalDir, 'keybindings.json'), '{}');
  fs.writeFileSync(
    path.join(externalDir, 'settings.json'),
    JSON.stringify({ mcpServers: { shared: { command: 'host' } } }),
  );
  fs.mkdirSync(path.join(groupsDir, 'workspace', '.claude'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(groupsDir, 'workspace', '.mcp.json'),
    JSON.stringify({ mcpServers: { project: { command: 'project' } } }),
  );
  fs.mkdirSync(path.join(dataDir, 'mcp-servers', 'owner'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'mcp-servers', 'owner', 'servers.json'),
    JSON.stringify({
      servers: {
        shared: { enabled: true, command: 'managed' },
        managed: { enabled: true, command: 'managed' },
      },
    }),
  );
  fs.mkdirSync(path.join(dataDir, 'mcp-servers', 'system'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dataDir, 'mcp-servers', 'system', 'servers.json'),
    JSON.stringify({
      servers: {
        shared: {
          enabled: true,
          command: 'system-shared',
          memberAccess: 'shared',
        },
        platform: {
          enabled: true,
          command: 'system-platform',
          memberAccess: 'admin_only',
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(dataDir, 'mcp-servers', 'system', 'secrets.json'),
    JSON.stringify({
      servers: { platform: { env: { SYSTEM_TOKEN: 'preview-secret' } } },
    }),
  );
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('buildAgentCapabilityPreview', () => {
  test('inherit discovers a host Skill added after the profile was configured', () => {
    const profile = {
      id: 'future-host-skills-profile',
      owner_user_id: 'owner',
      name: 'Future Host Skills',
      identity_prompt: '',
      soul_prompt: '',
      agents_prompt: '',
      tools_prompt: '',
      prompt_mode: 'append' as const,
      include_claude_preset: true,
      avatar_emoji: null,
      avatar_color: null,
      avatar_url: null,
      identity_hash: 'hash',
      version: 1,
      is_default: false,
      status: 'active' as const,
      created_at: '',
      updated_at: '',
      runtime_policy: {
        context: {
          source: 'managed' as const,
          auto_compact_window: 0,
          auto_compact_percentage: 0,
        },
        skills: {
          mode: 'disabled' as const,
          ids: [],
          host: { mode: 'inherit' as const, ids: [] },
        },
        mcp: { mode: 'disabled' as const, ids: [] },
      },
    };
    const before = buildAgentCapabilityPreview({
      profile,
      ownerRole: 'admin',
    });
    expect(
      before.skills.entries.some((entry) => entry.id === 'added-later'),
    ).toBe(false);

    writeSkill(path.join(externalDir, 'skills'), 'added-later');
    try {
      const after = buildAgentCapabilityPreview({
        profile,
        ownerRole: 'admin',
      });
      expect(after.skills.entries).toContainEqual(
        expect.objectContaining({
          id: 'added-later',
          source: 'host',
        }),
      );
    } finally {
      fs.rmSync(path.join(externalDir, 'skills', 'added-later'), {
        recursive: true,
        force: true,
      });
    }
  });

  test('returns a complete preview when all host Skills are inherited independently', () => {
    const preview = buildAgentCapabilityPreview({
      profile: {
        id: 'all-host-skills-profile',
        owner_user_id: 'owner',
        name: 'All Host Skills',
        identity_prompt: '',
        include_claude_preset: true,
        avatar_emoji: null,
        avatar_color: null,
        avatar_url: null,
        identity_hash: 'hash',
        version: 1,
        is_default: false,
        status: 'active',
        created_at: '',
        updated_at: '',
        runtime_policy: {
          context: {
            source: 'managed',
            auto_compact_window: 0,
            auto_compact_percentage: 0,
          },
          skills: {
            mode: 'inherit',
            ids: [],
            host: {
              mode: 'inherit',
              // A previous custom selection may remain for audit after the
              // mode changes. Inherit must ignore that list and stay renderable.
              ids: ['shared'],
            },
          },
          mcp: { mode: 'inherit', ids: [] },
        },
      },
      ownerRole: 'admin',
    });

    expect(preview.skills.host).toEqual({
      mode: 'inherit',
      ids: ['shared'],
    });
    expect(preview.skills.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'shared',
          source: 'managed',
          overrides: ['host'],
        }),
        expect.objectContaining({
          id: 'disabled-collision',
          source: 'host',
          overrides: [],
        }),
      ]),
    );
    for (const entry of preview.skills.entries) {
      expect(typeof entry.id).toBe('string');
      expect(Array.isArray(entry.overrides)).toBe(true);
    }
    expect(Array.isArray(preview.skills.conflicts)).toBe(true);
    expect(Array.isArray(preview.notes)).toBe(true);
  });

  test('shows additive layers, overrides and host context', () => {
    const preview = buildAgentCapabilityPreview({
      profile: {
        id: 'profile',
        owner_user_id: 'owner',
        name: 'Agent',
        identity_prompt: '',
        include_claude_preset: true,
        avatar_emoji: null,
        avatar_color: null,
        avatar_url: null,
        identity_hash: 'hash',
        version: 1,
        is_default: false,
        status: 'active',
        created_at: '',
        updated_at: '',
        runtime_policy: {
          context: {
            source: 'host_claude',
            auto_compact_window: 0,
            auto_compact_percentage: 0,
          },
          skills: { mode: 'inherit', ids: [] },
          mcp: { mode: 'inherit', ids: [] },
        },
      },
      workspace: {
        jid: 'web:workspace',
        group: {
          name: 'Workspace',
          folder: 'workspace',
          added_at: '',
          created_by: 'owner',
        },
      },
    });

    expect(preview.context).toEqual({
      source: 'host_claude',
      claudeMd: true,
      rules: 1,
      nativeConfig: {
        settingsFiles: ['settings.json'],
        entries: [
          { name: 'agents', kind: 'directory', entryCount: 1 },
          { name: 'keybindings.json', kind: 'file' },
        ],
      },
    });
    expect(preview.skills.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'managed-only', source: 'managed' }),
        expect.objectContaining({
          id: 'disabled-collision',
          source: 'host',
        }),
        expect.objectContaining({
          id: 'shared',
          source: 'workspace',
          overrides: ['host', 'managed'],
        }),
      ]),
    );
    expect(preview.skills.conflicts).toContain('shared');
    expect(preview.mcp.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'shared',
          source: 'user',
          overrides: ['host', 'system'],
          available: true,
        }),
        expect.objectContaining({ id: 'platform', source: 'system' }),
        expect.objectContaining({
          id: 'project',
          source: 'workspace',
          available: true,
        }),
        expect.objectContaining({
          id: 'plugin:market/search-plugin:search',
          source: 'plugin',
          available: true,
        }),
      ]),
    );
  });

  test('marks an inherited plugin MCP definition change as a new manifest', () => {
    const profile = {
      id: 'plugin-mcp-profile',
      owner_user_id: 'owner',
      name: 'Plugin MCP Agent',
      identity_prompt: '',
      include_claude_preset: true,
      avatar_emoji: null,
      avatar_color: null,
      avatar_url: null,
      identity_hash: 'hash',
      version: 1,
      is_default: false,
      status: 'active' as const,
      created_at: '',
      updated_at: '',
      runtime_policy: {
        context: {
          source: 'managed' as const,
          auto_compact_window: 0,
          auto_compact_percentage: 0,
        },
        skills: { mode: 'inherit' as const, ids: [] },
        mcp: { mode: 'inherit' as const, ids: [] },
      },
    };
    const first = buildAgentCapabilityPreview({ profile, ownerRole: 'admin' });
    try {
      fs.writeFileSync(
        pluginMcpPath,
        JSON.stringify({ search: { command: 'plugin-search-v2' } }),
      );
      const changed = buildAgentCapabilityPreview({
        profile,
        ownerRole: 'admin',
      });
      expect(changed.mcp.manifestHash).not.toBe(first.mcp.manifestHash);
    } finally {
      fs.writeFileSync(
        pluginMcpPath,
        JSON.stringify({ search: { command: 'plugin-search-v1' } }),
      );
    }
  });

  test('marks admin-only system MCP unavailable to members and available to admins', () => {
    const profile = {
      id: 'credential-preview-profile',
      owner_user_id: 'owner',
      name: 'Credential Preview Agent',
      identity_prompt: '',
      include_claude_preset: true,
      avatar_emoji: null,
      avatar_color: null,
      avatar_url: null,
      identity_hash: 'hash',
      version: 1,
      is_default: false,
      status: 'active' as const,
      created_at: '',
      updated_at: '',
      runtime_policy: {
        context: {
          source: 'managed' as const,
          auto_compact_window: 0,
          auto_compact_percentage: 0,
        },
        skills: { mode: 'inherit' as const, ids: [] },
        mcp: { mode: 'inherit' as const, ids: [] },
      },
    };

    const memberPreview = buildAgentCapabilityPreview({
      profile,
      ownerRole: 'member',
    });
    expect(memberPreview.mcp.entries).toContainEqual(
      expect.objectContaining({
        id: 'platform',
        source: 'system',
        available: false,
        unavailableReason: 'system_admin_only',
      }),
    );
    expect(memberPreview.notes).toContain(
      '有 1 个系统 MCP 仅限管理员，普通成员智能体不会继承。',
    );

    const adminPreview = buildAgentCapabilityPreview({
      profile,
      ownerRole: 'admin',
    });
    expect(adminPreview.mcp.entries).toContainEqual(
      expect.objectContaining({
        id: 'platform',
        source: 'system',
        available: true,
      }),
    );
  });
});

describe('sub-agents in the preview', () => {
  const profileWith = (subagents?: unknown) => ({
    id: 'subagent-profile',
    owner_user_id: 'owner',
    name: 'Sub-agents',
    identity_prompt: '',
    soul_prompt: '',
    agents_prompt: '',
    tools_prompt: '',
    prompt_mode: 'append' as const,
    include_claude_preset: true,
    avatar_emoji: null,
    avatar_color: null,
    avatar_url: null,
    identity_hash: 'hash',
    version: 1,
    is_default: false,
    status: 'active' as const,
    created_at: '',
    updated_at: '',
    runtime_policy: {
      context: {
        source: 'managed' as const,
        auto_compact_window: 0,
        auto_compact_percentage: 0,
      },
      skills: { mode: 'disabled' as const, ids: [] },
      mcp: { mode: 'disabled' as const, ids: [] },
      ...(subagents ? { subagents: subagents as never } : {}),
    },
  });
  const definition = {
    name: 'reviewer',
    description: 'Reviews diffs',
    prompt: 'Review.',
    tools: ['Read', 'CronCreate', 'Bash(git log:*)'],
    model: 'fast',
    effort: 'high' as const,
  };
  const policy = {
    model: 'fast',
    max_concurrent: 3,
    definitions: [definition, { ...definition, name: 'stale', model: 'gone' }],
  };

  test('an Agent without sub-agent settings previews as before', () => {
    const preview = buildAgentCapabilityPreview({ profile: profileWith() });
    expect(preview.subagents).toBeNull();
    expect(preview.notes.join('\n')).not.toContain('子代理');
  });

  test('shows what a run on the Agent’s connection gives its sub-agents', () => {
    const preview = buildAgentCapabilityPreview({
      profile: profileWith(policy),
      subagentRun: {
        onAgentConnection: true,
        launch: {
          defaultModel: 'fast',
          maxConcurrent: 3,
          agents: {
            reviewer: {
              description: 'Reviews diffs',
              prompt: 'Review.',
              tools: ['Read', 'Bash(git log:*)'],
              model: 'fast',
              effort: 'high',
            },
            stale: {
              description: 'Reviews diffs',
              prompt: 'Review.',
              tools: ['Read', 'Bash(git log:*)'],
            },
          },
        },
        defaultModel: { model: 'fast', source: 'agent' },
      },
    });
    expect(preview.subagents).toEqual({
      maxConcurrent: 3,
      defaultModel: 'fast',
      defaultModelSource: 'agent',
      definitions: [
        {
          name: 'reviewer',
          tools: ['Read', 'Bash(git log:*)'],
          model: 'fast',
          effort: 'high',
        },
        {
          name: 'stale',
          tools: ['Read', 'Bash(git log:*)'],
          model: null,
          effort: null,
        },
      ],
    });
    const notes = preview.notes.join('\n');
    expect(notes).toContain('CronCreate');
    expect(notes).toContain('子代理模型 gone 已不在智能体的模型连接中');
    expect(notes).toContain('会话手动选择其他模型连接时');
  });

  test('without a connection no model name applies; the rest still does', () => {
    const preview = buildAgentCapabilityPreview({
      profile: profileWith(policy),
    });
    expect(preview.subagents).toMatchObject({
      maxConcurrent: 3,
      defaultModel: null,
      defaultModelSource: null,
      definitions: [
        { name: 'reviewer', model: null, effort: 'high' },
        { name: 'stale', model: null, effort: 'high' },
      ],
    });
    expect(preview.notes.join('\n')).toContain(
      '本次运行不在智能体自己的模型连接上',
    );
  });
});
