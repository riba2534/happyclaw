import { describe, expect, test, vi } from 'vitest';

import {
  FEISHU_FORWARD_COMPANION_MAX_GAP_MS,
  FEISHU_MEDIA_TOPIC_COMPANION_MAX_GAP_MS,
  FEISHU_RAPID_TOPIC_COMPANION_MAX_GAP_MS,
  FeishuForwardBundleResolver,
  TransientFeishuForwardLookupError,
  hasAuthoredFeishuText,
  type FeishuForwardCandidate,
} from '../src/feishu-forward-bundle.js';

function root(
  overrides: Partial<FeishuForwardCandidate> = {},
): FeishuForwardCandidate {
  return {
    messageId: 'om_forward',
    messageType: 'merge_forward',
    content: 'Merged and Forwarded Message',
    senderOpenId: 'ou_sender',
    createTimeMs: 1_700_000_000_000,
    ...overrides,
  };
}

function note(
  overrides: Partial<FeishuForwardCandidate> = {},
): FeishuForwardCandidate {
  return {
    messageId: 'om_note',
    messageType: 'text',
    content: JSON.stringify({ text: '请分析这些内容' }),
    rootId: 'om_forward',
    parentId: 'om_forward',
    senderOpenId: 'ou_sender',
    createTimeMs: 1_700_000_009_000,
    ...overrides,
  };
}

function rapidTopicRoot(
  overrides: Partial<FeishuForwardCandidate> = {},
): FeishuForwardCandidate {
  return {
    messageId: 'om_topic_root',
    messageType: 'text',
    content: JSON.stringify({ text: 'https://github.com/example/repo' }),
    threadId: 'omt_topic',
    senderOpenId: 'ou_sender',
    createTimeMs: 1_700_000_000_000,
    chatType: 'group',
    ...overrides,
  };
}

function rapidTopicNote(
  overrides: Partial<FeishuForwardCandidate> = {},
): FeishuForwardCandidate {
  return {
    messageId: 'om_topic_note',
    messageType: 'text',
    content: JSON.stringify({ text: '<p>请分析这个仓库。</p>' }),
    rootId: 'om_topic_root',
    parentId: 'om_topic_root',
    threadId: 'omt_topic',
    senderOpenId: 'ou_sender',
    createTimeMs: 1_700_000_000_287,
    chatType: 'group',
    ...overrides,
  };
}

function mediaTopicRoot(
  overrides: Partial<FeishuForwardCandidate> = {},
): FeishuForwardCandidate {
  return {
    messageId: 'om_media_root',
    messageType: 'image',
    content: JSON.stringify({ image_key: 'img_media' }),
    threadId: 'omt_media',
    senderOpenId: 'ou_sender',
    createTimeMs: 1_700_000_000_000,
    chatType: 'group',
    ...overrides,
  };
}

function mediaTopicNote(
  overrides: Partial<FeishuForwardCandidate> = {},
): FeishuForwardCandidate {
  return {
    messageId: 'om_media_note',
    messageType: 'text',
    content: JSON.stringify({ text: '理解一下这张图' }),
    rootId: 'om_media_root',
    parentId: 'om_media_root',
    threadId: 'omt_media',
    senderOpenId: 'ou_sender',
    createTimeMs: 1_700_000_001_500,
    chatType: 'group',
    ...overrides,
  };
}

function lookupResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    data: {
      items: [
        {
          message_id: 'om_forward',
          msg_type: 'merge_forward',
          create_time: '1700000000000',
          sender: { id: 'ou_sender' },
          ...overrides,
        },
      ],
    },
  };
}

describe('Feishu merged-forward companion detection', () => {
  test('never holds an image topic root but still links its immediate direct caption', async () => {
    const lookup = vi.fn();
    const resolver = new FeishuForwardBundleResolver(lookup);

    // The image root runs at once (no forward_bundle hold); the caption asks
    // the scheduler to coalesce into that run, like a rapid topic reply.
    expect(resolver.observeRoot(mediaTopicRoot())).toBeUndefined();
    await expect(resolver.resolveCompanion(mediaTopicNote())).resolves.toEqual({
      kind: 'rapid_topic_bundle',
      bundleId: 'om_media_root',
      role: 'forwarder_comment',
      relatedMessageId: 'om_media_root',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  test('treats a deterministic 4xx root lookup as "not a companion"', async () => {
    const lookup = vi.fn().mockRejectedValue(
      Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: { code: 230027, msg: 'no permission' } },
      }),
    );
    const resolver = new FeishuForwardBundleResolver(lookup);

    await expect(resolver.resolveCompanion(note())).resolves.toBeUndefined();
    // Cached as definitive: a second note does not hit the API again.
    await expect(resolver.resolveCompanion(note())).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(1);

    const rateLimited = new FeishuForwardBundleResolver(
      vi.fn().mockRejectedValue(
        Object.assign(new Error('Request failed with status code 429'), {
          response: { status: 429, data: { code: 99991400 } },
        }),
      ),
    );
    await expect(rateLimited.resolveCompanion(note())).rejects.toBeInstanceOf(
      TransientFeishuForwardLookupError,
    );
  });

  test('does not merge an image reply outside the exact thread, sender or 3s window', async () => {
    const variants: Array<Partial<FeishuForwardCandidate>> = [
      { chatType: 'p2p' },
      { threadId: 'omt_other' },
      { parentId: 'om_middle' },
      { senderOpenId: 'ou_other' },
      {
        createTimeMs:
          1_700_000_000_000 + FEISHU_MEDIA_TOPIC_COMPANION_MAX_GAP_MS + 1,
      },
    ];
    for (const overrides of variants) {
      const resolver = new FeishuForwardBundleResolver(vi.fn());
      resolver.observeRoot(mediaTopicRoot());
      await expect(
        resolver.resolveCompanion(mediaTopicNote(overrides)),
      ).resolves.toBeUndefined();
    }
  });

  test('links the production rapid topic root+reply shape without reclassifying the root alone', async () => {
    const lookup = vi.fn();
    const resolver = new FeishuForwardBundleResolver(lookup);

    expect(resolver.observeRoot(rapidTopicRoot())).toBeUndefined();
    await expect(resolver.resolveCompanion(rapidTopicNote())).resolves.toEqual({
      kind: 'rapid_topic_bundle',
      bundleId: 'om_topic_root',
      role: 'forwarder_comment',
      relatedMessageId: 'om_topic_root',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  test('requires a group topic, exact thread, direct parent, same sender and the 2s rapid window', async () => {
    const variants: Array<Partial<FeishuForwardCandidate>> = [
      { chatType: 'p2p' },
      { threadId: 'omt_other' },
      { parentId: 'om_middle' },
      { senderOpenId: 'ou_other' },
      { content: JSON.stringify({ text: '普通话题回复' }) },
      {
        createTimeMs:
          1_700_000_000_000 + FEISHU_RAPID_TOPIC_COMPANION_MAX_GAP_MS + 1,
      },
    ];
    for (const overrides of variants) {
      const resolver = new FeishuForwardBundleResolver(vi.fn());
      resolver.observeRoot(rapidTopicRoot());
      await expect(
        resolver.resolveCompanion(rapidTopicNote(overrides)),
      ).resolves.toBeUndefined();
    }

    const ordinary = new FeishuForwardBundleResolver(
      vi.fn().mockResolvedValue({ data: { items: [] } }),
    );
    ordinary.observeRoot(
      rapidTopicRoot({ threadId: undefined, rootId: undefined }),
    );
    await expect(
      ordinary.resolveCompanion(rapidTopicNote()),
    ).resolves.toBeUndefined();
  });

  test('supports note-first rapid topic lookup only when provider returns the exact authored root shape', async () => {
    const lookup = vi.fn().mockResolvedValue({
      data: {
        items: [
          {
            message_id: 'om_topic_root',
            msg_type: 'text',
            create_time: '1700000000000',
            thread_id: 'omt_topic',
            chat_type: 'group',
            sender: { id: 'ou_sender' },
            body: {
              content: JSON.stringify({
                text: 'https://github.com/example/repo',
              }),
            },
          },
        ],
      },
    });
    const resolver = new FeishuForwardBundleResolver(lookup);

    await expect(
      resolver.resolveCompanion(rapidTopicNote()),
    ).resolves.toMatchObject({
      kind: 'rapid_topic_bundle',
      bundleId: 'om_topic_root',
    });
  });

  test('links a cached root and its direct textual note without requiring thread_id', async () => {
    const lookup = vi.fn();
    const resolver = new FeishuForwardBundleResolver(lookup);

    expect(resolver.observeRoot(root())).toEqual({
      kind: 'forward_bundle',
      bundleId: 'om_forward',
      role: 'forwarded_content',
    });
    await expect(resolver.resolveCompanion(note())).resolves.toEqual({
      kind: 'forward_bundle',
      bundleId: 'om_forward',
      role: 'forwarder_comment',
      relatedMessageId: 'om_forward',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  test('supports note-first event order through one provider lookup', async () => {
    const lookup = vi.fn().mockResolvedValue(lookupResponse());
    const resolver = new FeishuForwardBundleResolver(lookup);

    await expect(resolver.resolveCompanion(note())).resolves.toMatchObject({
      bundleId: 'om_forward',
      role: 'forwarder_comment',
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('om_forward');
  });

  test('collapses concurrent note-first probes for the same root', async () => {
    const lookup = vi.fn().mockResolvedValue(lookupResponse());
    const resolver = new FeishuForwardBundleResolver(lookup);

    const results = await Promise.all([
      resolver.resolveCompanion(note({ messageId: 'om_note_1' })),
      resolver.resolveCompanion(note({ messageId: 'om_note_2' })),
    ]);
    expect(results.every((result) => result?.bundleId === 'om_forward')).toBe(
      true,
    );
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('normalizes a seconds-based root timestamp returned by message.get', async () => {
    const lookup = vi
      .fn()
      .mockResolvedValue(lookupResponse({ create_time: '1700000000' }));
    const resolver = new FeishuForwardBundleResolver(lookup);

    await expect(resolver.resolveCompanion(note())).resolves.toMatchObject({
      bundleId: 'om_forward',
      role: 'forwarder_comment',
    });
  });

  test('bounds a hung note-first lookup and leaves it retryable', async () => {
    vi.useFakeTimers();
    try {
      const lookup = vi.fn(() => new Promise<unknown>(() => undefined));
      const resolver = new FeishuForwardBundleResolver(lookup);
      const first = resolver.resolveCompanion(note());
      const firstRejection = expect(first).rejects.toBeInstanceOf(
        TransientFeishuForwardLookupError,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await firstRejection;

      const second = resolver.resolveCompanion(note());
      const secondRejection = expect(second).rejects.toBeInstanceOf(
        TransientFeishuForwardLookupError,
      );
      expect(lookup).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5_000);
      await secondRejection;
    } finally {
      vi.useRealTimers();
    }
  });

  test('lets a concurrently arriving real root replace an empty lookup', async () => {
    let finishLookup!: (value: unknown) => void;
    const lookup = vi.fn(
      () => new Promise<unknown>((resolve) => (finishLookup = resolve)),
    );
    const resolver = new FeishuForwardBundleResolver(lookup);

    const pending = resolver.resolveCompanion(note());
    await Promise.resolve();
    resolver.observeRoot(root());
    finishLookup({ data: { items: [] } });

    await expect(pending).resolves.toMatchObject({
      bundleId: 'om_forward',
      role: 'forwarder_comment',
    });
  });

  test('requires same sender, direct parent, compatible thread and a 60s window', async () => {
    const resolver = new FeishuForwardBundleResolver(vi.fn());
    resolver.observeRoot(root({ threadId: 'omt_a' }));

    await expect(
      resolver.resolveCompanion(note({ senderOpenId: 'ou_other' })),
    ).resolves.toBeUndefined();
    await expect(
      resolver.resolveCompanion(note({ parentId: 'om_middle' })),
    ).resolves.toBeUndefined();
    await expect(
      resolver.resolveCompanion(note({ threadId: 'omt_b' })),
    ).resolves.toBeUndefined();
    await expect(
      resolver.resolveCompanion(
        note({
          createTimeMs:
            1_700_000_000_000 + FEISHU_FORWARD_COMPANION_MAX_GAP_MS + 1,
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      resolver.resolveCompanion(note({ createTimeMs: 1_699_999_999_999 })),
    ).resolves.toBeUndefined();
  });

  test('negative-caches only definitive non-forward roots', async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(lookupResponse({ msg_type: 'text' }))
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockRejectedValueOnce(new Error('temporary failure'));
    const resolver = new FeishuForwardBundleResolver(lookup);

    await expect(resolver.resolveCompanion(note())).resolves.toBeUndefined();
    await expect(resolver.resolveCompanion(note())).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(1);

    const transient = new FeishuForwardBundleResolver(lookup);
    await expect(transient.resolveCompanion(note())).rejects.toBeInstanceOf(
      TransientFeishuForwardLookupError,
    );
    await expect(transient.resolveCompanion(note())).rejects.toBeInstanceOf(
      TransientFeishuForwardLookupError,
    );
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  test('does not mistake a returned child for a missing root', async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(
        lookupResponse({
          message_id: 'om_child',
          msg_type: 'text',
        }),
      )
      .mockResolvedValueOnce(lookupResponse());
    const resolver = new FeishuForwardBundleResolver(lookup);

    await expect(resolver.resolveCompanion(note())).resolves.toBeUndefined();
    await expect(resolver.resolveCompanion(note())).resolves.toMatchObject({
      bundleId: 'om_forward',
    });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  test('uses original text/post structure instead of media placeholders', () => {
    expect(
      hasAuthoredFeishuText('text', JSON.stringify({ text: '说明' })),
    ).toBe(true);
    expect(
      hasAuthoredFeishuText(
        'post',
        JSON.stringify({
          post: {
            zh_cn: {
              content: [[{ tag: 'text', text: '补充说明' }]],
            },
          },
        }),
      ),
    ).toBe(true);
    expect(
      hasAuthoredFeishuText(
        'post',
        JSON.stringify({ zh_cn: { title: '补充标题', content: [] } }),
      ),
    ).toBe(true);
    expect(
      hasAuthoredFeishuText(
        'post',
        JSON.stringify({ content: [[{ tag: 'img', image_key: 'img_1' }]] }),
      ),
    ).toBe(false);
    expect(
      hasAuthoredFeishuText(
        'post',
        JSON.stringify({
          content: [[{ tag: 'img', image_key: 'img_1' }]],
          metadata: { title: '图片元数据，不是用户文字' },
        }),
      ),
    ).toBe(false);
    expect(
      hasAuthoredFeishuText(
        'image',
        JSON.stringify({ image_key: 'img_1', text: '[图片]' }),
      ),
    ).toBe(false);
  });
});
