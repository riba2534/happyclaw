import Database from 'better-sqlite3';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-agent-mgmt-'));
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

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    const id = c.req.header('x-test-user') ?? MEMBER;
    c.set('user', {
      id,
      username: id,
      role: id === ADMIN ? 'admin' : 'member',
      permissions: [],
    });
    return next();
  },
}));

const MEMBER = 'mgmt-member';
const ADMIN = 'mgmt-admin';
const OTHER = 'mgmt-other';

const db = await import('../src/db.js');
const runtimeConfig = await import('../src/runtime-config.js');
const webContext = await import('../src/web-context.js');
const routes = (await import('../src/routes/agent-profiles.js')).default;

function seedUser(id: string, role: 'admin' | 'member'): void {
  const now = new Date().toISOString();
  db.createUser({
    id,
    username: id,
    password_hash: 'hash',
    display_name: id,
    role,
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
}

function seedSkill(owner: string, id: string): void {
  const dir = path.join(tmpDataDir, 'skills', owner, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${id}\ndescription: ${id}\n---\n`,
  );
}

function seedUserMcp(owner: string, ids: string[]): void {
  const dir = path.join(tmpDataDir, 'mcp-servers', owner);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'servers.json'),
    JSON.stringify({
      servers: Object.fromEntries(
        ids.map((id) => [
          id,
          { command: 'node', enabled: true, addedAt: '2026-10-01T00:00:00Z' },
        ]),
      ),
    }),
  );
}

function call(
  url: string,
  options: { method?: string; body?: unknown; user?: string } = {},
) {
  return routes.request(url, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      'x-test-user': options.user ?? MEMBER,
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

function registerWorkspace(folder: string, owner: string, profileId: string) {
  db.setRegisteredGroup(`web:${folder}`, {
    name: folder,
    folder,
    added_at: '2026-10-01T00:00:00.000Z',
    created_by: owner,
  });
  db.assignWorkspaceAgentProfile(folder, profileId);
}

function fakeQueue(overrides: Record<string, unknown> = {}) {
  const stopGroup = vi.fn(async () => {});
  webContext.setWebDeps({
    queue: {
      pauseGroupsForMutation: () => ({ keys: [] }),
      resumeGroupsAfterMutation: () => {},
      listDescendantJids: () => [],
      getStatus: () => ({ groups: [] }),
      stopGroup,
      ...overrides,
    },
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
  return stopGroup;
}

beforeAll(() => {
  db.initDatabase();
  seedUser(MEMBER, 'member');
  seedUser(ADMIN, 'admin');
  seedUser(OTHER, 'member');
  seedSkill(MEMBER, 'research');
  seedUserMcp(MEMBER, ['github']);
});

beforeEach(() => {
  fakeQueue();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Agent names', () => {
  test('are unique per owner after NFKC folding and case, the built-in HappyClaw included', async () => {
    const created = await call('/', {
      method: 'POST',
      body: { name: 'Reviewer' },
    });
    expect(created.status).toBe(201);
    const reviewer = (await created.json()).profile;

    for (const name of [
      'reviewer',
      ' REVIEWER ',
      'Ｒｅｖｉｅｗｅｒ',
      'happyclaw',
    ]) {
      const res = await call('/', { method: 'POST', body: { name } });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'AGENT_NAME_TAKEN',
        field: 'name',
      });
    }
    // Another owner may use the same name.
    const other = await call('/', {
      method: 'POST',
      body: { name: 'Reviewer' },
      user: OTHER,
    });
    expect(other.status).toBe(201);

    const second = (
      await (
        await call('/', { method: 'POST', body: { name: 'Second' } })
      ).json()
    ).profile;
    const rename = await call(`/${second.id}`, {
      method: 'PATCH',
      body: { name: 'REVIEWER' },
    });
    expect(rename.status).toBe(409);
    expect(db.getAgentProfile(second.id)?.name).toBe('Second');

    // Renaming to its own name in another case is not a conflict.
    const recase = await call(`/${reviewer.id}`, {
      method: 'PATCH',
      body: { name: 'reviewer' },
    });
    expect(recase.status).toBe(200);
  });

  test('an existing duplicate name does not block other edits', async () => {
    const a = db.createAgentProfile({ ownerUserId: MEMBER, name: 'Twin' });
    const b = db.createAgentProfile({ ownerUserId: MEMBER, name: 'Twin B' });
    // Saved before names had to be unique.
    const raw = new Database(path.join(tmpStoreDir, 'messages.db'));
    raw
      .prepare('UPDATE agent_profiles SET name = ? WHERE id = ?')
      .run('twin', b.id);
    raw.close();
    const res = await call(`/${b.id}`, {
      method: 'PATCH',
      body: { agents_prompt: 'Still allowed', prompt_schema_version: 2 },
    });
    expect(res.status).toBe(200);
    expect(a.id).not.toBe(b.id);
  });

  test('every write path refuses a taken name, not only the routes', () => {
    db.createAgentProfile({ ownerUserId: MEMBER, name: 'Guarded' });
    expect(() =>
      db.createAgentProfile({ ownerUserId: MEMBER, name: 'GUARDED' }),
    ).toThrow(db.AgentProfileNameTakenError);
    expect(() =>
      db.createAgentProfile({ ownerUserId: MEMBER, name: 'HappyClaw' }),
    ).toThrow(db.AgentProfileNameTakenError);
    const other = db.createAgentProfile({
      ownerUserId: MEMBER,
      name: 'Guarded Two',
    });
    expect(() =>
      db.updateAgentProfile(other.id, MEMBER, { name: 'guarded' }),
    ).toThrow(db.AgentProfileNameTakenError);
    expect(db.getAgentProfile(other.id)?.name).toBe('Guarded Two');
  });

  test('invisible characters neither pass validation nor dodge the check', async () => {
    for (const name of [
      'Re\u200bviewer',
      'Rev\u00adiewer',
      'Re\u2060view',
      'Re\ufeffviewer',
      'Re\u180eviewer',
      'Re\u034fviewer',
      'Reviewer \u202egnp.exe',
      'Re\u2066viewer\u2069',
    ]) {
      const res = await call('/', { method: 'POST', body: { name } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: '名称不能包含不可见字符',
        code: 'INVALID_NAME',
        field: 'name',
      });
    }
    const target = db.createAgentProfile({
      ownerUserId: MEMBER,
      name: 'Visible',
    });
    const rename = await call(`/${target.id}`, {
      method: 'PATCH',
      body: { name: 'Visi\u202able 2' },
    });
    expect(await rename.json()).toMatchObject({ code: 'INVALID_NAME' });
    // A stored or Builder-written name with them still collides.
    expect(
      db.findAgentProfileNameConflict(MEMBER, 'Vis\u00adible'),
    ).toMatchObject({ id: target.id });
    expect(
      db.findAgentProfileNameConflict(MEMBER, 'Happy\u200bClaw'),
    ).toMatchObject({ name: 'HappyClaw' });
  });
});

describe('field-level validation errors', () => {
  test('emoji names keep their joiners and variation selectors, through export and import', async () => {
    for (const name of ['❤️ 助手', '👨‍💻 Coder', '☺︎ Plain']) {
      const res = await call('/', { method: 'POST', body: { name } });
      expect(res.status).toBe(201);
      const created = (await res.json()).profile;
      expect(created.name).toBe(name);
      const exported = await (await call(`/${created.id}/export`)).json();
      expect(exported.agent.name).toBe(name);
      const imported = await call('/import', {
        method: 'POST',
        body: { data: exported, name: `${name} 2` },
      });
      expect(imported.status).toBe(201);
      expect((await imported.json()).profile.name).toBe(`${name} 2`);
    }
    // Uniqueness still ignores the joiners and selectors.
    expect(db.findAgentProfileNameConflict(MEMBER, '❤ 助手')).toMatchObject({
      name: '❤️ 助手',
    });
  });

  test('a name with nothing visible in it is refused', async () => {
    for (const name of ['\u200d', '\ufe0f\u200d', '\u3164']) {
      const res = await call('/', { method: 'POST', body: { name } });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: '名称至少需要一个可见字符',
        code: 'INVALID_NAME',
        field: 'name',
      });
    }
  });

  test('name the prompt section that is over the limit', async () => {
    const res = await call('/', {
      method: 'POST',
      body: { name: 'Too Long', soul_prompt: 'x'.repeat(20001) },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: '人格与表达（SOUL）超过 20000 字上限（当前 20001 字）',
      code: 'PROMPT_TOO_LONG',
      field: 'soul_prompt',
      max: 20000,
    });

    const profile = db.createAgentProfile({
      ownerUserId: MEMBER,
      name: 'Limit',
    });
    const patch = await call(`/${profile.id}`, {
      method: 'PATCH',
      body: { tools_prompt: 'y'.repeat(20001) },
    });
    expect(patch.status).toBe(400);
    expect(await patch.json()).toMatchObject({
      code: 'PROMPT_TOO_LONG',
      field: 'tools_prompt',
    });

    const name = await call('/', {
      method: 'POST',
      body: { name: 'n'.repeat(81) },
    });
    expect(await name.json()).toMatchObject({
      code: 'INVALID_NAME',
      field: 'name',
    });
  });
});

describe('POST /:id/duplicate', () => {
  test('copies identity, prompts, policy, model binding and avatar into a new Agent', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'Copy connection',
      type: 'third_party',
      anthropicBaseUrl: 'https://copy.example.test',
      anthropicAuthToken: 'copy-token',
      anthropicModel: 'copy-model',
      models: [{ id: 'copy-model', efforts: ['low', 'high'] }],
      enabled: true,
    });
    const source = db.createAgentProfile({
      ownerUserId: MEMBER,
      name: 'Researcher',
      identityPrompt: 'I',
      soulPrompt: 'S',
      agentsPrompt: 'A',
      toolsPrompt: 'T',
      promptMode: 'replace',
      avatarEmoji: '🔬',
      avatarColor: '#123456',
      modelConfigId: provider.id,
      runtimePolicy: {
        reasoning: { effort: 'high' },
        skills: { mode: 'custom', ids: ['research'] },
        mcp: { mode: 'custom', ids: ['user:github'] },
      },
    });
    const avatarsDir = path.join(tmpDataDir, 'avatars');
    fs.mkdirSync(avatarsDir, { recursive: true });
    const avatarFile = `agent-profile-${source.id}-abcd1234.png`;
    fs.writeFileSync(path.join(avatarsDir, avatarFile), 'png-bytes');
    db.updateAgentProfile(source.id, MEMBER, {
      avatarUrl: `/api/auth/avatars/${avatarFile}`,
    });
    registerWorkspace('duplicate-source-ws', MEMBER, source.id);

    const res = await call(`/${source.id}/duplicate`, { method: 'POST' });
    expect(res.status).toBe(201);
    const body = await res.json();
    const copy = body.profile;
    expect(body.stripped).toEqual([]);
    expect(copy.id).not.toBe(source.id);
    expect(copy).toMatchObject({
      name: 'Researcher 副本',
      identity_prompt: 'I',
      soul_prompt: 'S',
      agents_prompt: 'A',
      tools_prompt: 'T',
      prompt_mode: 'replace',
      avatar_emoji: '🔬',
      avatar_color: '#123456',
      model_config_id: provider.id,
      runtime_policy: source.runtime_policy,
      version: 1,
    });
    expect(copy.avatar_url).toMatch(
      new RegExp(
        `^/api/auth/avatars/agent-profile-${copy.id}-[0-9a-f]{8}\\.png$`,
      ),
    );
    expect(
      fs.readFileSync(
        path.join(avatarsDir, path.basename(copy.avatar_url)),
        'utf8',
      ),
    ).toBe('png-bytes');
    // Workspaces and channels stay with the source.
    const governance = await (await call(`/${copy.id}/workspaces`)).json();
    expect(governance.workspaces).toEqual([]);

    const again = await (
      await call(`/${source.id}/duplicate`, { method: 'POST' })
    ).json();
    expect(again.profile.name).toBe('Researcher 副本 2');
  });

  test('drops host grants for a member, refuses the built-in, hides other owners', async () => {
    // Saved while the owner was an admin.
    const source = db.createAgentProfile({
      ownerUserId: MEMBER,
      name: 'Former Admin Agent',
      runtimePolicy: {
        context: { source: 'host_claude' },
        skills: { host: { mode: 'inherit', ids: [] } },
      },
    });
    const res = await call(`/${source.id}/duplicate`, { method: 'POST' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.stripped).toEqual(['host_context', 'host_skills']);
    expect(body.profile.runtime_policy.context.source).toBe('managed');
    expect(body.profile.runtime_policy.skills.host).toEqual({
      mode: 'disabled',
      ids: [],
    });

    const builtIn = db.getOrCreateDefaultAgentProfile(MEMBER);
    expect(
      (await call(`/${builtIn.id}/duplicate`, { method: 'POST' })).status,
    ).toBe(400);
    expect(
      (await call(`/${source.id}/duplicate`, { method: 'POST', user: OTHER }))
        .status,
    ).toBe(404);
  });
});

describe('export and import', () => {
  test('exports a portable document without the model binding', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'Export connection',
      type: 'third_party',
      anthropicBaseUrl: 'https://export.example.test',
      anthropicAuthToken: 'export-token',
      anthropicModel: 'export-model',
      enabled: true,
    });
    const profile = db.createAgentProfile({
      ownerUserId: MEMBER,
      name: 'Exported',
      agentsPrompt: 'Do the work.',
      avatarEmoji: '📦',
      modelConfigId: provider.id,
      runtimePolicy: { mcp: { mode: 'custom', ids: ['github'] } },
    });
    const res = await call(`/${profile.id}/export`);
    expect(res.status).toBe(200);
    const document = await res.json();
    expect(document).toMatchObject({
      format: 'happyclaw-agent',
      version: 1,
      agent: {
        name: 'Exported',
        agents_prompt: 'Do the work.',
        avatar_emoji: '📦',
        prompt_mode: 'append',
        runtime_policy: {
          skills: { mode: 'inherit', ids: [], host: { mode: 'disabled' } },
          // Bare legacy ids leave with their scope.
          mcp: { mode: 'custom', ids: ['user:github'] },
        },
      },
    });
    const text = JSON.stringify(document);
    expect(text).not.toContain(provider.id);
    expect(text).not.toContain('model_config_id');
    expect(text).not.toContain('export-token');

    expect((await call(`/${profile.id}/export`, { user: OTHER })).status).toBe(
      404,
    );
    const builtIn = db.getOrCreateDefaultAgentProfile(MEMBER);
    expect((await call(`/${builtIn.id}/export`)).status).toBe(400);
  });

  test('imports, asks before dropping missing Skills and MCP, and strips host grants for members', async () => {
    const document = {
      format: 'happyclaw-agent',
      version: 1,
      agent: {
        name: 'Imported',
        identity_prompt: 'Imported identity',
        prompt_mode: 'replace',
        runtime_policy: {
          context: { source: 'host_claude' },
          skills: {
            mode: 'custom',
            ids: ['research', 'not-installed'],
            host: { mode: 'custom', ids: ['host-only'] },
          },
          mcp: { mode: 'custom', ids: ['user:github', 'user:missing-mcp'] },
        },
      },
    };
    const first = await call('/import', {
      method: 'POST',
      body: { data: document },
    });
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({
      code: 'AGENT_IMPORT_MISSING_REFERENCES',
      missing: {
        skills: ['not-installed'],
        host_skills: [],
        mcp: ['user:missing-mcp'],
      },
      stripped: ['host_context', 'host_skills'],
    });
    expect(
      db.listAgentProfilesForUser(MEMBER).some((p) => p.name === 'Imported'),
    ).toBe(false);

    const confirmed = await call('/import', {
      method: 'POST',
      body: { data: document, drop_missing: true },
    });
    expect(confirmed.status).toBe(201);
    const body = await confirmed.json();
    expect(body.stripped).toEqual(['host_context', 'host_skills']);
    expect(body.dropped).toEqual({
      skills: ['not-installed'],
      host_skills: [],
      mcp: ['user:missing-mcp'],
    });
    expect(body.profile).toMatchObject({
      name: 'Imported',
      identity_prompt: 'Imported identity',
      prompt_mode: 'replace',
      model_config_id: null,
      runtime_policy: {
        context: { source: 'managed' },
        skills: {
          mode: 'custom',
          ids: ['research'],
          host: { mode: 'disabled', ids: [] },
        },
        mcp: { mode: 'custom', ids: ['user:github'] },
      },
    });

    const taken = await call('/import', {
      method: 'POST',
      body: { data: document, drop_missing: true },
    });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ code: 'AGENT_NAME_TAKEN' });
    const renamed = await call('/import', {
      method: 'POST',
      body: { data: document, drop_missing: true, name: 'Imported 2' },
    });
    expect(renamed.status).toBe(201);
  });

  test('a custom selection left empty after dropping turns that source off', async () => {
    const res = await call('/import', {
      method: 'POST',
      body: {
        drop_missing: true,
        data: {
          format: 'happyclaw-agent',
          version: 1,
          agent: {
            name: 'Nothing Left',
            runtime_policy: { skills: { mode: 'custom', ids: ['gone'] } },
          },
        },
      },
    });
    expect(res.status).toBe(201);
    expect((await res.json()).profile.runtime_policy.skills).toMatchObject({
      mode: 'disabled',
      ids: [],
    });
  });

  test('rejects other files and versions', async () => {
    const wrong = await call('/import', {
      method: 'POST',
      body: { data: { format: 'something-else', version: 1, agent: {} } },
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ code: 'INVALID_AGENT_EXPORT' });
    const newer = await call('/import', {
      method: 'POST',
      body: { data: { format: 'happyclaw-agent', version: 2, agent: {} } },
    });
    expect(await newer.json()).toMatchObject({
      code: 'UNSUPPORTED_AGENT_EXPORT_VERSION',
    });
    const retired = await call('/import', {
      method: 'POST',
      body: {
        data: {
          format: 'happyclaw-agent',
          version: 1,
          agent: { name: 'Tools', runtime_policy: { tools: { mode: 'x' } } },
        },
      },
    });
    expect(retired.status).toBe(400);
  });

  test('an admin keeps host grants on import only after confirming them', async () => {
    const data = {
      format: 'happyclaw-agent',
      version: 1,
      agent: {
        name: 'Admin Host Agent',
        runtime_policy: {
          context: { source: 'host_claude' },
          skills: { host: { mode: 'inherit', ids: [] } },
        },
      },
    };
    const unconfirmed = await call('/import', {
      method: 'POST',
      user: ADMIN,
      body: { data },
    });
    expect(unconfirmed.status).toBe(409);
    expect(await unconfirmed.json()).toMatchObject({
      code: 'AGENT_IMPORT_HOST_GRANTS',
      grants: ['host_context', 'host_skills'],
    });
    expect(
      db.findAgentProfileNameConflict(ADMIN, 'Admin Host Agent'),
    ).toBeUndefined();

    const res = await call('/import', {
      method: 'POST',
      user: ADMIN,
      body: { data, confirm_host_grants: true },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.stripped).toEqual([]);
    expect(body.profile.runtime_policy).toMatchObject({
      context: { source: 'host_claude' },
      skills: { host: { mode: 'inherit', ids: [] } },
    });
  });
});

describe('POST /:id/migrate-and-delete', () => {
  test('moves every Workspace to the target and archives the Agent', async () => {
    const source = db.createAgentProfile({
      ownerUserId: MEMBER,
      name: 'Retire Me',
    });
    const target = db.createAgentProfile({ ownerUserId: MEMBER, name: 'Heir' });
    registerWorkspace('retire-a', MEMBER, source.id);
    registerWorkspace('retire-b', MEMBER, source.id);
    const stopGroup = fakeQueue();

    const res = await call(`/${source.id}/migrate-and-delete`, {
      method: 'POST',
      body: { target_agent_profile_id: target.id },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      migrated_workspaces: 2,
    });
    expect(db.getWorkspaceAgentProfileId('retire-a')).toBe(target.id);
    expect(db.getWorkspaceAgentProfileId('retire-b')).toBe(target.id);
    expect(db.getAgentProfileForUser(source.id, MEMBER)).toBeUndefined();
    // Runners were stopped before and after the commit.
    expect(stopGroup).toHaveBeenCalledWith('web:retire-a', expect.anything());
  });

  test('moves nothing when the archive is refused', async () => {
    const source = db.createAgentProfile({
      ownerUserId: MEMBER,
      name: 'Refused Retiree',
    });
    const target = db.createAgentProfile({
      ownerUserId: MEMBER,
      name: 'Refused Heir',
    });
    registerWorkspace('refused-retire-a', MEMBER, source.id);
    registerWorkspace('refused-retire-b', MEMBER, source.id);
    // A legacy mapping from a Workspace this owner does not own still names
    // the Agent, so archiving it must fail after both moves were written.
    registerWorkspace('refused-foreign', OTHER, source.id);

    const res = await call(`/${source.id}/migrate-and-delete`, {
      method: 'POST',
      body: { target_agent_profile_id: target.id },
    });
    expect(res.status).toBe(409);
    expect(db.getWorkspaceAgentProfileId('refused-retire-a')).toBe(source.id);
    expect(db.getWorkspaceAgentProfileId('refused-retire-b')).toBe(source.id);
    expect(db.getAgentProfileForUser(source.id, MEMBER)).toBeDefined();
  });

  test('validates the target and refuses the built-in', async () => {
    const source = db.createAgentProfile({
      ownerUserId: MEMBER,
      name: 'Lonely',
    });
    const foreign = db.createAgentProfile({
      ownerUserId: OTHER,
      name: 'Foreign',
    });
    const builtIn = db.getOrCreateDefaultAgentProfile(MEMBER);
    const post = (id: string, target: string, user?: string) =>
      call(`/${id}/migrate-and-delete`, {
        method: 'POST',
        body: { target_agent_profile_id: target },
        user,
      });
    expect((await post(source.id, source.id)).status).toBe(400);
    expect((await post(source.id, foreign.id)).status).toBe(404);
    expect((await post(source.id, builtIn.id, OTHER)).status).toBe(404);
    expect((await post(builtIn.id, source.id)).status).toBe(400);
    // An Agent without Workspaces is simply archived.
    expect((await post(source.id, builtIn.id)).status).toBe(200);
    expect(db.getAgentProfileForUser(source.id, MEMBER)).toBeUndefined();
  });

  test('a failed pre-commit stop changes nothing', async () => {
    const source = db.createAgentProfile({
      ownerUserId: MEMBER,
      name: 'Busy Retiree',
    });
    const target = db.createAgentProfile({
      ownerUserId: MEMBER,
      name: 'Busy Heir',
    });
    registerWorkspace('busy-retire', MEMBER, source.id);
    fakeQueue({
      stopGroup: vi.fn(async () => {
        throw new Error('runner refused to stop');
      }),
    });
    const res = await call(`/${source.id}/migrate-and-delete`, {
      method: 'POST',
      body: { target_agent_profile_id: target.id },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ persisted: false });
    expect(db.getWorkspaceAgentProfileId('busy-retire')).toBe(source.id);
    expect(db.getAgentProfileForUser(source.id, MEMBER)).toBeDefined();
  });

  test('a refused commit rolls back without running post-commit stop or reporting persisted: true', async () => {
    const source = db.createAgentProfile({
      ownerUserId: MEMBER,
      name: 'Rollback Retiree',
    });
    const target = db.createAgentProfile({
      ownerUserId: MEMBER,
      name: 'Rollback Heir',
    });
    registerWorkspace('rollback-own-ws', MEMBER, source.id);
    // Foreign workspace keeps a mapping to `source`, so archive is refused
    // inside `commit` with `'has_workspaces'`.
    registerWorkspace('rollback-foreign-ws', OTHER, source.id);

    let stopCalls = 0;
    const blockGroupsForRuntimeSafety = vi.fn();
    fakeQueue({
      stopGroup: vi.fn(async () => {
        stopCalls++;
        if (stopCalls > 1) {
          throw new Error('post-commit stop should never run after rollback');
        }
      }),
      blockGroupsForRuntimeSafety,
    });

    const res = await call(`/${source.id}/migrate-and-delete`, {
      method: 'POST',
      body: { target_agent_profile_id: target.id },
    });
    expect(res.status).toBe(409);
    expect(stopCalls).toBe(1);
    expect(blockGroupsForRuntimeSafety).not.toHaveBeenCalled();
    expect(db.getWorkspaceAgentProfileId('rollback-own-ws')).toBe(source.id);
    expect(db.getAgentProfileForUser(source.id, MEMBER)).toBeDefined();
  });
});

describe('governance and capability preview', () => {
  test('counts the conversations a restart would interrupt', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: MEMBER,
      name: 'Busy',
    });
    registerWorkspace('busy-ws', MEMBER, profile.id);
    registerWorkspace('idle-ws', MEMBER, profile.id);
    fakeQueue({
      listDescendantJids: (jid: string) =>
        jid === 'web:busy-ws' ? ['web:busy-ws#agent:s1'] : [],
      getStatus: () => ({
        groups: [
          {
            jid: 'web:busy-ws',
            queryInFlight: true,
            pendingMessages: false,
            pendingTasks: 0,
          },
          {
            jid: 'web:busy-ws#agent:s1',
            queryInFlight: false,
            pendingMessages: true,
            pendingTasks: 0,
          },
          // A warm runner waiting for input is not interrupted by a restart.
          {
            jid: 'web:idle-ws',
            queryInFlight: false,
            pendingMessages: false,
            pendingTasks: 0,
            active: true,
          },
        ],
      }),
    });
    const body = await (await call(`/${profile.id}/workspaces`)).json();
    const byJid = Object.fromEntries(
      body.workspaces.map((w: any) => [w.jid, w.active_conversations]),
    );
    expect(byJid).toEqual({ 'web:busy-ws': 2, 'web:idle-ws': 0 });
  });

  test('reports which connection and model a run uses and why', async () => {
    const bound = runtimeConfig.createProvider({
      name: 'Bound connection',
      type: 'third_party',
      anthropicBaseUrl: 'https://bound.example.test',
      anthropicAuthToken: 'bound-token',
      anthropicModel: 'bound-default',
      models: [{ id: 'bound-default' }, { id: 'bound-large' }],
      enabled: true,
    });
    const profile = db.createAgentProfile({
      ownerUserId: MEMBER,
      name: 'Model Bound',
      modelConfigId: bound.id,
      model: 'bound-large',
    });
    const preview = async (id: string, workspace?: string) =>
      (
        await (
          await call(`/${id}/effective-capabilities`, {
            method: 'POST',
            body: workspace ? { workspace_jid: workspace } : {},
          })
        ).json()
      ).model_resolution;

    expect(await preview(profile.id)).toEqual({
      source: 'agent',
      model_config_id: bound.id,
      model_config_name: 'Bound connection',
      model: 'bound-large',
      effort: null,
      connection_missing: false,
    });

    // An unbound Agent follows its owner's main Agent.
    const main = db.getOrCreateDefaultAgentProfile(MEMBER);
    db.updateAgentProfile(main.id, MEMBER, { modelConfigId: bound.id });
    const unbound = db.createAgentProfile({
      ownerUserId: MEMBER,
      name: 'Unbound',
    });
    expect(await preview(unbound.id)).toEqual({
      source: 'owner_main',
      model_config_id: bound.id,
      model_config_name: 'Bound connection',
      model: 'bound-default',
      effort: null,
      connection_missing: false,
    });

    // A workspace has no pick of its own: the preview is what a session that
    // picked nothing runs, whatever a pre-v88 workspace-level row says.
    registerWorkspace('picked-ws', MEMBER, unbound.id);
    db.setSessionModelSelection('picked-ws', null, bound.id, MEMBER, {
      model: 'bound-large',
    });
    expect(await preview(unbound.id, 'web:picked-ws')).toMatchObject({
      source: 'owner_main',
      model: 'bound-default',
    });
    db.updateAgentProfile(main.id, MEMBER, { modelConfigId: null });
  });

  test('resolves the unsaved binding of the same preview and flags a deleted connection', async () => {
    const saved = runtimeConfig.createProvider({
      name: 'Saved connection',
      type: 'third_party',
      anthropicBaseUrl: 'https://saved.example.test',
      anthropicAuthToken: 'saved-token',
      anthropicModel: 'saved-default',
      models: [{ id: 'saved-default' }, { id: 'saved-large' }],
      enabled: true,
    });
    const draft = runtimeConfig.createProvider({
      name: 'Draft connection',
      type: 'third_party',
      anthropicBaseUrl: 'https://draft.example.test',
      anthropicAuthToken: 'draft-token',
      anthropicModel: 'draft-default',
      models: [{ id: 'draft-default' }, { id: 'draft-fast' }],
      enabled: true,
    });
    const profile = db.createAgentProfile({
      ownerUserId: MEMBER,
      name: 'Unsaved Binding',
      modelConfigId: saved.id,
      model: 'saved-large',
    });
    const resolve = async (body: Record<string, unknown>) => {
      const res = await call(`/${profile.id}/effective-capabilities`, {
        method: 'POST',
        body,
      });
      return { status: res.status, body: await res.json() };
    };

    expect(
      (await resolve({ model_config_id: draft.id, model: 'draft-fast' })).body
        .model_resolution,
    ).toMatchObject({
      source: 'agent',
      model_config_id: draft.id,
      model: 'draft-fast',
    });
    // A new configuration without a model runs that configuration's default.
    expect(
      (await resolve({ model_config_id: draft.id })).body.model_resolution,
    ).toMatchObject({ model_config_id: draft.id, model: 'draft-default' });
    // Only the model changed: the saved configuration stays.
    expect(
      (await resolve({ model: 'saved-default' })).body.model_resolution,
    ).toMatchObject({ model_config_id: saved.id, model: 'saved-default' });
    expect((await resolve({ model_config_id: 42 })).status).toBe(400);

    expect(
      (await resolve({ model_config_id: 'deleted-connection', model: null }))
        .body.model_resolution,
    ).toEqual({
      // A set binding is authoritative: runs fail until it is chosen again.
      source: 'agent',
      model_config_id: 'deleted-connection',
      model_config_name: null,
      model: null,
      effort: null,
      connection_missing: true,
    });
  });

  test('a scoped MCP reference with a 128-character id survives export and import', async () => {
    const longId = `m${'x'.repeat(127)}`;
    seedUserMcp(ADMIN, [longId]);
    const source = db.createAgentProfile({
      ownerUserId: ADMIN,
      name: 'Long MCP',
      runtimePolicy: { mcp: { mode: 'custom', ids: [longId] } },
    });
    const exported = await (
      await call(`/${source.id}/export`, { user: ADMIN })
    ).json();
    expect(exported.agent.runtime_policy.mcp.ids).toEqual([`user:${longId}`]);
    const imported = await call('/import', {
      method: 'POST',
      user: ADMIN,
      body: { data: exported, name: 'Long MCP 2' },
    });
    expect(imported.status).toBe(201);
    expect((await imported.json()).profile.runtime_policy.mcp).toEqual({
      mode: 'custom',
      ids: [`user:${longId}`],
    });
    // The id itself is still capped.
    const tooLong = await call('/', {
      method: 'POST',
      user: ADMIN,
      body: {
        name: 'Too Long MCP',
        runtime_policy: {
          mcp: { mode: 'custom', ids: [`user:${'y'.repeat(129)}`] },
        },
      },
    });
    expect(tooLong.status).toBe(400);
  });
});
