import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { isGuestRouteAllowed } =
  await import('../src/middleware/guest-guard.js');
const { isGuestHiddenWorkspacePath } = await import('../src/guest-access.js');

describe('guest route allowlist', () => {
  test.each([
    ['GET', '/api/groups'],
    ['HEAD', '/api/groups/web%3Aflow-x/messages'],
    ['GET', '/api/groups/web:flow-x/messages/m1/attachments/0/original'],
    ['GET', '/api/groups/web:flow-x/files/download/bm90ZXM'],
    ['GET', '/api/memory/workspaces/web:flow-x/items/i1/versions'],
    ['GET', '/api/tasks/runs/r1'],
    ['PUT', '/api/auth/password'],
    ['POST', '/api/auth/logout'],
  ])('%s %s is allowed', (method, path) => {
    expect(isGuestRouteAllowed(method, path)).toBe(true);
  });

  test.each([
    ['POST', '/api/groups'],
    ['GET', '/api/groups/web:flow-x/env'],
    ['GET', '/api/groups/web:flow-x/files/download/a/b'],
    ['GET', '/api/groups/web:flow-x/messages/extra'],
    ['PUT', '/api/groups/web:flow-x/files/content/bm90ZXM'],
    ['GET', '/api/guests'],
    ['GET', '/api/some-future-route'],
    ['PATCH', '/api/auth/password'],
    ['OPTIONS', '/api/groups'],
  ])('%s %s is denied', (method, path) => {
    expect(isGuestRouteAllowed(method, path)).toBe(false);
  });
});

describe('guest hidden workspace paths', () => {
  test.each([
    ['.claude/settings.json', true],
    ['sub/.claude/x', true],
    ['logs/run.log', true],
    ['conversations/2026.md', true],
    ['.env', true],
    ['app/.env.local', true],
    ['./logs', true],
    ['notes.txt', false],
    ['envoy.yaml', false],
    ['', false],
  ])('%s → %s', (value, hidden) => {
    expect(isGuestHiddenWorkspacePath(value)).toBe(hidden);
  });
});
