import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-agent-profiles-'));
const tmpDataDir = path.join(tmpDir, 'data');
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
  DATA_DIR: tmpDataDir,
  ASSISTANT_NAME: 'HappyClaw Test',
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/agent-profile-generator.js', () => ({
  generateAgentProfileDraft: vi.fn(async (description: string) => ({
    name: description.includes('评审') ? '代码评审 Agent' : 'AI Agent',
    identity_prompt: `根据描述生成：${description}`,
  })),
  refineAgentProfilePrompt: vi.fn(
    async ({
      currentPrompt,
      message,
    }: {
      currentPrompt: string;
      message: string;
    }) => ({
      reply: `已按要求调整：${message}`,
      identity_prompt: `${currentPrompt}\n新增要求：${message}`.trim(),
    }),
  ),
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'routes-agent-user',
      username: 'routes-agent-user',
      role: c.req.header('x-test-role') === 'admin' ? 'admin' : 'member',
      permissions: [],
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const runtimeConfig = await import('../src/runtime-config.js');
const webContext = await import('../src/web-context.js');
const agentProfileRuntime = await import('../src/agent-profile-runtime.js');
const routeModule = await import('../src/routes/agent-profiles.js');
const routes = routeModule.default;

beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'routes-agent-user',
    username: 'routes-agent-user',
    password_hash: 'hash',
    display_name: 'Routes Agent User',
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
  const skillDir = path.join(
    tmpDataDir,
    'skills',
    'routes-agent-user',
    'research',
  );
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: Research\ndescription: Test research skill\n---\n',
  );
  const mcpDir = path.join(tmpDataDir, 'mcp-servers', 'routes-agent-user');
  fs.mkdirSync(mcpDir, { recursive: true });
  fs.writeFileSync(
    path.join(mcpDir, 'servers.json'),
    JSON.stringify({
      servers: {
        github: {
          command: 'node',
          args: ['github-mcp.js'],
          enabled: true,
          addedAt: '2026-07-10T00:00:00.000Z',
        },
      },
    }),
  );
  const systemMcpDir = path.join(tmpDataDir, 'mcp-servers', 'system');
  fs.mkdirSync(systemMcpDir, { recursive: true });
  fs.writeFileSync(
    path.join(systemMcpDir, 'servers.json'),
    JSON.stringify({
      servers: {
        platform: {
          command: 'platform-mcp',
          enabled: true,
          memberAccess: 'shared',
          addedAt: '2026-07-10T00:00:00.000Z',
        },
        vault: {
          command: 'vault-mcp',
          enabled: true,
          memberAccess: 'admin_only',
          addedAt: '2026-07-10T00:00:00.000Z',
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(systemMcpDir, 'secrets.json'),
    JSON.stringify({
      servers: { vault: { env: { SYSTEM_TOKEN: 'system-secret' } } },
    }),
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('/api/agent-profiles routes', () => {
  test('GET returns the default AgentProfile', async () => {
    const res = await routes.request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0].is_default).toBe(true);
    expect(body.profiles[0].runtime_policy.reasoning).toEqual({
      effort: 'inherit',
    });
    expect(body.profiles[0].runtime_policy.context).toEqual({
      source: 'managed',
      auto_compact_window: 0,
      auto_compact_percentage: 0,
    });
    expect(body.profiles[0].effective_runtime_policy).toEqual(
      body.profiles[0].runtime_policy,
    );
  });

  test('lists model configurations and persists an Agent selection', async () => {
    const automaticModel = runtimeConfig.createProvider({
      name: 'Automatic model config',
      type: 'official',
      anthropicApiKey: 'default-test-key',
      anthropicModel: 'claude-default-test',
      enabled: true,
    });
    const selectedModel = runtimeConfig.createProvider({
      name: 'Research model config',
      type: 'third_party',
      anthropicBaseUrl: 'https://models.example.test',
      anthropicAuthToken: 'research-test-token',
      anthropicModel: 'research-model',
      enabled: false,
    });
    const listRes = await routes.request('/', { method: 'GET' });
    const listBody = await listRes.json();
    expect(listBody).not.toHaveProperty('default_model_config_id');
    // Every connection, with no enable switch or default mark.
    expect(listBody.model_configs).toEqual(
      expect.arrayContaining([
        {
          id: automaticModel.id,
          name: 'Automatic model config',
          type: 'official',
          model: 'claude-default-test',
          usable: true,
          models: [
            {
              id: 'claude-default-test',
              displayName: null,
              efforts: [],
              defaultEffort: null,
              contextWindow: null,
              effortsSource: 'none',
              maxOutputTokens: null,
              vendor: null,
              upstreamMissingSince: null,
            },
          ],
        },
        expect.objectContaining({
          id: selectedModel.id,
          name: 'Research model config',
          model: 'research-model',
          usable: true,
        }),
      ]),
    );
    // Nothing is bound yet: no main Agent hands anything down.
    expect(listBody.inherited_model).toEqual({
      owner_main: null,
      system_main: null,
      system_main_profile_id: null,
    });

    const createRes = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Pinned Research Agent',
        model_config_id: selectedModel.id,
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()).profile;
    expect(created.model_config_id).toBe(selectedModel.id);

    const inheritRes = await routes.request(`/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model_config_id: null }),
    });
    expect(inheritRes.status).toBe(200);
    expect((await inheritRes.json()).profile).toMatchObject({
      model_config_id: null,
      version: created.version + 1,
    });

    const invalidRes = await routes.request(`/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model_config_id: 'missing-model-config' }),
    });
    expect(invalidRes.status).toBe(400);
  });

  test('POST creates and PATCH updates an AgentProfile', async () => {
    const createdRes = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Research',
        identity_prompt: '用研究员方式回答。',
        include_claude_preset: false,
        runtime_policy: {
          skills: { mode: 'custom', ids: ['research'] },
          mcp: { mode: 'inherit', ids: [] },
        },
      }),
    });
    expect(createdRes.status).toBe(201);
    const createdBody = await createdRes.json();
    const created = createdBody.profile;
    expect(created.name).toBe('Research');
    expect(created.include_claude_preset).toBe(false);
    expect(created.runtime_policy).toMatchObject({
      context: {
        source: 'managed',
        auto_compact_window: 0,
        auto_compact_percentage: 0,
      },
      skills: { mode: 'custom', ids: ['research'] },
    });
    expect(created.version).toBe(1);

    const patchedRes = await routes.request(`/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Research Lead',
        identity_prompt: '先列证据，再给结论。',
        include_claude_preset: true,
        runtime_policy: {
          skills: { mode: 'disabled', ids: [] },
          mcp: { mode: 'custom', ids: ['github'] },
        },
      }),
    });
    expect(patchedRes.status).toBe(200);
    const patchedBody = await patchedRes.json();
    expect(patchedBody.profile.name).toBe('Research Lead');
    expect(patchedBody.profile.include_claude_preset).toBe(true);
    expect(patchedBody.profile.runtime_policy).toMatchObject({
      context: {
        source: 'managed',
        auto_compact_window: 0,
        auto_compact_percentage: 0,
      },
      skills: { mode: 'disabled', ids: [] },
      mcp: { mode: 'custom', ids: ['github'] },
    });
    expect(patchedBody.profile.version).toBe(2);
  });

  test('creates, patches, inherits, and validates Agent effort', async () => {
    const defaultProfile = db
      .listAgentProfilesForUser('routes-agent-user')
      .find((profile) => profile.is_default);
    expect(defaultProfile).toBeDefined();
    const defaultPatchRes = await routes.request(`/${defaultProfile!.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runtime_policy: { reasoning: { effort: 'medium' } },
      }),
    });
    expect(defaultPatchRes.status).toBe(200);
    expect(
      (await defaultPatchRes.json()).profile.runtime_policy.reasoning,
    ).toEqual({ effort: 'medium' });

    const createdRes = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Effort Agent',
        runtime_policy: { reasoning: { effort: 'high' } },
      }),
    });
    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()).profile;
    expect(created.runtime_policy.reasoning).toEqual({ effort: 'high' });

    const patchedRes = await routes.request(`/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runtime_policy: { reasoning: { effort: 'xhigh' } },
      }),
    });
    expect(patchedRes.status).toBe(200);
    const patched = (await patchedRes.json()).profile;
    expect(patched.runtime_policy.reasoning).toEqual({ effort: 'xhigh' });
    expect(patched.version).toBe(created.version + 1);

    const inheritedRes = await routes.request(`/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runtime_policy: { reasoning: { effort: 'inherit' } },
      }),
    });
    expect(inheritedRes.status).toBe(200);
    expect(
      (await inheritedRes.json()).profile.runtime_policy.reasoning,
    ).toEqual({ effort: 'inherit' });

    const invalidRes = await routes.request(`/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runtime_policy: { reasoning: { effort: 'turbo' } },
      }),
    });
    expect(invalidRes.status).toBe(400);

    const restoreDefaultRes = await routes.request(`/${defaultProfile!.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runtime_policy: { reasoning: { effort: 'inherit' } },
      }),
    });
    expect(restoreDefaultRes.status).toBe(200);
  });

  test('keeps legacy all-in-one prompt payloads compatible while complete payloads use IDENTITY', async () => {
    const createdRes = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Legacy Prompt Client',
        identity_prompt: 'legacy operating instructions',
        include_claude_preset: false,
      }),
    });
    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()).profile;
    expect(created).toMatchObject({
      identity_prompt: '',
      agents_prompt: 'legacy operating instructions',
      prompt_mode: 'replace',
    });

    const legacyPatch = await routes.request(`/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identity_prompt: 'updated legacy operating instructions',
      }),
    });
    expect(legacyPatch.status).toBe(200);
    const legacyUpdated = (await legacyPatch.json()).profile;
    expect(legacyUpdated).toMatchObject({
      identity_prompt: '',
      agents_prompt: 'updated legacy operating instructions',
      version: created.version + 1,
    });

    // The four-part editor always sends all sections plus prompt_mode. That
    // explicit shape disambiguates its narrow IDENTITY field from the legacy
    // client's historical all-in-one `identity_prompt` field.
    const completePatch = await routes.request(`/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identity_prompt: 'narrow identity',
        soul_prompt: '',
        agents_prompt: legacyUpdated.agents_prompt,
        tools_prompt: '',
        prompt_mode: legacyUpdated.prompt_mode,
      }),
    });
    expect(completePatch.status).toBe(200);
    expect((await completePatch.json()).profile).toMatchObject({
      identity_prompt: 'narrow identity',
      agents_prompt: 'updated legacy operating instructions',
      version: legacyUpdated.version + 1,
    });

    const modernIdentityOnlyPatch = await routes.request(`/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt_schema_version: 2,
        identity_prompt: 'modern partial identity',
      }),
    });
    expect(modernIdentityOnlyPatch.status).toBe(200);
    expect((await modernIdentityOnlyPatch.json()).profile).toMatchObject({
      identity_prompt: 'modern partial identity',
      agents_prompt: 'updated legacy operating instructions',
      version: legacyUpdated.version + 2,
    });
  });

  test('accepts source-qualified system MCP and keeps bare ids user-scoped', async () => {
    const response = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Scoped MCP Agent',
        runtime_policy: {
          mcp: { mode: 'custom', ids: ['system:platform', 'github'] },
        },
      }),
    });
    expect(response.status).toBe(201);
    expect((await response.json()).profile.runtime_policy.mcp).toEqual({
      mode: 'custom',
      ids: ['system:platform', 'github'],
    });
  });

  test('rejects admin-only system MCP for members with an explicit reason but allows admins', async () => {
    const memberResponse = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Restricted System MCP Agent',
        runtime_policy: {
          mcp: { mode: 'custom', ids: ['system:vault'] },
        },
      }),
    });
    expect(memberResponse.status).toBe(400);
    expect(await memberResponse.json()).toMatchObject({
      invalid_runtime_policy: {
        mcp: ['system:vault'],
        restricted_system_mcp: ['system:vault'],
      },
    });

    const adminResponse = await routes.request('/', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-role': 'admin',
      },
      body: JSON.stringify({
        name: 'Admin System MCP Agent',
        runtime_policy: {
          mcp: { mode: 'custom', ids: ['system:vault'] },
        },
      }),
    });
    expect(adminResponse.status).toBe(201);
  });

  test('rejects AgentProfile model policy because models are configured by providers', async () => {
    const res = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'No Model Policy',
        identity_prompt: '不要在 Agent 层设置模型。',
        runtime_policy: {
          model: 'claude-opus-4-1',
        },
      }),
    });

    expect(res.status).toBe(400);
  });

  test('rejects Agent Provider because Provider selection is session-owned', async () => {
    const res = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'No Provider Policy',
        runtime_policy: { provider_id: 'missing-provider' },
      }),
    });

    expect(res.status).toBe(400);
  });

  test('rejects unavailable Skill and MCP references', async () => {
    const res = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Invalid References',
        runtime_policy: {
          skills: { mode: 'custom', ids: ['missing-skill'] },
          mcp: { mode: 'custom', ids: ['missing-mcp'] },
        },
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      invalid_runtime_policy: {
        skills: ['missing-skill'],
        mcp: ['missing-mcp'],
      },
    });
  });

  test('PATCH deep-merges nested runtime policy fields', async () => {
    const created = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Merge Policy',
      runtimePolicy: {
        skills: { mode: 'custom', ids: ['research'] },
        mcp: { mode: 'custom', ids: ['github'] },
      },
    });

    const res = await routes.request(`/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runtime_policy: { skills: { mode: 'disabled' } },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.runtime_policy).toEqual({
      reasoning: { effort: 'inherit' },
      context: {
        source: 'managed',
        auto_compact_window: 0,
        auto_compact_percentage: 0,
      },
      skills: {
        mode: 'disabled',
        ids: ['research'],
        host: { mode: 'disabled', ids: [] },
      },
      mcp: { mode: 'custom', ids: ['github'] },
    });
  });

  test('rejects the retired Agent tool policy', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'No Tool Modes',
    });
    const res = await routes.request(`/${profile.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runtime_policy: { tools: { mode: 'readonly' } },
      }),
    });
    expect(res.status).toBe(400);
    expect(db.getAgentProfile(profile.id)?.version).toBe(profile.version);
  });

  test('previews the effective additive capabilities without exposing Provider selection', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Capability Preview',
      runtimePolicy: {
        skills: { mode: 'custom', ids: ['research'] },
        mcp: { mode: 'custom', ids: ['github'] },
      },
    });

    const res = await routes.request(`/${profile.id}/effective-capabilities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime_policy: profile.runtime_policy }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      preview: {
        workspace: null,
        skills: {
          entries: expect.arrayContaining([
            expect.objectContaining({ id: 'research', source: 'managed' }),
          ]),
        },
        mcp: {
          entries: expect.arrayContaining([
            expect.objectContaining({ id: 'github', available: true }),
          ]),
        },
      },
    });
  });

  test('rejects host context for members on create and patch', async () => {
    const createRes = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Unauthorized Host Agent',
        runtime_policy: { context: { source: 'host_claude' } },
      }),
    });
    expect(createRes.status).toBe(403);
    expect(await createRes.json()).toEqual({
      error: 'host_claude context requires an admin role',
    });

    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Managed Agent',
    });
    const patchRes = await routes.request(`/${profile.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runtime_policy: { context: { source: 'host_claude' } },
      }),
    });
    expect(patchRes.status).toBe(403);
    expect(await patchRes.json()).toEqual({
      error: 'host_claude context requires an admin role',
    });
    expect(
      db.getAgentProfileForUser(profile.id, 'routes-agent-user')?.runtime_policy
        .context.source,
    ).toBe('managed');
  });

  test('rejects member partial patches that would mutate enabled host Skills', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Downgraded Host Skills Agent',
      runtimePolicy: {
        skills: {
          mode: 'inherit',
          ids: [],
          host: { mode: 'custom', ids: ['existing-host-skill'] },
        },
      },
    });

    const patchRes = await routes.request(`/${profile.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runtime_policy: { skills: { host: { ids: ['replacement-skill'] } } },
      }),
    });
    expect(patchRes.status).toBe(403);
    expect(await patchRes.json()).toEqual({
      error: 'host skills require an admin role',
    });
    expect(
      db.getAgentProfileForUser(profile.id, 'routes-agent-user')?.runtime_policy
        .skills.host,
    ).toEqual({ mode: 'custom', ids: ['existing-host-skill'] });
  });

  test('rejects empty custom host Skill selections on create and patch', async () => {
    const createRes = await routes.request('/', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-role': 'admin',
      },
      body: JSON.stringify({
        name: 'Empty Host Skills Agent',
        runtime_policy: {
          skills: { host: { mode: 'custom', ids: [] } },
        },
      }),
    });
    expect(createRes.status).toBe(400);
    expect(await createRes.json()).toEqual({
      error: 'Custom host skills require at least one selected skill',
    });

    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Managed Skills Agent',
    });
    const patchRes = await routes.request(`/${profile.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-test-role': 'admin',
      },
      body: JSON.stringify({
        runtime_policy: {
          skills: { host: { mode: 'custom', ids: [] } },
        },
      }),
    });
    expect(patchRes.status).toBe(400);
    expect(await patchRes.json()).toEqual({
      error: 'Custom host skills require at least one selected skill',
    });
  });

  test('persists an admin host Skills switch from custom to inherit', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'All Host Skills Agent',
      runtimePolicy: {
        context: {
          source: 'managed',
          auto_compact_window: 0,
          auto_compact_percentage: 80,
        },
        skills: {
          mode: 'disabled',
          ids: [],
          host: {
            mode: 'custom',
            ids: ['legacy-custom-selection'],
          },
        },
        mcp: { mode: 'custom', ids: ['github'] },
      },
    });

    const patchRes = await routes.request(`/${profile.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-test-role': 'admin',
      },
      body: JSON.stringify({
        runtime_policy: {
          skills: {
            host: { mode: 'inherit', ids: [] },
          },
        },
      }),
    });

    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()).profile;
    expect(patched.runtime_policy.skills.host).toEqual({
      mode: 'inherit',
      ids: [],
    });
    expect(patched.runtime_policy).toMatchObject({
      context: {
        source: 'managed',
        auto_compact_window: 0,
        auto_compact_percentage: 80,
      },
      skills: { mode: 'disabled', ids: [] },
      mcp: { mode: 'custom', ids: ['github'] },
    });
    expect(patched.version).toBe(profile.version + 1);
    expect(
      db.getAgentProfileForUser(profile.id, 'routes-agent-user')?.runtime_policy
        .skills.host,
    ).toEqual({ mode: 'inherit', ids: [] });
  });

  test('rejects member attempts to enable inherited host Skills', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Member Host Skills Agent',
    });
    const patchRes = await routes.request(`/${profile.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runtime_policy: {
          skills: {
            host: { mode: 'inherit', ids: [] },
          },
        },
      }),
    });

    expect(patchRes.status).toBe(403);
    expect(await patchRes.json()).toEqual({
      error: 'host skills require an admin role',
    });
  });

  test('allows admins to create host agents and patch the default HappyClaw profile', async () => {
    const createRes = await routes.request('/', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-role': 'admin',
      },
      body: JSON.stringify({
        name: 'Admin Host Agent',
        runtime_policy: { context: { source: 'host_claude' } },
      }),
    });
    expect(createRes.status).toBe(201);
    expect((await createRes.json()).profile.runtime_policy.context).toEqual({
      source: 'host_claude',
      auto_compact_window: 0,
      auto_compact_percentage: 0,
    });

    const defaultProfile = db
      .listAgentProfilesForUser('routes-agent-user')
      .find((profile) => profile.is_default)!;
    const patchRes = await routes.request(`/${defaultProfile.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-test-role': 'admin',
      },
      body: JSON.stringify({
        runtime_policy: { context: { source: 'host_claude' } },
      }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()).profile;
    expect(patched.runtime_policy.context).toEqual({
      source: 'host_claude',
      auto_compact_window: 0,
      auto_compact_percentage: 0,
    });
    expect(patched.version).toBe(defaultProfile.version + 1);
    expect(patched.identity_hash).not.toBe(defaultProfile.identity_hash);

    const deleteRes = await routes.request(`/${defaultProfile.id}`, {
      method: 'DELETE',
      headers: { 'x-test-role': 'admin' },
    });
    expect(deleteRes.status).toBe(400);
  });

  test('rejects blank names after trim', async () => {
    const res = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  test('POST /generate returns an AI AgentProfile draft', async () => {
    const res = await routes.request('/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: '帮我做代码评审，重点看风险。' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft).toEqual({
      name: '代码评审 Agent',
      identity_prompt: '根据描述生成：帮我做代码评审，重点看风险。',
    });
  });

  test('POST /generate rejects blank descriptions', async () => {
    const res = await routes.request('/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  test('POST /:id/refine-prompt returns a candidate without saving it', async () => {
    const [profile] = db.listAgentProfilesForUser('routes-agent-user');
    const originalPrompt = profile.identity_prompt;
    const res = await routes.request(`/${profile.id}/refine-prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '回答时先给结论',
        current_prompt: '你是一个研究助手。',
        history: [
          { role: 'user', content: '语气更直接一些' },
          { role: 'assistant', content: '已经调整了表达方式。' },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      refinement: {
        reply: '已按要求调整：回答时先给结论',
        identity_prompt: '你是一个研究助手。\n新增要求：回答时先给结论',
      },
    });
    expect(
      db.getAgentProfileForUser(profile.id, 'routes-agent-user'),
    ).toMatchObject({ identity_prompt: originalPrompt });
  });

  test('POST /:id/refine-prompt validates ownership and input', async () => {
    const missing = await routes.request('/missing-profile/refine-prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '调整一下',
        current_prompt: '',
      }),
    });
    expect(missing.status).toBe(404);

    const [profile] = db.listAgentProfilesForUser('routes-agent-user');
    const invalid = await routes.request(`/${profile.id}/refine-prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '   ', current_prompt: '' }),
    });
    expect(invalid.status).toBe(400);
  });

  test('does not delete the default AgentProfile', async () => {
    const [defaultProfile] = db.listAgentProfilesForUser('routes-agent-user');
    const res = await routes.request(`/${defaultProfile.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
  });

  test('DELETE succeeds after workspace mapping removal also clears mount ownership', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Mounted Agent',
      identityPrompt: '负责 IM 挂载。',
    });
    db.setRegisteredGroup('web:routes-mounted-workspace', {
      name: 'Mounted Workspace',
      folder: 'routes-mounted-workspace',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: 'routes-agent-user',
    });
    db.assignWorkspaceAgentProfile('routes-mounted-workspace', profile.id);
    db.setRegisteredGroup('telegram:routes-mounted-channel', {
      name: 'Mounted Channel',
      folder: 'routes-home',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: 'routes-agent-user',
      target_main_jid: 'web:routes-mounted-workspace',
    });
    db.deleteWorkspaceAgentProfile('routes-mounted-workspace');
    expect(
      db.getAgentChannelMount('telegram:routes-mounted-channel'),
    ).toMatchObject({ agent_profile_id: null });

    const res = await routes.request(`/${profile.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
  });

  test('GET /:id/workspaces includes session and channel mount governance data', async () => {
    const [defaultProfile] = db.listAgentProfilesForUser('routes-agent-user');
    db.setRegisteredGroup('web:routes-agent-workspace', {
      name: 'Routes Agent Workspace',
      folder: 'routes-agent-workspace',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: 'routes-agent-user',
      is_home: false,
    });
    db.assignWorkspaceAgentProfile('routes-agent-workspace', defaultProfile.id);
    db.setSession('routes-agent-workspace', 'claude-routes-session', '', {
      agentProfileId: defaultProfile.id,
      agentProfileVersion: defaultProfile.version,
      identityHash: defaultProfile.identity_hash,
    });
    db.setRegisteredGroup('telegram:routes-agent-mount', {
      name: 'Routes Telegram',
      folder: 'routes-agent-home',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: 'routes-agent-user',
      target_main_jid: 'web:routes-agent-workspace',
      reply_policy: 'mirror',
    });

    const res = await routes.request(`/${defaultProfile.id}/workspaces`, {
      method: 'GET',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaces).toContainEqual(
      expect.objectContaining({
        jid: 'web:routes-agent-workspace',
        folder: 'routes-agent-workspace',
        runtime_sessions: [
          expect.objectContaining({
            runtime_agent_id: '',
            sdk_session_id: 'claude-routes-session',
            agent_profile_id: defaultProfile.id,
            agent_profile_version: defaultProfile.version,
          }),
        ],
      }),
    );
    expect(body.channel_mounts).toContainEqual(
      expect.objectContaining({
        channel_jid: 'telegram:routes-agent-mount',
        workspace_jid: 'web:routes-agent-workspace',
        workspace_folder: 'routes-agent-workspace',
        session_id: null,
        routing_mode: 'single_session',
        reply_policy: 'mirror',
      }),
    );
  });

  test('does not persist identity changes when Runner invalidation partially fails, and identical retry succeeds', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Retryable Identity',
      identityPrompt: 'old identity',
    });
    for (const suffix of ['a', 'b']) {
      db.setRegisteredGroup(`web:retry-invalidation-${suffix}`, {
        name: `Retry ${suffix}`,
        folder: `retry-invalidation-${suffix}`,
        added_at: '2026-07-10T00:00:00.000Z',
        created_by: 'routes-agent-user',
      });
      db.assignWorkspaceAgentProfile(
        `retry-invalidation-${suffix}`,
        profile.id,
      );
    }

    let failOnce = true;
    const stopGroup = vi.fn(async (jid: string) => {
      if (jid === 'web:retry-invalidation-b' && failOnce) {
        failOnce = false;
        throw new Error('injected stop failure');
      }
    });
    webContext.setWebDeps({
      queue: {
        pauseGroupsForMutation: () => ({ keys: ['retry-invalidation'] }),
        resumeGroupsAfterMutation: () => {},
        listDescendantJids: () => [],
        getStatus: () => ({ groups: [] }),
        stopGroup,
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    const request = () =>
      routes.request(`/${profile.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identity_prompt: 'new identity' }),
      });

    const failed = await request();
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({
      persisted: false,
      retryable: true,
    });
    expect(
      db.getAgentProfileForUser(profile.id, 'routes-agent-user'),
    ).toMatchObject({
      identity_prompt: 'old identity',
      version: profile.version,
    });

    const retried = await request();
    expect(retried.status).toBe(200);
    const retriedBody = await retried.json();
    expect(retriedBody.profile).toMatchObject({
      identity_prompt: 'new identity',
      version: profile.version + 1,
    });
    expect(
      stopGroup.mock.calls.filter(
        ([jid]) => jid === 'web:retry-invalidation-a',
      ),
    ).toHaveLength(3);
    expect(
      stopGroup.mock.calls.filter(
        ([jid]) => jid === 'web:retry-invalidation-b',
      ),
    ).toHaveLength(3);
  });

  test('reports persisted post-stop failure and owner cleanup retry removes the safety block', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Post Commit Retry Identity',
      identityPrompt: 'old post-commit identity',
    });
    db.setRegisteredGroup('web:post-commit-invalidation', {
      name: 'Post Commit Invalidation',
      folder: 'post-commit-invalidation',
      added_at: '2026-07-10T00:00:00.000Z',
      created_by: 'routes-agent-user',
    });
    db.assignWorkspaceAgentProfile('post-commit-invalidation', profile.id);

    let stopCalls = 0;
    let runtimeSafetyBlocked = false;
    const stopGroup = vi.fn(async () => {
      stopCalls += 1;
      if (stopCalls === 2) {
        throw new Error('injected post-commit cleanup failure');
      }
    });
    webContext.setWebDeps({
      queue: {
        pauseGroupsForMutation: () => ({ keys: ['post-commit'] }),
        resumeGroupsAfterMutation: () => {},
        listDescendantJids: () => [],
        getStatus: () => ({ groups: [] }),
        stopGroup,
        blockGroupsForRuntimeSafety: () => {
          runtimeSafetyBlocked = true;
        },
        unblockGroupsForRuntimeSafety: () => {
          runtimeSafetyBlocked = false;
        },
        isGroupRuntimeSafetyBlocked: () => runtimeSafetyBlocked,
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    const request = () =>
      routes.request(`/${profile.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identity_prompt: 'new post-commit identity' }),
      });

    const failedCleanup = await request();
    expect(failedCleanup.status).toBe(503);
    expect(await failedCleanup.json()).toMatchObject({
      persisted: true,
      retryable: true,
      profile: {
        identity_prompt: 'new post-commit identity',
        version: profile.version + 1,
      },
    });
    expect(
      db.getAgentProfileForUser(profile.id, 'routes-agent-user'),
    ).toMatchObject({
      identity_prompt: 'new post-commit identity',
      version: profile.version + 1,
    });
    expect(runtimeSafetyBlocked).toBe(true);
    const pendingGovernance = await routes.request(`/${profile.id}/workspaces`);
    expect(pendingGovernance.status).toBe(200);
    expect(await pendingGovernance.json()).toMatchObject({
      runtime_cleanup_pending: true,
    });

    const retried = await routes.request(`/${profile.id}/runtime-cleanup`, {
      method: 'POST',
    });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      success: true,
      runtime_cleanup_pending: false,
    });
    expect(
      db.getAgentProfileForUser(profile.id, 'routes-agent-user'),
    ).toMatchObject({
      identity_prompt: 'new post-commit identity',
      version: profile.version + 1,
    });
    // Cleanup is owner-scoped and does not need to replay a potentially
    // privileged or stale configuration payload.
    expect(stopGroup).toHaveBeenCalledTimes(4);
    expect(runtimeSafetyBlocked).toBe(false);
    const repairedGovernance = await routes.request(
      `/${profile.id}/workspaces`,
    );
    expect(repairedGovernance.status).toBe(200);
    expect(await repairedGovernance.json()).toMatchObject({
      runtime_cleanup_pending: false,
    });
  });

  test('governance waits for an in-flight profile cleanup before reporting pending state', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Locked Governance Snapshot',
      identityPrompt: 'old locked identity',
    });
    db.setRegisteredGroup('web:locked-governance-snapshot', {
      name: 'Locked Governance Snapshot',
      folder: 'locked-governance-snapshot',
      added_at: '2026-07-10T00:00:00.000Z',
      created_by: 'routes-agent-user',
    });
    db.assignWorkspaceAgentProfile('locked-governance-snapshot', profile.id);

    let stopCalls = 0;
    let runtimeSafetyBlocked = false;
    let signalPostStop!: () => void;
    const postStopEntered = new Promise<void>((resolve) => {
      signalPostStop = resolve;
    });
    let releasePostStop!: () => void;
    const postStopRelease = new Promise<void>((resolve) => {
      releasePostStop = resolve;
    });
    const stopGroup = vi.fn(async () => {
      stopCalls += 1;
      if (stopCalls === 2) {
        signalPostStop();
        await postStopRelease;
        throw new Error('injected delayed post-commit cleanup failure');
      }
    });
    webContext.setWebDeps({
      queue: {
        pauseGroupsForMutation: () => ({ keys: ['locked-governance'] }),
        resumeGroupsAfterMutation: () => {},
        listDescendantJids: () => [],
        getStatus: () => ({ groups: [] }),
        stopGroup,
        blockGroupsForRuntimeSafety: () => {
          runtimeSafetyBlocked = true;
        },
        unblockGroupsForRuntimeSafety: () => {
          runtimeSafetyBlocked = false;
        },
        isGroupRuntimeSafetyBlocked: () => runtimeSafetyBlocked,
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    const patchPromise = routes.request(`/${profile.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identity_prompt: 'new locked identity' }),
    });
    await postStopEntered;

    let governanceSettled = false;
    const governancePromise = routes
      .request(`/${profile.id}/workspaces`)
      .then((response) => {
        governanceSettled = true;
        return response;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(governanceSettled).toBe(false);

    releasePostStop();
    const failedPatch = await patchPromise;
    expect(failedPatch.status).toBe(503);
    const governance = await governancePromise;
    expect(governance.status).toBe(200);
    expect(await governance.json()).toMatchObject({
      runtime_cleanup_pending: true,
      profile: { identity_prompt: 'new locked identity' },
    });
  });

  test('emoji-only and normalized no-op PATCHes do not quiesce Agent workspaces', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Stable Runtime Agent',
      identityPrompt: 'Keep this runtime identity stable.',
      includeClaudePreset: true,
      runtimePolicy: {
        skills: { mode: 'inherit', ids: [] },
        mcp: { mode: 'inherit', ids: [] },
      },
    });
    const folder = 'stable-runtime-workspace';
    db.setRegisteredGroup('web:stable-runtime-workspace', {
      name: 'Stable Runtime Workspace',
      folder,
      added_at: '2026-07-10T00:00:00.000Z',
      created_by: 'routes-agent-user',
    });
    db.assignWorkspaceAgentProfile(folder, profile.id);

    const stopGroup = vi.fn(async () => {});
    webContext.setWebDeps({
      queue: {
        pauseGroupsForMutation: () => ({ id: 1 }),
        resumeGroupsAfterMutation: () => {},
        listDescendantJids: () => [],
        getStatus: () => ({ groups: [] }),
        stopGroup,
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    const emojiResponse = await routes.request(`/${profile.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: profile.name,
        identity_prompt: profile.identity_prompt,
        include_claude_preset: profile.include_claude_preset,
        avatar_emoji: '🧭',
        runtime_policy: {
          skills: { mode: 'inherit', ids: [] },
          mcp: { mode: 'inherit', ids: [] },
        },
      }),
    });
    expect(emojiResponse.status).toBe(200);
    expect((await emojiResponse.json()).profile).toMatchObject({
      avatar_emoji: '🧭',
      version: profile.version,
    });

    const noOpResponse = await routes.request(`/${profile.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: profile.name }),
    });
    expect(noOpResponse.status).toBe(200);
    expect((await noOpResponse.json()).profile.version).toBe(profile.version);
    expect(stopGroup).not.toHaveBeenCalled();
  });

  test('effort PATCH invalidates warm workspaces and advances runtime identity', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Warm Effort Agent',
      runtimePolicy: { reasoning: { effort: 'low' } },
    });
    const folder = 'warm-effort-workspace';
    db.setRegisteredGroup('web:warm-effort-workspace', {
      name: 'Warm Effort Workspace',
      folder,
      added_at: '2026-08-01T00:00:00.000Z',
      created_by: 'routes-agent-user',
    });
    db.assignWorkspaceAgentProfile(folder, profile.id);
    db.setSession(folder, 'sdk-warm-effort', '', {
      agentProfileId: profile.id,
      agentProfileVersion: profile.version,
      identityHash: profile.identity_hash,
    });

    const stopGroup = vi.fn(async () => {});
    webContext.setWebDeps({
      queue: {
        pauseGroupsForMutation: () => ({ id: 1 }),
        resumeGroupsAfterMutation: () => {},
        listDescendantJids: () => [],
        getStatus: () => ({ groups: [] }),
        stopGroup,
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    const response = await routes.request(`/${profile.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runtime_policy: { reasoning: { effort: 'max' } },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      invalidated_runtime_jids: 1,
      profile: {
        version: profile.version + 1,
        runtime_policy: { reasoning: { effort: 'max' } },
      },
    });
    expect(body.profile.identity_hash).not.toBe(profile.identity_hash);
    expect(stopGroup).toHaveBeenCalledTimes(2);
  });

  test('name-only PATCH bumps identity version/hash, quiesces twice, and leaves the old session hash mismatched', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Old Prompt Name',
      identityPrompt: 'Name is part of the injected identity.',
    });
    const folder = 'name-identity-workspace';
    db.setRegisteredGroup('web:name-identity-workspace', {
      name: 'Name Identity Workspace',
      folder,
      added_at: '2026-07-10T00:00:00.000Z',
      created_by: 'routes-agent-user',
    });
    db.assignWorkspaceAgentProfile(folder, profile.id);
    db.setSession(folder, 'sdk-name-identity', '', {
      agentProfileId: profile.id,
      agentProfileVersion: profile.version,
      identityHash: profile.identity_hash,
    });
    const stopGroup = vi.fn(async () => {});
    webContext.setWebDeps({
      queue: {
        pauseGroupsForMutation: () => ({ id: 1 }),
        resumeGroupsAfterMutation: () => {},
        listDescendantJids: () => [],
        getStatus: () => ({ groups: [] }),
        stopGroup,
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    const res = await routes.request(`/${profile.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New Prompt Name' }),
    });

    expect(res.status).toBe(200);
    const updated = (await res.json()).profile;
    expect(updated).toMatchObject({
      name: 'New Prompt Name',
      version: profile.version + 1,
    });
    expect(updated.identity_hash).not.toBe(profile.identity_hash);
    expect(stopGroup).toHaveBeenCalledTimes(2);
    expect(db.getSessionAgentIdentity(folder)).toMatchObject({
      agent_profile_version: profile.version,
      identity_hash: profile.identity_hash,
    });
    expect(db.getSessionAgentIdentity(folder)?.identity_hash).not.toBe(
      updated.identity_hash,
    );
  });

  test('persists the four prompt sections and the prompt mode', async () => {
    const createResponse = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Four Part Agent',
        identity_prompt: '\nIdentity\n',
        soul_prompt: 'Soul',
        agents_prompt: 'Agents v1',
        tools_prompt: 'Tools v1',
        prompt_mode: 'append',
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()).profile;
    expect(created).toMatchObject({
      identity_prompt: '\nIdentity\n',
      soul_prompt: 'Soul',
      agents_prompt: 'Agents v1',
      tools_prompt: 'Tools v1',
      prompt_mode: 'append',
      include_claude_preset: true,
      version: 1,
    });

    const patchResponse = await routes.request(`/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tools_prompt: 'Tools v2',
        prompt_mode: 'replace',
      }),
    });
    expect(patchResponse.status).toBe(200);
    expect((await patchResponse.json()).profile).toMatchObject({
      identity_prompt: '\nIdentity\n',
      tools_prompt: 'Tools v2',
      prompt_mode: 'replace',
      include_claude_preset: false,
      version: 2,
    });
  });

  test('DELETE waits for membership publication and then refuses to archive the target', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Delete Membership Race',
    });
    const folder = 'delete-membership-race';
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publisher = agentProfileRuntime.withAgentProfileLocks(
      [profile.id],
      async () => {
        entered();
        await gate;
        db.setRegisteredGroup('web:delete-membership-race', {
          name: 'Delete Membership Race',
          folder,
          added_at: '2026-07-10T00:00:00.000Z',
          created_by: 'routes-agent-user',
        });
        db.assignWorkspaceAgentProfile(folder, profile.id);
      },
    );
    await enteredPromise;

    const deleteResponsePromise = routes.request(`/${profile.id}`, {
      method: 'DELETE',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.getWorkspaceAgentProfileId(folder)).toBeUndefined();

    release();
    await publisher;
    const deleteResponse = await deleteResponsePromise;
    expect(deleteResponse.status).toBe(409);
    expect(
      db.getAgentProfileForUser(profile.id, 'routes-agent-user'),
    ).toBeDefined();
    expect(db.getWorkspaceAgentProfileId(folder)).toBe(profile.id);
  });
});

describe('/api/agent-profiles model within a configuration', () => {
  let listed: ReturnType<typeof runtimeConfig.createProvider>;
  let other: ReturnType<typeof runtimeConfig.createProvider>;

  beforeAll(() => {
    listed = runtimeConfig.createProvider({
      name: 'Model list config',
      type: 'third_party',
      anthropicBaseUrl: 'https://list.example.test',
      anthropicAuthToken: 'list-token',
      anthropicModel: 'list-default',
      models: [
        { id: 'list-default' },
        { id: 'list-fast', effort: 'low' },
        { id: 'list-old', hidden: true },
      ],
      enabled: false,
    });
    other = runtimeConfig.createProvider({
      name: 'Other list config',
      type: 'third_party',
      anthropicBaseUrl: 'https://other.example.test',
      anthropicAuthToken: 'other-token',
      anthropicModel: 'other-default',
      enabled: false,
    });
  });

  const send = async (
    method: 'POST' | 'PATCH',
    pathname: string,
    body: unknown,
  ) => {
    const res = await routes.request(pathname, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  test('GET lists what each configuration offers and each Agent model', async () => {
    const created = await send('POST', '/', {
      name: 'Listed Model Agent',
      model_config_id: listed.id,
      model: 'list-fast',
    });
    const body = await (await routes.request('/', { method: 'GET' })).json();
    const unknown = (id: string) => ({
      id,
      displayName: null,
      efforts: [],
      defaultEffort: null,
      contextWindow: null,
      effortsSource: 'none',
      maxOutputTokens: null,
      vendor: null,
      upstreamMissingSince: null,
    });
    expect(
      body.model_configs
        .find((item: any) => item.id === listed.id)
        .models.map((model: any) => model.id),
    ).toEqual(['list-default', 'list-fast', 'list-old']);
    // A configuration saved without a list offers its one model.
    expect(
      body.model_configs.find((item: any) => item.id === other.id).models,
    ).toEqual([unknown('other-default')]);
    expect(
      body.profiles.find((item: any) => item.id === created.body.profile.id),
    ).toMatchObject({ model_config_id: listed.id, model: 'list-fast' });
    expect(body.profiles.find((item: any) => item.is_default).model).toBeNull();
  });

  test('inherited_model names what the main Agents hand down; PATCH checks the effort', async () => {
    const effortful = runtimeConfig.createProvider({
      name: 'Effortful config',
      type: 'third_party',
      anthropicBaseUrl: 'https://effort.example.test',
      anthropicAuthToken: 'effort-token',
      anthropicModel: 'eff-a',
      models: [
        { id: 'eff-a', efforts: ['low', 'high'], defaultEffort: 'low' },
        { id: 'eff-none' },
      ],
    });
    const main = db.getOrCreateDefaultAgentProfile('routes-agent-user');
    expect(
      await send('PATCH', `/${main.id}`, {
        model_config_id: effortful.id,
        model: 'eff-a',
        runtime_policy: { reasoning: { effort: 'high' } },
      }),
    ).toMatchObject({ status: 200 });
    const list = async () =>
      (await (await routes.request('/', { method: 'GET' })).json())
        .inherited_model;
    expect(await list()).toEqual({
      owner_main: {
        model_config_id: effortful.id,
        model: 'eff-a',
        effort: 'high',
      },
      system_main: null,
      system_main_profile_id: null,
    });

    // The bound model must take the Agent's explicit effort.
    expect(
      await send('PATCH', `/${main.id}`, { model: 'eff-none' }),
    ).toMatchObject({ status: 400, body: { code: 'EFFORT_NOT_SUPPORTED' } });
    expect(
      await send('PATCH', `/${main.id}`, {
        runtime_policy: { reasoning: { effort: 'max' } },
      }),
    ).toMatchObject({ status: 400, body: { code: 'EFFORT_NOT_SUPPORTED' } });
    expect(
      await send('PATCH', `/${main.id}`, {
        model: 'eff-none',
        runtime_policy: { reasoning: { effort: 'inherit' } },
      }),
    ).toMatchObject({ status: 200 });
    // A name saved with `[1m]` is the same model.
    expect(
      await send('PATCH', `/${main.id}`, {
        model: 'eff-a[1m]',
        runtime_policy: { reasoning: { effort: 'high' } },
      }),
    ).toMatchObject({ status: 200 });
    // Creating checks the same; a copy of what cannot run inherits instead.
    expect(
      await send('POST', '/', {
        name: `Effortless ${Math.random()}`,
        model_config_id: effortful.id,
        model: 'eff-none',
        runtime_policy: { reasoning: { effort: 'high' } },
      }),
    ).toMatchObject({ status: 400, body: { code: 'EFFORT_NOT_SUPPORTED' } });
    const custom = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: `Copy source ${Math.random()}`,
      modelConfigId: effortful.id,
      model: 'eff-a',
      runtimePolicy: { reasoning: { effort: 'high' } } as never,
    });
    db.updateAgentProfile(custom.id, 'routes-agent-user', {
      model: 'eff-none',
    });
    const copied = await send('POST', `/${custom.id}/duplicate`, {});
    expect(copied.status).toBe(201);
    expect(copied.body.profile).toMatchObject({
      model_config_id: effortful.id,
      model: 'eff-none',
      runtime_policy: { reasoning: { effort: 'inherit' } },
    });
    db.updateAgentProfile(main.id, 'routes-agent-user', {
      model: 'eff-none',
      runtimePolicy: { reasoning: { effort: 'inherit' } } as never,
    });

    // The system main is the earliest active admin's main Agent; its id is
    // only told to its owner.
    const at = new Date().toISOString();
    db.createUser({
      id: 'routes-agent-admin',
      username: 'routes-agent-admin',
      password_hash: 'hash',
      display_name: 'Admin',
      role: 'admin',
      status: 'active',
      created_at: at,
      updated_at: at,
      must_change_password: false,
    });
    const adminMain = db.getOrCreateDefaultAgentProfile('routes-agent-admin');
    db.updateAgentProfile(adminMain.id, 'routes-agent-admin', {
      modelConfigId: effortful.id,
    });
    expect(await list()).toMatchObject({
      system_main: {
        model_config_id: effortful.id,
        model: 'eff-a',
        effort: 'low',
      },
      system_main_profile_id: null,
    });
    db.updateAgentProfile(adminMain.id, 'routes-agent-admin', {
      modelConfigId: null,
    });
    db.updateAgentProfile(main.id, 'routes-agent-user', {
      modelConfigId: null,
    });
  });

  test('a ChatGPT configuration offers its catalog', async () => {
    const { CODEX_GATEWAY_BASE_URL_PLACEHOLDER } =
      await import('../src/codex-gateway/types.js');
    const chatGpt = runtimeConfig.createProvider({
      name: 'ChatGPT catalog config',
      type: 'third_party',
      anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
      anthropicAuthToken: 'gateway-identifier',
      anthropicModel: 'gpt-6-sol',
      codexOAuthCredentials: {
        accessToken: 'upstream-access',
        refreshToken: 'upstream-refresh',
        expiresAt: Date.now() + 3_600_000,
        accountId: 'account',
        planType: 'plus',
        email: 'fake@example.invalid',
        updatedAt: new Date().toISOString(),
      },
      enabled: false,
    });
    const body = await (await routes.request('/', { method: 'GET' })).json();
    const models = body.model_configs.find(
      (item: any) => item.id === chatGpt.id,
    ).models;
    // The account catalog: verified efforts, window unknown.
    expect(models).toContainEqual(
      expect.objectContaining({
        id: 'gpt-6-sol',
        contextWindow: null,
        effortsSource: 'registry',
      }),
    );
    expect(models.every((model: any) => !('hidden' in model))).toBe(true);

    const bound = await send('POST', '/', {
      name: 'ChatGPT Model Agent',
      model_config_id: chatGpt.id,
      model: 'gpt-6-sol',
    });
    expect(bound.status).toBe(201);
    expect(bound.body.profile.model).toBe('gpt-6-sol');
    const refused = await send('POST', '/', {
      name: 'Imaginary Model Agent',
      model_config_id: chatGpt.id,
      model: 'gpt-0-imaginary',
    });
    expect(refused).toMatchObject({
      status: 400,
      body: { code: 'MODEL_NOT_IN_CONNECTION' },
    });
  });

  test('POST accepts a model of the configuration, hidden ones included', async () => {
    const hidden = await send('POST', '/', {
      name: 'Hidden Model Agent',
      model_config_id: listed.id,
      model: 'list-old',
    });
    expect(hidden.status).toBe(201);
    expect(hidden.body.profile).toMatchObject({
      model_config_id: listed.id,
      model: 'list-old',
    });

    const before = db.listAgentProfilesForUser('routes-agent-user').length;
    const unlisted = await send('POST', '/', {
      name: 'Unlisted Model Agent',
      model_config_id: listed.id,
      model: 'other-default',
    });
    expect(unlisted).toMatchObject({
      status: 400,
      body: { code: 'MODEL_NOT_IN_CONNECTION' },
    });
    expect(unlisted.body.error).toContain('other-default');
    const unbound = await send('POST', '/', {
      name: 'Unbound Model Agent',
      model: 'list-fast',
    });
    expect(unbound).toMatchObject({
      status: 400,
      body: { code: 'MODEL_NOT_IN_CONNECTION' },
    });
    expect(db.listAgentProfilesForUser('routes-agent-user')).toHaveLength(
      before,
    );
  });

  test('sub-agent models must be models of the Agent’s connection', async () => {
    const subagents = (model: string) => ({
      model,
      definitions: [
        {
          name: 'reviewer',
          description: 'Reviews diffs',
          prompt: 'Review.',
          model,
        },
      ],
    });
    const created = await send('POST', '/', {
      name: 'Sub-agent Agent',
      model_config_id: listed.id,
      runtime_policy: { subagents: subagents('list-fast') },
    });
    expect(created.status).toBe(201);
    expect(created.body.profile.runtime_policy.subagents).toMatchObject({
      model: 'list-fast',
      definitions: [{ name: 'reviewer', model: 'list-fast' }],
    });

    const refused = await send('POST', '/', {
      name: 'Foreign Sub-agent Agent',
      model_config_id: listed.id,
      runtime_policy: { subagents: subagents('other-default') },
    });
    expect(refused).toMatchObject({
      status: 400,
      body: { code: 'SUBAGENT_MODEL_NOT_IN_CONNECTION' },
    });
    const unbound = await send('POST', '/', {
      name: 'Unbound Sub-agent Agent',
      runtime_policy: { subagents: subagents('list-fast') },
    });
    expect(unbound.body.code).toBe('SUBAGENT_MODEL_NOT_IN_CONNECTION');

    // Moving to another connection would strand them: refused until cleared.
    const at = `/${created.body.profile.id}`;
    const moved = await send('PATCH', at, { model_config_id: null });
    expect(moved.body.code).toBe('SUBAGENT_MODEL_NOT_IN_CONNECTION');
    const cleared = await send('PATCH', at, {
      model_config_id: null,
      runtime_policy: { subagents: null },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.profile.runtime_policy.subagents).toBeUndefined();
  });

  test('PATCH checks a model against the configuration it will belong to', async () => {
    const created = (
      await send('POST', '/', {
        name: 'Patched Model Agent',
        model_config_id: listed.id,
      })
    ).body.profile;
    expect(created.model).toBeNull();
    const at = `/${created.id}`;

    // Only a model: the Agent's current configuration decides.
    const fast = await send('PATCH', at, { model: 'list-fast' });
    expect(fast.status).toBe(200);
    expect(fast.body.profile).toMatchObject({
      model: 'list-fast',
      version: created.version + 1,
    });
    expect(await send('PATCH', at, { model: 'other-default' })).toMatchObject({
      status: 400,
      body: { code: 'MODEL_NOT_IN_CONNECTION' },
    });
    // With a new configuration, that one decides.
    expect(
      await send('PATCH', at, {
        model_config_id: other.id,
        model: 'list-fast',
      }),
    ).toMatchObject({ status: 400, body: { code: 'MODEL_NOT_IN_CONNECTION' } });
    const moved = await send('PATCH', at, {
      model_config_id: other.id,
      model: 'other-default',
    });
    expect(moved.body.profile).toMatchObject({
      model_config_id: other.id,
      model: 'other-default',
    });
    // Another configuration without a model starts from its default.
    const back = await send('PATCH', at, { model_config_id: listed.id });
    expect(back.body.profile).toMatchObject({
      model_config_id: listed.id,
      model: null,
    });
    // Null clears; a model needs a configuration.
    await send('PATCH', at, { model: 'list-old' });
    const cleared = await send('PATCH', at, { model: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.profile.model).toBeNull();
    await send('PATCH', at, { model_config_id: null });
    expect(await send('PATCH', at, { model: 'list-fast' })).toMatchObject({
      status: 400,
      body: { code: 'MODEL_NOT_IN_CONNECTION' },
    });
  });

  test('a model change quiesces the Agent workspaces like a configuration change', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Warm Model Agent',
      modelConfigId: listed.id,
    });
    const folder = 'warm-model-workspace';
    db.setRegisteredGroup('web:warm-model-workspace', {
      name: 'Warm Model Workspace',
      folder,
      added_at: '2026-10-28T00:00:00.000Z',
      created_by: 'routes-agent-user',
    });
    db.assignWorkspaceAgentProfile(folder, profile.id);

    const stopGroup = vi.fn(async () => {});
    webContext.setWebDeps({
      queue: {
        pauseGroupsForMutation: () => ({ id: 1 }),
        resumeGroupsAfterMutation: () => {},
        listDescendantJids: () => [],
        getStatus: () => ({ groups: [] }),
        stopGroup,
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    const changed = await send('PATCH', `/${profile.id}`, {
      model: 'list-fast',
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({
      invalidated_runtime_jids: 1,
      profile: { model: 'list-fast', version: profile.version + 1 },
    });
    expect(stopGroup).toHaveBeenCalled();

    stopGroup.mockClear();
    const same = await send('PATCH', `/${profile.id}`, { model: 'list-fast' });
    expect(same.body).toMatchObject({
      invalidated_runtime_jids: 0,
      profile: { version: profile.version + 1 },
    });
    expect(stopGroup).not.toHaveBeenCalled();
  });
});
