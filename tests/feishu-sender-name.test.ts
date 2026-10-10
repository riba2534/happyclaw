import { describe, expect, test, vi } from 'vitest';
import {
  createFeishuSenderNameResolver,
  type FeishuChatMemberPage,
  type FeishuSenderNameErrorKind,
} from '../src/feishu-sender-name.js';

function codeError(code: number): Error {
  return Object.assign(new Error(`feishu ${code}`), { code });
}

function classifyByCode(error: unknown): FeishuSenderNameErrorKind {
  const code = (error as { code?: number }).code;
  if (code === 99991672) return 'missing_scope';
  if (code === 99991400) return 'transient';
  return 'definitive';
}

function memberPage(
  members: Record<string, string>,
  next?: string,
): FeishuChatMemberPage {
  return {
    members: Object.entries(members).map(([openId, name]) => ({
      openId,
      name,
    })),
    hasMore: next !== undefined,
    pageToken: next,
  };
}

describe('Feishu sender name resolver', () => {
  test('resolves and caches a contact name', async () => {
    const lookup = vi.fn(async () => '浣熊');
    const resolver = createFeishuSenderNameResolver({ lookup });

    await expect(resolver.resolve('ou_a')).resolves.toBe('浣熊');
    await expect(resolver.resolve('ou_a')).resolves.toBe('浣熊');
    expect(resolver.peek('ou_a')).toBe('浣熊');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('shares one request between concurrent lookups for the same sender', async () => {
    let release!: (name: string) => void;
    const lookup = vi.fn(
      () => new Promise<string>((resolve) => (release = resolve)),
    );
    const resolver = createFeishuSenderNameResolver({ lookup });

    const first = resolver.resolve('ou_a');
    const second = resolver.resolve('ou_a');
    await vi.waitFor(() => expect(lookup).toHaveBeenCalled());
    release('斐斐');

    await expect(Promise.all([first, second])).resolves.toEqual([
      '斐斐',
      '斐斐',
    ]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('degrades to undefined and negatively caches definitive failures', async () => {
    let clock = 0;
    const onLookupError = vi.fn();
    const lookup = vi.fn(async () => {
      throw codeError(41050);
    });
    const resolver = createFeishuSenderNameResolver({
      lookup,
      classifyError: classifyByCode,
      now: () => clock,
      negativeTtlMs: 1_000,
      onLookupError,
    });

    await expect(resolver.resolve('ou_a')).resolves.toBeUndefined();
    await expect(resolver.resolve('ou_a')).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(onLookupError).toHaveBeenCalledWith(
      'contact',
      'ou_a',
      expect.objectContaining({ code: 41050 }),
    );

    clock = 1_000;
    await resolver.resolve('ou_a');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  test('retries a transient failure sooner than a definitive one', async () => {
    let clock = 0;
    const lookup = vi
      .fn<(openId: string) => Promise<string>>()
      .mockRejectedValueOnce(codeError(99991400))
      .mockResolvedValueOnce('限流之后');
    const resolver = createFeishuSenderNameResolver({
      lookup,
      classifyError: classifyByCode,
      now: () => clock,
      transientTtlMs: 100,
      negativeTtlMs: 10_000,
    });

    await expect(resolver.resolve('ou_a')).resolves.toBeUndefined();
    clock = 100;
    await expect(resolver.resolve('ou_a')).resolves.toBe('限流之后');
  });

  test('suspends a source whose scope is missing instead of failing per sender', async () => {
    let clock = 0;
    const onMissingScope = vi.fn();
    const onLookupError = vi.fn();
    const lookup = vi.fn(async () => {
      throw codeError(99991672);
    });
    const resolver = createFeishuSenderNameResolver({
      lookup,
      classifyError: classifyByCode,
      now: () => clock,
      missingScopeBackoffMs: 5_000,
      onMissingScope,
      onLookupError,
    });

    await expect(resolver.resolve('ou_a')).resolves.toBeUndefined();
    await expect(resolver.resolve('ou_b')).resolves.toBeUndefined();
    await expect(resolver.resolve('ou_c')).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(onMissingScope).toHaveBeenCalledTimes(1);
    expect(onMissingScope).toHaveBeenCalledWith(
      'contact',
      expect.objectContaining({ code: 99991672 }),
    );
    expect(onLookupError).not.toHaveBeenCalled();

    // Once the scope is granted, the next lookup after the backoff succeeds.
    clock = 5_000;
    lookup.mockResolvedValueOnce('授权之后');
    await expect(resolver.resolve('ou_a')).resolves.toBe('授权之后');
  });

  test('treats blank names as missing', async () => {
    const resolver = createFeishuSenderNameResolver({
      lookup: async () => '   ',
    });
    await expect(resolver.resolve('ou_a')).resolves.toBeUndefined();
  });

  test('refreshes a positive entry after its TTL', async () => {
    let clock = 0;
    const lookup = vi
      .fn<(openId: string) => Promise<string>>()
      .mockResolvedValueOnce('旧名字')
      .mockResolvedValueOnce('新名字');
    const resolver = createFeishuSenderNameResolver({
      lookup,
      now: () => clock,
      positiveTtlMs: 1_000,
    });

    await expect(resolver.resolve('ou_a')).resolves.toBe('旧名字');
    clock = 1_000;
    expect(resolver.peek('ou_a')).toBeUndefined();
    await expect(resolver.resolve('ou_a')).resolves.toBe('新名字');
  });

  test('stops waiting at the deadline but caches the late answer', async () => {
    vi.useFakeTimers();
    try {
      let release!: (name: string) => void;
      const lookup = vi.fn(
        () => new Promise<string>((resolve) => (release = resolve)),
      );
      const resolver = createFeishuSenderNameResolver({
        lookup,
        timeoutMs: 25,
      });
      const pending = resolver.resolve('ou_a');
      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toBeUndefined();

      release('迟到的名字');
      await vi.advanceTimersByTimeAsync(0);
      expect(resolver.peek('ou_a')).toBe('迟到的名字');
      expect(lookup).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('abandons a hung request so later messages can look up again', async () => {
    vi.useFakeTimers();
    try {
      const lookup = vi
        .fn<(openId: string) => Promise<string>>()
        .mockImplementationOnce(() => new Promise<string>(() => {}))
        .mockResolvedValueOnce('第二次');
      const resolver = createFeishuSenderNameResolver({
        lookup,
        timeoutMs: 25,
        requestTimeoutMs: 100,
        transientTtlMs: 0,
        classifyError: () => 'transient',
      });
      const first = resolver.resolve('ou_a');
      await vi.advanceTimersByTimeAsync(100);
      await expect(first).resolves.toBeUndefined();
      await expect(resolver.resolve('ou_a')).resolves.toBe('第二次');
    } finally {
      vi.useRealTimers();
    }
  });

  test('evicts the oldest entries beyond the cache bound', async () => {
    const lookup = vi.fn(async (openId: string) => `name-${openId}`);
    const resolver = createFeishuSenderNameResolver({ lookup, maxEntries: 2 });

    await resolver.resolve('a');
    await resolver.resolve('b');
    await resolver.resolve('c');

    expect(resolver.peek('a')).toBeUndefined();
    expect(resolver.peek('b')).toBe('name-b');
    expect(resolver.peek('c')).toBe('name-c');
  });

  test('never looks up an empty open_id', async () => {
    const lookup = vi.fn(async () => 'x');
    const resolver = createFeishuSenderNameResolver({ lookup });
    await expect(resolver.resolve('')).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  describe('group member list', () => {
    test('names every member of a group with one list request', async () => {
      const lookup = vi.fn(async () => 'contact');
      const listChatMembers = vi.fn(async () =>
        memberPage({ ou_a: '斐斐', ou_b: '二狗' }),
      );
      const resolver = createFeishuSenderNameResolver({
        lookup,
        listChatMembers,
      });

      await expect(resolver.resolve('ou_a', 'oc_1')).resolves.toBe('斐斐');
      await expect(resolver.resolve('ou_b', 'oc_1')).resolves.toBe('二狗');
      expect(listChatMembers).toHaveBeenCalledTimes(1);
      expect(listChatMembers).toHaveBeenCalledWith('oc_1', undefined);
      expect(lookup).not.toHaveBeenCalled();
    });

    test('follows pages up to the bound, then asks the contact directory', async () => {
      const lookup = vi.fn(async () => '通讯录');
      const listChatMembers = vi.fn(async (_chatId: string, token?: string) =>
        token === undefined
          ? memberPage({ ou_a: '第一页' }, 'p2')
          : token === 'p2'
            ? memberPage({ ou_b: '第二页' }, 'p3')
            : memberPage({ ou_c: '第三页' }),
      );
      const resolver = createFeishuSenderNameResolver({
        lookup,
        listChatMembers,
        maxMemberPages: 2,
      });

      await expect(resolver.resolve('ou_b', 'oc_1')).resolves.toBe('第二页');
      expect(listChatMembers).toHaveBeenCalledTimes(2);
      await expect(resolver.resolve('ou_c', 'oc_1')).resolves.toBe('通讯录');
      expect(lookup).toHaveBeenCalledWith('ou_c');
      expect(listChatMembers).toHaveBeenCalledTimes(2);
    });

    test('refetches a stale list once for a sender who joined later', async () => {
      let clock = 0;
      const lookup = vi.fn(async () => undefined);
      const listChatMembers = vi
        .fn<(chatId: string, token?: string) => Promise<FeishuChatMemberPage>>()
        .mockResolvedValueOnce(memberPage({ ou_a: '老成员' }))
        .mockResolvedValueOnce(memberPage({ ou_a: '老成员', ou_new: '新人' }));
      const resolver = createFeishuSenderNameResolver({
        lookup,
        listChatMembers,
        now: () => clock,
        memberListRefreshMs: 1_000,
      });

      await resolver.resolve('ou_a', 'oc_1');
      // Fresh list: an unknown sender goes to the contact directory only.
      await expect(resolver.resolve('ou_x', 'oc_1')).resolves.toBeUndefined();
      expect(listChatMembers).toHaveBeenCalledTimes(1);

      clock = 1_000;
      await expect(resolver.resolve('ou_new', 'oc_1')).resolves.toBe('新人');
      expect(listChatMembers).toHaveBeenCalledTimes(2);
    });

    test('a remembered miss neither refetches the list nor asks contacts again', async () => {
      let clock = 0;
      const lookup = vi.fn(async () => undefined);
      const listChatMembers = vi.fn(async () => memberPage({ ou_a: '成员' }));
      const resolver = createFeishuSenderNameResolver({
        lookup,
        listChatMembers,
        now: () => clock,
        memberListRefreshMs: 10,
        negativeTtlMs: 10_000,
      });

      await expect(resolver.resolve('ou_x', 'oc_1')).resolves.toBeUndefined();
      clock = 5_000;
      await expect(resolver.resolve('ou_x', 'oc_1')).resolves.toBeUndefined();
      expect(listChatMembers).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledTimes(1);
    });

    test('names a sender in a group even after a private-chat miss', async () => {
      const lookup = vi.fn(async () => undefined);
      const listChatMembers = vi.fn(async () => memberPage({ ou_a: '群里' }));
      const resolver = createFeishuSenderNameResolver({
        lookup,
        listChatMembers,
      });

      await expect(resolver.resolve('ou_a')).resolves.toBeUndefined();
      await expect(resolver.resolve('ou_a', 'oc_1')).resolves.toBe('群里');
    });

    test('falls back to contacts when the member list scope is missing', async () => {
      const onMissingScope = vi.fn();
      const lookup = vi.fn(async (openId: string) => `通讯录-${openId}`);
      const listChatMembers = vi.fn(async () => {
        throw codeError(99991672);
      });
      const resolver = createFeishuSenderNameResolver({
        lookup,
        listChatMembers,
        classifyError: classifyByCode,
        onMissingScope,
      });

      await expect(resolver.resolve('ou_a', 'oc_1')).resolves.toBe(
        '通讯录-ou_a',
      );
      await expect(resolver.resolve('ou_b', 'oc_2')).resolves.toBe(
        '通讯录-ou_b',
      );
      expect(listChatMembers).toHaveBeenCalledTimes(1);
      expect(onMissingScope).toHaveBeenCalledWith(
        'chat_members',
        expect.objectContaining({ code: 99991672 }),
      );
    });

    test('keeps the members of a partially fetched list', async () => {
      const onLookupError = vi.fn();
      const listChatMembers = vi
        .fn<(chatId: string, token?: string) => Promise<FeishuChatMemberPage>>()
        .mockResolvedValueOnce(memberPage({ ou_a: '第一页' }, 'p2'))
        .mockRejectedValueOnce(codeError(500));
      const resolver = createFeishuSenderNameResolver({
        lookup: async () => undefined,
        listChatMembers,
        onLookupError,
      });

      await expect(resolver.resolve('ou_a', 'oc_1')).resolves.toBe('第一页');
      expect(onLookupError).toHaveBeenCalledWith(
        'chat_members',
        'oc_1',
        expect.objectContaining({ code: 500 }),
      );
    });

    test('shares one list request between concurrent group senders', async () => {
      let release!: (page: FeishuChatMemberPage) => void;
      const listChatMembers = vi.fn(
        () =>
          new Promise<FeishuChatMemberPage>((resolve) => (release = resolve)),
      );
      const resolver = createFeishuSenderNameResolver({
        lookup: async () => undefined,
        listChatMembers,
      });

      const first = resolver.resolve('ou_a', 'oc_1');
      const second = resolver.resolve('ou_b', 'oc_1');
      await vi.waitFor(() => expect(listChatMembers).toHaveBeenCalled());
      release(memberPage({ ou_a: '甲', ou_b: '乙' }));

      await expect(Promise.all([first, second])).resolves.toEqual(['甲', '乙']);
      expect(listChatMembers).toHaveBeenCalledTimes(1);
    });
  });
});
