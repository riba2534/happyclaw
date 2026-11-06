import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { isGuestRouteAllowed } =
  await import('../src/middleware/guest-guard.js');
const { isGuestHiddenWorkspacePath } = await import('../src/guest-access.js');

const WS = 'web:flow-x';

describe('guest route allowlist', () => {
  test.each([
    ['GET', '/api/auth/status'],
    ['GET', '/api/auth/me'],
    ['PUT', '/api/auth/password'],
    ['POST', '/api/auth/logout'],
    ['GET', '/api/groups'],
    ['HEAD', '/api/groups/web%3Aflow-x/messages'],
    ['GET', `/api/groups/${WS}/messages/m1/attachments/0/original`],
    ['GET', `/api/groups/${WS}/agents`],
    ['GET', `/api/groups/${WS}/sessions`],
    ['GET', `/api/groups/${WS}/turn-traces/t1`],
    ['GET', '/api/follow-ups'],
    ['GET', '/api/workspaces'],
    ['GET', `/api/workspaces/${WS}`],
    ['GET', `/api/groups/${WS}/files`],
    ['GET', `/api/groups/${WS}/files/download/bm90ZXM`],
    ['GET', `/api/groups/${WS}/files/preview/bm90ZXM`],
    ['GET', `/api/groups/${WS}/files/content/bm90ZXM`],
    ['GET', `/api/memory/workspaces/${WS}/items`],
    ['GET', `/api/memory/workspaces/${WS}/items/search`],
    ['GET', `/api/memory/workspaces/${WS}/items/i1`],
    ['GET', `/api/memory/workspaces/${WS}/items/i1/versions`],
    ['GET', '/api/automations'],
    ['GET', '/api/automations/a1'],
    ['GET', '/api/automations/a1/runs'],
  ])('%s %s is allowed', (method, path) => {
    expect(isGuestRouteAllowed(method, path)).toBe(true);
  });

  test.each([
    // Writes on otherwise readable resources.
    ['POST', '/api/groups'],
    ['POST', '/api/messages'],
    ['PUT', `/api/groups/${WS}/files/content/bm90ZXM`],
    ['POST', `/api/groups/${WS}/files`],
    ['POST', `/api/groups/${WS}/interrupt`],
    ['POST', '/api/automations'],
    ['PATCH', '/api/automations/a1'],
    ['POST', '/api/automations/a1/run'],
    ['POST', '/api/automations/a1/pause'],
    ['POST', '/api/automations/a1/runs/read'],
    ['DELETE', '/api/automations/a1'],
    ['PATCH', '/api/auth/password'],
    // Reads deliberately left out.
    ['GET', '/api/tasks'],
    ['GET', '/api/tasks/runs/r1'],
    ['GET', '/api/automations/for-session'],
    ['GET', `/api/groups/${WS}/git/status`],
    ['GET', `/api/groups/${WS}/git/diff`],
    ['GET', `/api/groups/${WS}/git/worktree-support`],
    ['GET', `/api/groups/${WS}/model-selection`],
    ['GET', `/api/groups/${WS}/context-usage`],
    ['GET', `/api/groups/${WS}/env`],
    ['GET', `/api/groups/${WS}/mcp`],
    ['GET', `/api/groups/${WS}/im-groups`],
    ['GET', `/api/groups/${WS}/delete-impact`],
    ['GET', `/api/workspaces/${WS}/channel-mounts`],
    ['GET', `/api/workspaces/${WS}/runtime-sessions`],
    ['GET', '/api/status'],
    ['GET', '/api/status/groups'],
    ['GET', '/api/usage/summary'],
    ['GET', '/api/billing/me'],
    ['GET', '/api/agent-profiles'],
    ['GET', '/api/guests'],
    // Web Push belongs to a full account.
    ['GET', '/api/push/vapid-public-key'],
    ['GET', '/api/push/status'],
    ['POST', '/api/push/subscribe'],
    ['POST', '/api/push/unsubscribe'],
    ['POST', '/api/push/test'],
    // Shape near-misses and unknown routes.
    ['GET', `/api/groups/${WS}/files/download/a/b`],
    ['GET', `/api/groups/${WS}/messages/extra`],
    ['GET', '/api/some-future-route'],
    ['OPTIONS', '/api/groups'],
  ])('%s %s is denied', (method, path) => {
    expect(isGuestRouteAllowed(method, path)).toBe(false);
  });
});

describe('guest hidden workspace paths', () => {
  test.each([
    // Every dot entry, at any depth and in any case.
    ['.claude/settings.json', true],
    ['sub/.claude/x', true],
    ['.git/config', true],
    ['.GIT/config', true],
    ['.ssh/id_rsa', true],
    ['home/.aws/credentials', true],
    ['.npmrc', true],
    ['.netrc', true],
    ['.git-credentials', true],
    ['.env', true],
    ['app/.env.local', true],
    ['.Env.Production', true],
    ['..', true],
    // Key and credential files.
    ['certs/server.pem', true],
    ['certs/server.PEM', true],
    ['tls.key', true],
    ['client.p12', true],
    ['client.PFX', true],
    ['release.keystore', true],
    ['keys/id_rsa', true],
    ['keys/id_rsa.pub', true],
    ['ID_ED25519', true],
    ['gcp/credentials.json', true],
    ['gcp/Credentials.JSON', true],
    // Runner state.
    ['logs/run.log', true],
    ['LOGS/run.log', true],
    ['./logs', true],
    ['conversations/2026.md', true],
    ['a\\.ssh\\config', true],
    // Ordinary project files stay visible.
    ['notes.txt', false],
    ['envoy.yaml', false],
    ['src/keyboard.ts', false],
    ['docs/monkey.md', false],
    ['credentials.md', false],
    ['', false],
    ['.', false],
  ])('%s → %s', (value, hidden) => {
    expect(isGuestHiddenWorkspacePath(value)).toBe(hidden);
  });
});
