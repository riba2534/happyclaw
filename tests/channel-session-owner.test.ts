import { describe, expect, test } from 'vitest';

import { resolveStickyChannelOwner } from '../src/channel-session-owner.js';

const feishu = 'feishu:chat-a#account:bot-a#root:root-a#thread:thread-a';

describe('sticky channel session ownership', () => {
  test('Feishu ownership survives a Web follow-up', () => {
    expect(resolveStickyChannelOwner(feishu, 'web:workspace-a')).toBe(feishu);
  });

  test('Feishu ownership cannot be replaced by a later QQ input', () => {
    expect(resolveStickyChannelOwner(feishu, 'qq:group-b#account:bot-b')).toBe(
      feishu,
    );
  });

  test('a Web-created session adopts its first concrete IM source once', () => {
    expect(resolveStickyChannelOwner(null, 'qq:group-b#account:bot-b')).toBe(
      'qq:group-b#account:bot-b',
    );
  });

  test('the reply anchor follows the current message inside one conversation', () => {
    // Regression: the first inbound of a session could carry a root_id, and
    // freezing the whole route on it meant every later reply — including for
    // top-level messages — was delivered into that one thread.
    const laterTopLevel = 'feishu:chat-a#account:bot-a';
    expect(resolveStickyChannelOwner(feishu, laterTopLevel)).toBe(
      laterTopLevel,
    );

    const otherThread =
      'feishu:chat-a#account:bot-a#root:root-b#thread:thread-b';
    expect(resolveStickyChannelOwner(feishu, otherThread)).toBe(otherThread);
  });

  test('a different chat or account in the same provider does not take ownership', () => {
    expect(
      resolveStickyChannelOwner(feishu, 'feishu:chat-b#account:bot-a'),
    ).toBe(feishu);
    expect(
      resolveStickyChannelOwner(feishu, 'feishu:chat-a#account:bot-b'),
    ).toBe(feishu);
  });
});
