import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  currentRouteChatFolder,
  findRouteGroupJid,
} from '../web/src/lib/route-workspace';

describe('findRouteGroupJid', () => {
  test('prefers the Web home workspace, then Web, then any group', () => {
    expect(
      findRouteGroupJid(
        {
          'feishu:oc_1': { folder: 'main' },
          'web:shared': { folder: 'main' },
          'web:main': { folder: 'main', is_home: true },
        },
        'main',
      ),
    ).toBe('web:main');
    expect(
      findRouteGroupJid(
        { 'feishu:oc_1': { folder: 'docs' }, 'web:docs': { folder: 'docs' } },
        'docs',
      ),
    ).toBe('web:docs');
    expect(
      findRouteGroupJid({ 'feishu:oc_1': { folder: 'docs' } }, 'docs'),
    ).toBe('feishu:oc_1');
    expect(findRouteGroupJid({ 'web:a': { folder: 'a' } }, 'b')).toBeNull();
  });
});

describe('currentRouteChatFolder', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('reads the folder from a /chat/:folder URL', () => {
    vi.stubGlobal('window', {
      location: { pathname: '/chat/flow-a1', hash: '' },
    });
    expect(currentRouteChatFolder()).toBe('flow-a1');
  });

  test('ignores other pages and the bare chat list', () => {
    vi.stubGlobal('window', { location: { pathname: '/chat', hash: '' } });
    expect(currentRouteChatFolder()).toBeNull();
    vi.stubGlobal('window', {
      location: { pathname: '/settings', hash: '' },
    });
    expect(currentRouteChatFolder()).toBeNull();
  });

  test('reads the hash route when the app uses the hash router', () => {
    vi.stubGlobal('window', {
      __HAPPYCLAW_HASH_ROUTER__: true,
      location: { pathname: '/', hash: '#/chat/main?agent=s1' },
    });
    expect(currentRouteChatFolder()).toBe('main');
  });
});
