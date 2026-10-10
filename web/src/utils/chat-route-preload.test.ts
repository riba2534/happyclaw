import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  shouldPreloadAppShell,
  shouldPreloadChatRoute,
} from './chat-route-preload';

describe('chat route preload policy', () => {
  test.each([
    ['/', '', '/', true],
    ['/chat', '', '/', true],
    ['/chat/workspace', '', '/', true],
    ['/happyclaw/', '', '/happyclaw/', true],
    ['/happyclaw/chat/workspace', '', '/happyclaw/', true],
    ['/happyclaw/', '#/chat/workspace?agent=one', '/happyclaw/', true],
    ['/login', '', '/', false],
    ['/register', '', '/', false],
    ['/setup/providers', '', '/', false],
    ['/tasks', '', '/', false],
    ['/memory', '', '/', false],
    ['/happyclaw/tasks', '', '/happyclaw/', false],
    ['/happyclaw/', '#/memory', '/happyclaw/', false],
    ['/chatty', '', '/', false],
  ])('pathname=%s hash=%s base=%s => %s', (pathname, hash, base, expected) => {
    expect(shouldPreloadChatRoute(pathname, hash, base)).toBe(expected);
  });

  test('keeps production HTML route-neutral and starts the chat split from the route policy', () => {
    const app = fs.readFileSync(
      path.join(process.cwd(), 'web/src/App.tsx'),
      'utf8',
    );
    const viteConfig = fs.readFileSync(
      path.join(process.cwd(), 'web/vite.config.ts'),
      'utf8',
    );

    expect(viteConfig).not.toContain('modulepreload');
    expect(viteConfig).not.toContain('preloadChatChunks');
    expect(app).toContain('shouldPreloadChatRoute(');
    expect(app).toContain('void loadChatPage();');
  });
});

describe('shouldPreloadAppShell', () => {
  test('preloads the layout for signed-in routes only', () => {
    expect(shouldPreloadAppShell('/chat/main', '', '/')).toBe(true);
    expect(shouldPreloadAppShell('/settings', '', '/')).toBe(true);
    expect(shouldPreloadAppShell('/login', '', '/')).toBe(false);
    expect(shouldPreloadAppShell('/setup/providers', '', '/')).toBe(false);
    expect(shouldPreloadAppShell('/app/register', '', '/app/')).toBe(false);
    expect(shouldPreloadAppShell('/', '#/login', '/')).toBe(false);
  });
});
