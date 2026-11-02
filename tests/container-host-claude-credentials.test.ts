import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

/**
 * Container mode with host_claude: the session's .claude directory is
 * mounted read-write at /home/node/.claude, so whatever HappyClaw writes
 * there is readable by the agent. The admin's own credentials must not be.
 */
const ROOT =
  process.env.HAPPYCLAW_HOST_CLAUDE_CREDENTIALS_ROOT ??
  (() => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-host-claude-credentials-'),
    );
    process.env.HAPPYCLAW_HOST_CLAUDE_CREDENTIALS_ROOT = root;
    return root;
  })();

vi.mock('../src/config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/config.js')>();
  const root = process.env.HAPPYCLAW_HOST_CLAUDE_CREDENTIALS_ROOT!;
  return {
    ...real,
    DATA_DIR: root,
    GROUPS_DIR: path.join(root, 'groups'),
    STORE_DIR: path.join(root, 'db'),
    CONTAINER_IMAGE: 'happyclaw-agent:test',
    TIMEZONE: 'UTC',
    MAIN_GROUP_FOLDER: 'main',
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));

const { buildVolumeMounts } = await import('../src/container-runner.js');

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  delete process.env.HAPPYCLAW_HOST_CLAUDE_CREDENTIALS_ROOT;
});

const SECRETS = [
  'admin-personal-token',
  'admin-bedrock',
  'admin-oauth-refresh',
  '~/bin/admin-key.sh',
  '~/bin/aws-creds.sh',
];

function hostClaudeProfile() {
  return {
    id: 'p',
    name: 'p',
    version: 1,
    identityHash: 'h',
    identityPrompt: '',
    includeClaudePreset: true,
    runtimePolicy: {
      context: { source: 'host_claude' },
      skills: {
        mode: 'disabled',
        ids: [],
        host: { mode: 'disabled', ids: [] },
      },
      mcp: { mode: 'disabled', ids: [] },
    },
  };
}

const SESSION = 'session-1';

function sessionClaudeDir(folder: string): string {
  return path.join(ROOT, 'sessions', folder, 'agents', SESSION, '.claude');
}

function mountSession(folder: string) {
  const mounts = buildVolumeMounts(
    {
      name: folder,
      folder,
      added_at: '2026-10-28T00:00:00.000Z',
      created_by: 'admin',
      is_home: false,
    } as never,
    false,
    SESSION,
    true,
    'main',
    undefined,
    hostClaudeProfile() as never,
  );
  const sessionDir = sessionClaudeDir(folder);
  const mounted = mounts.find(
    (mount: { containerPath: string }) =>
      mount.containerPath === '/home/node/.claude',
  );
  expect(mounted).toMatchObject({ hostPath: sessionDir, readonly: false });
  // Everything HappyClaw persists from the merged settings lives here.
  return {
    settings: fs.readFileSync(path.join(sessionDir, 'settings.json'), 'utf8'),
    projection: fs.readFileSync(
      path.join(sessionDir, '.happyclaw-native-settings.json'),
      'utf8',
    ),
    sessionDir,
  };
}

describe('host_claude in a container', () => {
  const external = path.join(ROOT, 'external-claude');
  fs.mkdirSync(external, { recursive: true });
  fs.writeFileSync(
    path.join(external, 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'admin-personal-token',
        AWS_BEARER_TOKEN_BEDROCK: 'admin-bedrock',
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'admin-oauth-refresh',
        CLAUDE_CODE_EFFORT_LEVEL: 'low',
        API_TIMEOUT_MS: '600000',
      },
      apiKeyHelper: '~/bin/admin-key.sh',
      awsCredentialExport: '~/bin/aws-creds.sh',
    }),
  );
  fs.mkdirSync(path.join(ROOT, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, 'config', 'system-settings.json'),
    JSON.stringify({ externalClaudeDir: external }),
  );

  test("the mounted session settings carry none of the admin's credentials", () => {
    const { settings, projection } = mountSession('fresh');
    for (const secret of SECRETS) {
      expect(settings).not.toContain(secret);
      expect(projection).not.toContain(secret);
    }
    expect(settings).not.toContain('CLAUDE_CODE_EFFORT_LEVEL');
    // The rest of the admin's layer still applies.
    expect(JSON.parse(settings).env.API_TIMEOUT_MS).toBe('600000');
  });

  test('a session an earlier build wrote them into loses them on its next launch', () => {
    const sessionDir = sessionClaudeDir('leaked');
    fs.mkdirSync(sessionDir, { recursive: true });
    const leaked = {
      env: {
        ANTHROPIC_AUTH_TOKEN: 'admin-personal-token',
        AWS_BEARER_TOKEN_BEDROCK: 'admin-bedrock',
      },
      apiKeyHelper: '~/bin/admin-key.sh',
    };
    fs.writeFileSync(
      path.join(sessionDir, 'settings.json'),
      JSON.stringify(leaked),
    );
    fs.writeFileSync(
      path.join(sessionDir, '.happyclaw-native-settings.json'),
      JSON.stringify(leaked),
    );
    const { settings, projection } = mountSession('leaked');
    for (const secret of SECRETS) {
      expect(settings).not.toContain(secret);
      expect(projection).not.toContain(secret);
    }
  });
});
