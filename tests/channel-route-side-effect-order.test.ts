import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

function source(file: string) {
  return fs.readFileSync(path.join(process.cwd(), 'src', file), 'utf8');
}

function expectRouteBeforeSideEffects(
  body: string,
  routeMarker: string,
  markers: string[],
) {
  const route = body.indexOf(routeMarker);
  expect(route).toBeGreaterThan(-1);
  for (const marker of markers) {
    const sideEffect = body.indexOf(marker, route);
    expect(sideEffect, marker).toBeGreaterThan(route);
  }
}

describe('stale routes are rejected before connector side effects', () => {
  test('Discord resolves before registration, downloads, and persistence', () => {
    expectRouteBeforeSideEffects(
      source('discord.ts'),
      'const resolvedRoute =',
      [
        'opts.onNewChat(jid, chatName)',
        'await downloadAttachment(',
        'storeMessageDirect(',
      ],
    );
  });

  test('WhatsApp resolves before registration, downloads, and persistence', () => {
    expectRouteBeforeSideEffects(
      source('whatsapp.ts'),
      'const resolvedRoute =',
      [
        'opts.onNewChat(chatJid, chatName)',
        'await tryHandleMediaMessage(',
        'storeMessageDirect(',
      ],
    );
  });

  test('Feishu resolves before registration, downloads, and persistence', () => {
    expectRouteBeforeSideEffects(source('feishu.ts'), 'const admittedRoute =', [
      'await enrichFeishuInboundContent(',
      'onNewChat?.(chatJid, knownChatName)',
      'await downloadFeishuImage(',
      'storeMessageDirect(',
    ]);
  });

  test('Telegram intercepts slash commands before the route resolver, registration, and persistence', () => {
    // resolveAdmittedChannelRoute's resolver (opts.resolveEffectiveChatJid)
    // can have side effects for native-thread routing (creating a
    // conversation agent/chat/mount row for a not-yet-seen topic). A slash
    // command like /status in a brand-new topic must be intercepted before
    // that side effect runs, the same way Feishu checks for a slash command
    // ahead of its own route resolution.
    const body = source('telegram.ts');
    const slashCheck = body.indexOf(
      'match(/^\\/(\\S+?)(?:@\\S+)?(?:\\s+(.*))?$/i)',
    );
    const routeResolve = body.indexOf('const resolvedRoute =');
    expect(slashCheck).toBeGreaterThan(-1);
    expect(routeResolve).toBeGreaterThan(-1);
    expect(slashCheck).toBeLessThan(routeResolve);

    expectRouteBeforeSideEffects(body, 'const resolvedRoute =', [
      'opts.onNewChat(jid, chatName)',
      'storeMessageDirect(',
    ]);
  });
});
