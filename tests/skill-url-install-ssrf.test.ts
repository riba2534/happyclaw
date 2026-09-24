import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Hono } from 'hono';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-url-install-'));
const dataDir = path.join(root, 'data');
const groupsDir = path.join(root, 'groups');
const reposDir = path.join(root, 'repos');
const OWNER_ID = 'skills-owner';
const WORKSPACE_JID = 'web:skills-workspace';
const WORKSPACE_FOLDER = 'skills-workspace';

interface CliInvocation {
  via: 'spawn' | 'execFile';
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

const cli = vi.hoisted(() => ({
  invocations: [] as CliInvocation[],
  // `skills add` source argument -> local directory standing in for the clone.
  sources: new Map<string, string>(),
}));

/**
 * Stand-in for `npx skills add <source> --global`: it installs what the
 * source contains into $HOME/.claude/skills using the same naming rule as the
 * skills CLI (the sanitized SKILL.md `name`, never the clone directory).
 */
function runFakeSkillsAdd(
  args: string[],
  env: NodeJS.ProcessEnv,
): { code: number; stderr: string } {
  const source = args[args.indexOf('add') + 1];
  const sourceDir = cli.sources.get(source);
  if (!sourceDir || !env.HOME) {
    return { code: 1, stderr: `Failed to clone ${source}` };
  }
  const skillDirs = fs.existsSync(path.join(sourceDir, 'SKILL.md'))
    ? [sourceDir]
    : fs
        .readdirSync(sourceDir)
        .map((entry) => path.join(sourceDir, entry))
        .filter((dir) => fs.existsSync(path.join(dir, 'SKILL.md')));
  for (const dir of skillDirs) {
    const skillMd = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const name = /^name:\s*(.+)$/m.exec(skillMd)?.[1].trim() ?? '';
    const installName = name
      .toLowerCase()
      .replace(/[^a-z0-9._]+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '');
    fs.cpSync(dir, path.join(env.HOME, '.claude', 'skills', installName), {
      recursive: true,
    });
  }
  return { code: 0, stderr: '' };
}

function runFakeCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { code: number; stderr: string } {
  if (command === 'npx') return runFakeSkillsAdd(args, env);
  return { code: 127, stderr: `unexpected command: ${command}` };
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = (
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv } = {},
  ) => {
    const env = { ...(options.env ?? {}) };
    cli.invocations.push({ via: 'spawn', command, args: [...args], env });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: undefined,
      kill: () => true,
    });
    setImmediate(() => {
      const result = runFakeCommand(command, args, env);
      if (result.stderr) child.stderr.write(result.stderr);
      child.emit('close', result.code, null);
    });
    return child;
  };
  const execFile = (
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const env = { ...(options.env ?? {}) };
    cli.invocations.push({ via: 'execFile', command, args: [...args], env });
    setImmediate(() => {
      const result = runFakeCommand(command, args, env);
      callback(
        result.code === 0 ? null : new Error(result.stderr),
        '',
        result.stderr,
      );
    });
  };
  return { ...actual, spawn, execFile };
});
vi.mock('../src/config.js', () => ({
  DATA_DIR: dataDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/runtime-config.js', () => ({
  getEffectiveExternalDir: () => path.join(root, 'external'),
}));
vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: OWNER_ID, role: 'admin', permissions: [] });
    return next();
  },
}));
vi.mock('../src/db.js', () => {
  const workspace = {
    jid: WORKSPACE_JID,
    name: 'Skills Workspace',
    folder: WORKSPACE_FOLDER,
    added_at: new Date(0).toISOString(),
    executionMode: 'container',
    created_by: OWNER_ID,
    is_home: false,
  };
  return {
    deleteWorkspaceSessions: () => undefined,
    getAllUsers: () => [{ id: OWNER_ID, status: 'active' }],
    listAgentProfilesForUser: () => [],
    getJidsByFolder: () => [WORKSPACE_JID],
    getRegisteredGroup: (jid: string) =>
      jid === WORKSPACE_JID ? workspace : undefined,
  };
});
vi.mock('../src/web-context.js', () => ({
  getWebDeps: () => ({
    sessions: {},
    queue: {
      blockGroupsForRuntimeSafety: () => undefined,
      unblockGroupsForRuntimeSafety: () => undefined,
      isGroupRuntimeSafetyBlocked: () => false,
    },
  }),
}));
vi.mock('../src/agent-profile-runtime.js', () => {
  class WorkspaceRuntimeQuiesceError extends Error {
    persisted = false;
  }
  return {
    WorkspaceRuntimeQuiesceError,
    listWorkspaceGroupsForAgentProfile: () => [],
    getWorkspaceRuntimeJids: () => [],
    quiesceWorkspaceRunnersAroundCommit: async (
      _deps: unknown,
      _targets: unknown,
      _options: unknown,
      commit: () => Promise<unknown> | unknown,
    ) => ({ value: await commit(), runtimeJids: [] }),
  };
});

const { canonicalizeGitHubSkillUrl, SkillUrlRefusedError } =
  await import('../src/skill-import-service.js');
const skillsModule = await import('../src/routes/skills.js');
const workspaceConfigRoutes = (
  await import('../src/routes/workspace-config.js')
).default;
const app = new Hono()
  .route('/api/skills', skillsModule.default)
  .route('/api/groups', workspaceConfigRoutes);

const userSkillsDir = path.join(dataDir, 'skills', OWNER_ID);
const manifestPath = path.join(userSkillsDir, '.skills-manifest.json');
const workspaceSkillsDir = path.join(
  groupsDir,
  WORKSPACE_FOLDER,
  '.claude',
  'skills',
);

function writeSkill(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n`,
  );
}

function readManifest(): {
  skills: Record<string, { packageName?: string }>;
} {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

// Single-skill repositories keep SKILL.md at the repository root.
writeSkill(path.join(reposDir, 'alpha-skill'), 'alpha');
writeSkill(path.join(reposDir, 'beta-skill'), 'Beta Tool');
writeSkill(path.join(reposDir, 'pack', 'skills', 'gamma'), 'gamma');
writeSkill(path.join(reposDir, 'pack', 'skills', 'delta'), 'delta');
cli.sources.set(
  'https://github.com/acme/alpha-skill',
  path.join(reposDir, 'alpha-skill'),
);
cli.sources.set(
  'https://github.com/acme/beta-skill',
  path.join(reposDir, 'beta-skill'),
);
cli.sources.set(
  'https://github.com/acme/pack/tree/main/skills',
  path.join(reposDir, 'pack', 'skills'),
);

// Non-GitHub or non-canonical URL shapes that every install entry must refuse.
const REFUSED_URLS = [
  'https://skills.example.com/.well-known/skills',
  'https://github.com.example.net/acme/alpha-skill',
  'https://raw.githubusercontent.com/acme/alpha-skill/main/SKILL.md',
  'https://github.com:8443/acme/alpha-skill',
  'https://user:token@github.com/acme/alpha-skill',
  'https://127.0.0.1/acme/alpha-skill',
  'http://github.com/acme/alpha-skill',
  'https://github.com/acme/alpha-skill/blob/main/SKILL.md',
  'https://github.com/acme/alpha-skill?ref=main',
];

const savedProxyEnv = {
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  HTTP_PROXY: process.env.HTTP_PROXY,
  NO_PROXY: process.env.NO_PROXY,
};

beforeEach(() => {
  cli.invocations.length = 0;
  fs.rmSync(userSkillsDir, { recursive: true, force: true });
  fs.rmSync(workspaceSkillsDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedProxyEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function postJson(url: string, body: unknown): Promise<Response> {
  return app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('canonicalizeGitHubSkillUrl', () => {
  test('rebuilds github.com repository and tree URLs', () => {
    expect(canonicalizeGitHubSkillUrl('https://github.com/acme/repo')).toBe(
      'https://github.com/acme/repo',
    );
    expect(
      canonicalizeGitHubSkillUrl('https://WWW.GitHub.com./acme/repo.git/'),
    ).toBe('https://github.com/acme/repo');
    expect(canonicalizeGitHubSkillUrl('https://github.com:443/acme/repo')).toBe(
      'https://github.com/acme/repo',
    );
    expect(
      canonicalizeGitHubSkillUrl(
        'https://github.com/acme/.github/tree/v1.2/.claude/skills/tool',
      ),
    ).toBe('https://github.com/acme/.github/tree/v1.2/.claude/skills/tool');
  });

  test.each([
    ...REFUSED_URLS,
    'https://xn--gthub-cta.com/acme/repo',
    'https://github.com/acme',
    'https://github.com/acme/repo#main',
    'https://github.com/acme/repo/archive/refs/heads/main.zip',
    'https://github.com/acme/repo/tree/-main',
    'https://github.com/acme/repo/tree/main/a%2F..%2Fb',
  ])('refuses %s', (url) => {
    expect(() => canonicalizeGitHubSkillUrl(url)).toThrow(SkillUrlRefusedError);
  });
});

describe('POST /api/skills/install', () => {
  test.each(REFUSED_URLS)(
    'returns 400 for %s without starting a process',
    async (url) => {
      const response = await postJson('/api/skills/install', { package: url });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: 'Failed to install skill',
      });
      expect(cli.invocations).toEqual([]);
    },
  );

  test('hands the canonical GitHub source to skills add and keeps the operator proxy', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp.test:3128';
    process.env.HTTP_PROXY = 'http://proxy.corp.test:3128';
    process.env.NO_PROXY = 'localhost,127.0.0.1,.corp.test';

    const response = await postJson('/api/skills/install', {
      package: 'https://www.github.com/acme/pack/tree/main/skills/',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      installed: ['delta', 'gamma'],
    });
    expect(cli.invocations).toHaveLength(1);
    const [invocation] = cli.invocations;
    expect(invocation.command).toBe('npx');
    expect(invocation.args).toEqual([
      '-y',
      'skills',
      'add',
      'https://github.com/acme/pack/tree/main/skills',
      '--global',
      '--yes',
      '-a',
      'claude-code',
    ]);
    expect(invocation.env).toMatchObject({
      HTTPS_PROXY: 'http://proxy.corp.test:3128',
      HTTP_PROXY: 'http://proxy.corp.test:3128',
      NO_PROXY: 'localhost,127.0.0.1,.corp.test',
      GIT_LFS_SKIP_SMUDGE: '1',
    });
    expect(invocation.env.HOME).not.toBe(process.env.HOME);
    expect(invocation.args.join(' ')).not.toContain('http.proxy');
  });

  test('single-skill repositories install under their SKILL.md name', async () => {
    const alpha = await postJson('/api/skills/install', {
      package: 'https://github.com/acme/alpha-skill.git',
    });
    const beta = await postJson('/api/skills/install', {
      package: 'https://github.com/acme/beta-skill/',
    });

    expect(await alpha.json()).toMatchObject({ installed: ['alpha'] });
    expect(await beta.json()).toMatchObject({ installed: ['beta-tool'] });
    expect(fs.readdirSync(userSkillsDir).sort()).toEqual([
      '.skills-manifest.json',
      'alpha',
      'beta-tool',
    ]);
    expect(readManifest().skills).toMatchObject({
      alpha: { packageName: 'https://github.com/acme/alpha-skill.git' },
      'beta-tool': { packageName: 'https://github.com/acme/beta-skill/' },
    });
  });

  test('reinstalling a skill installed from a GitHub URL keeps its ID', async () => {
    await postJson('/api/skills/install', {
      package: 'https://github.com/acme/alpha-skill.git',
    });
    cli.invocations.length = 0;

    const response = await app.request('/api/skills/alpha/reinstall', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ installed: ['alpha'] });
    expect(cli.invocations.map((call) => call.args[3])).toEqual([
      'https://github.com/acme/alpha-skill',
    ]);
    expect(fs.existsSync(path.join(userSkillsDir, 'alpha', 'SKILL.md'))).toBe(
      true,
    );
    expect(readManifest().skills.alpha?.packageName).toBe(
      'https://github.com/acme/alpha-skill.git',
    );
  });

  test('refuses to reinstall a skill recorded from a URL that is no longer allowed', async () => {
    writeSkill(path.join(userSkillsDir, 'legacy'), 'legacy');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        skills: {
          legacy: {
            packageName: 'https://skills.example.com/legacy',
            installedAt: new Date(0).toISOString(),
            source: 'skills.sh',
          },
        },
      }),
    );

    const response = await app.request('/api/skills/legacy/reinstall', {
      method: 'POST',
    });

    expect(response.status).toBe(400);
    expect(cli.invocations).toEqual([]);
    expect(fs.existsSync(path.join(userSkillsDir, 'legacy', 'SKILL.md'))).toBe(
      true,
    );
    expect(readManifest().skills.legacy).toBeDefined();
  });
});

describe('install_skill IPC path', () => {
  test('refuses non-GitHub URLs without starting a process', async () => {
    const result = await skillsModule.installSkillForUser(
      OWNER_ID,
      'https://skills.example.com/.well-known/skills',
    );

    expect(result).toMatchObject({ success: false, invalidRequest: true });
    expect(cli.invocations).toEqual([]);
  });

  test('installs a GitHub URL through the canonical source', async () => {
    const result = await skillsModule.installSkillForUser(
      OWNER_ID,
      'https://github.com/acme/alpha-skill',
    );

    expect(result).toMatchObject({ success: true, installed: ['alpha'] });
    expect(cli.invocations.map((call) => call.args[3])).toEqual([
      'https://github.com/acme/alpha-skill',
    ]);
  });
});

describe('POST /api/groups/:jid/workspace-config/skills/install', () => {
  const installUrl = `/api/groups/${encodeURIComponent(WORKSPACE_JID)}/workspace-config/skills/install`;

  test.each(REFUSED_URLS)(
    'returns 400 for %s without starting a process',
    async (url) => {
      const response = await postJson(installUrl, { package: url });

      expect(response.status).toBe(400);
      expect(cli.invocations).toEqual([]);
    },
  );

  test('installs a GitHub URL under its SKILL.md name and keeps the operator proxy', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp.test:3128';
    process.env.NO_PROXY = 'localhost,127.0.0.1';

    const response = await postJson(installUrl, {
      package: 'https://github.com/acme/alpha-skill.git',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      installed: ['alpha'],
    });
    expect(cli.invocations).toHaveLength(1);
    expect(cli.invocations[0].args[3]).toBe(
      'https://github.com/acme/alpha-skill',
    );
    expect(cli.invocations[0].env).toMatchObject({
      HTTPS_PROXY: 'http://proxy.corp.test:3128',
      NO_PROXY: 'localhost,127.0.0.1',
    });
    expect(
      fs.existsSync(path.join(workspaceSkillsDir, 'alpha', 'SKILL.md')),
    ).toBe(true);
  });
});
