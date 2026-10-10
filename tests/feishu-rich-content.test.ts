import { describe, expect, test, vi } from 'vitest';
import {
  enrichFeishuInboundContent,
  normalizeFeishuInteractiveCard,
  type FeishuRichContentClient,
} from '../src/feishu-rich-content.js';

function parseContent(messageType: string, content: string) {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return { text: `[${messageType}]` };
  }
  if (messageType === 'text') return { text: String(parsed.text ?? '') };
  if (messageType === 'image') {
    const imageKey = String(parsed.image_key ?? '');
    return {
      text: imageKey ? '[图片]' : '',
      imageKeys: imageKey ? [imageKey] : [],
    };
  }
  return { text: `[${messageType}]` };
}

function clientWith(
  responder: (messageId: string) => unknown | Promise<unknown>,
): FeishuRichContentClient & { get: ReturnType<typeof vi.fn> } {
  const get = vi.fn(async (request: unknown) => {
    const messageId = (request as { path: { message_id: string } }).path
      .message_id;
    return responder(messageId);
  });
  return {
    im: { v1: { message: { get } } },
    get,
  };
}

describe('Feishu rich inbound normalization', () => {
  test('harvests real Schema 2.0 card text, controls, links and images', () => {
    const card = JSON.stringify({
      schema: '2.0',
      header: {
        title: { tag: 'plain_text', content: '发布审批' },
      },
      body: {
        elements: [
          { tag: 'markdown', content: '**服务**: HappyClaw\n环境: production' },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '查看详情' },
            url: 'https://example.com/runs/42',
          },
          { tag: 'img', img_key: 'img_v3_card_42', alt: { content: '架构图' } },
        ],
      },
    });

    const result = normalizeFeishuInteractiveCard(card);
    expect(result.text).toContain('发布审批');
    expect(result.text).toContain('**服务**: HappyClaw');
    expect(result.text).toContain('[查看详情](https://example.com/runs/42)');
    expect(result.text).toContain('[图片]');
    expect(result.imageKeys).toEqual(['img_v3_card_42']);
  });

  test('re-fetches merged-forward children from the official message.get shape', async () => {
    const client = clientWith(() => ({
      data: {
        items: [
          {
            message_id: 'om_forward',
            msg_type: 'merge_forward',
            body: { content: 'Merged and Forwarded Message' },
          },
          {
            message_id: 'om_child_text',
            upper_message_id: 'om_forward',
            msg_type: 'text',
            sender: { id: 'ou_alice', name: 'Alice' },
            body: { content: JSON.stringify({ text: '第一条真实消息' }) },
          },
          {
            message_id: 'om_child_card',
            upper_message_id: 'om_forward',
            msg_type: 'interactive',
            sender: { id: 'ou_bob', name: 'Bob' },
            body: {
              content: JSON.stringify({
                schema: '2.0',
                body: {
                  elements: [
                    { tag: 'markdown', content: '第二条卡片正文' },
                    { tag: 'img', img_key: 'img_v3_forwarded' },
                  ],
                },
              }),
            },
          },
        ],
      },
    }));

    const result = await enrichFeishuInboundContent({
      client,
      messageId: 'om_forward',
      messageType: 'merge_forward',
      fallbackText: '[合并转发消息]',
      parseContent,
    });

    expect(result.richMessageResolved).toBe(true);
    expect(result.text).toContain('Alice: 第一条真实消息');
    expect(result.text).toContain('Bob: 第二条卡片正文');
    expect(result.imageKeys).toEqual(['img_v3_forwarded']);
    expect(result.currentImageRefs).toEqual([
      {
        messageId: 'om_forward',
        imageKey: 'img_v3_forwarded',
      },
    ]);
    expect(client.get).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_forward' },
        params: { card_msg_content_type: 'user_card_content' },
      }),
    );
  });

  test('does not mark a placeholder-only merged-forward shell as resolved material', async () => {
    const client = clientWith(() => ({
      data: {
        items: [
          {
            message_id: 'om_forward_shell',
            msg_type: 'merge_forward',
            body: { content: 'Merged and Forwarded Message' },
          },
        ],
      },
    }));
    const result = await enrichFeishuInboundContent({
      client,
      messageId: 'om_note',
      messageType: 'text',
      fallbackText: '请分析',
      parentId: 'om_forward_shell',
      parseContent,
    });

    expect(result.references?.[0]?.id).toBe('om_forward_shell');
    expect(result.references?.[0].materialResolved).toBeUndefined();
  });

  test('does not mark a text-truncated merged-forward reference as complete', async () => {
    const forwardedText = '长材料'.repeat(4_000);
    const client = clientWith(() => ({
      data: {
        items: [
          {
            message_id: 'om_forward_long',
            msg_type: 'merge_forward',
            body: { content: 'Merged and Forwarded Message' },
          },
          {
            message_id: 'om_forward_long_child',
            upper_message_id: 'om_forward_long',
            msg_type: 'text',
            sender: { id: 'ou_alice', name: 'Alice' },
            body: { content: JSON.stringify({ text: forwardedText }) },
          },
        ],
      },
    }));

    const result = await enrichFeishuInboundContent({
      client,
      messageId: 'om_long_note',
      messageType: 'text',
      fallbackText: '请分析',
      parentId: 'om_forward_long',
      parseContent,
    });

    expect(result.references?.[0]?.text.length).toBeLessThan(
      forwardedText.length,
    );
    expect(result.references?.[0]?.materialResolved).toBeUndefined();
  });

  test('marks an item-capped merged-forward reference complete with an explicit note', async () => {
    const rootId = 'om_forward_over_item_limit';
    const client = clientWith(() => ({
      data: {
        items: [
          {
            message_id: rootId,
            msg_type: 'merge_forward',
            body: { content: 'Merged and Forwarded Message' },
          },
          ...['第一条', '第二条', '第三条'].map((text, index) => ({
            message_id: `${rootId}_child_${index}`,
            upper_message_id: rootId,
            msg_type: 'text',
            body: { content: JSON.stringify({ text }) },
          })),
        ],
      },
    }));

    const result = await enrichFeishuInboundContent({
      client,
      messageId: 'om_item_limit_note',
      messageType: 'text',
      fallbackText: '请分析',
      parentId: rootId,
      parseContent,
      limits: { maxForwardItems: 2 },
    });

    expect(result.references?.[0]?.text).toContain('第一条');
    expect(result.references?.[0]?.text).toContain('第二条');
    expect(result.references?.[0]?.text).not.toContain('第三条');
    // The cap is deterministic: retrying cannot recover the rest, so the
    // material is final and says so instead of being retried forever.
    expect(result.references?.[0]?.text).toContain('共 3 条，仅展示前 2 条');
    expect(result.references?.[0]?.materialResolved).toBe(true);
  });

  test('does not mark an internally truncated card child as complete', async () => {
    const rootId = 'om_forward_card_over_image_limit';
    const client = clientWith(() => ({
      data: {
        items: [
          {
            message_id: rootId,
            msg_type: 'merge_forward',
            body: { content: 'Merged and Forwarded Message' },
          },
          {
            message_id: `${rootId}_card`,
            upper_message_id: rootId,
            msg_type: 'interactive',
            body: {
              content: JSON.stringify({
                schema: '2.0',
                body: {
                  elements: ['img_1', 'img_2', 'img_3'].map((img_key) => ({
                    tag: 'img',
                    img_key,
                  })),
                },
              }),
            },
          },
        ],
      },
    }));

    const result = await enrichFeishuInboundContent({
      client,
      messageId: 'om_card_limit_note',
      messageType: 'text',
      fallbackText: '请分析',
      parentId: rootId,
      parseContent,
      limits: { maxImageKeys: 2 },
    });

    expect(result.references?.[0]?.text.match(/\[引用图片/g)).toHaveLength(2);
    expect(result.references?.[0]?.materialResolved).toBeUndefined();
  });

  test('keeps an ordinary reply chain separate from the current message', async () => {
    // Mirrors im.message.receive_v1: the new @ lives in an ordinary reply
    // chain (root_id is present) but has no native thread_id yet.
    const event = {
      message: {
        message_id: 'om_new_mention',
        root_id: 'om_root',
        parent_id: 'om_parent',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 请总结上面的讨论' }),
      },
    };
    const records: Record<string, unknown> = {
      om_parent: {
        data: {
          items: [
            {
              message_id: 'om_parent',
              parent_id: 'om_root',
              root_id: 'om_root',
              create_time: '2000',
              msg_type: 'text',
              sender: { id: 'ou_bob', name: 'Bob' },
              body: { content: JSON.stringify({ text: '第二条' }) },
            },
          ],
        },
      },
      om_root: {
        data: {
          items: [
            {
              message_id: 'om_root',
              create_time: '1000',
              msg_type: 'text',
              sender: { id: 'ou_alice', name: 'Alice' },
              body: { content: JSON.stringify({ text: '第一条' }) },
            },
          ],
        },
      },
    };
    const client = clientWith((messageId) => records[messageId]);

    const result = await enrichFeishuInboundContent({
      client,
      messageId: event.message.message_id,
      messageType: event.message.message_type,
      fallbackText: '请总结上面的讨论',
      parentId: event.message.parent_id,
      nativeRootId: event.message.root_id,
      parseContent,
    });

    expect(result.referencedMessages).toBe(2);
    expect(result.text).toBe('请总结上面的讨论');
    expect(result.references).toEqual([
      { id: 'om_root', sender: 'Alice', text: '第一条' },
      { id: 'om_parent', sender: 'Bob', text: '第二条' },
    ]);
    expect(
      client.get.mock.calls.map((call) => call[0].path.message_id),
    ).toEqual(['om_parent', 'om_root']);
  });

  test('bounds cyclic reference chains and merged-forward item counts', async () => {
    const client = clientWith((messageId) => ({
      data: {
        items: [
          {
            message_id: messageId,
            parent_id: messageId === 'om_a' ? 'om_b' : 'om_a',
            msg_type: 'text',
            body: { content: JSON.stringify({ text: messageId }) },
          },
        ],
      },
    }));
    const result = await enrichFeishuInboundContent({
      client,
      messageId: 'om_current',
      messageType: 'text',
      fallbackText: 'current',
      parentId: 'om_a',
      parseContent,
      limits: { maxReferenceDepth: 20 },
    });
    expect(result.referencedMessages).toBe(2);
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  test('retains the triggering request when quoted content exhausts the text budget', async () => {
    const client = clientWith(() => ({
      data: {
        items: [
          {
            message_id: 'om_parent',
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'x'.repeat(500) }) },
          },
        ],
      },
    }));
    const result = await enrichFeishuInboundContent({
      client,
      messageId: 'om_current',
      messageType: 'text',
      fallbackText: '必须保留的当前请求',
      parentId: 'om_parent',
      parseContent,
      limits: { maxTextChars: 120 },
    });
    expect(result.text).toBe('必须保留的当前请求');
    expect(result.references?.[0].text.length).toBeLessThanOrEqual(60);
  });

  test('keeps referenced image ownership so callers download from the quoted message', async () => {
    const client = clientWith(() => ({
      data: {
        items: [
          {
            message_id: 'om_image_parent',
            msg_type: 'image',
            body: { content: JSON.stringify({ image_key: 'img_v3_parent' }) },
          },
        ],
      },
    }));
    const result = await enrichFeishuInboundContent({
      client,
      messageId: 'om_current',
      messageType: 'text',
      fallbackText: '这张图是什么？',
      parentId: 'om_image_parent',
      parseContent,
    });
    expect(result.referencedImageRefs).toEqual([
      {
        messageId: 'om_image_parent',
        referenceMessageId: 'om_image_parent',
        imageKey: 'img_v3_parent',
        marker: '[引用图片 1]',
      },
    ]);
    expect(result.text).toBe('这张图是什么？');
    expect(result.references?.[0].text).toContain('[引用图片 1]');
    expect(result.imageKeys).toBeUndefined();
  });

  test('does not fetch referenced image bytes when their marker cannot fit', async () => {
    const client = clientWith(() => ({
      data: {
        items: [
          {
            message_id: 'om_image_parent',
            msg_type: 'image',
            body: { content: JSON.stringify({ image_key: 'img_v3_parent' }) },
          },
        ],
      },
    }));
    const result = await enrichFeishuInboundContent({
      client,
      messageId: 'om_current',
      messageType: 'text',
      fallbackText: '当前消息',
      parentId: 'om_image_parent',
      parseContent,
      limits: { maxTextChars: 10 },
    });

    expect(result.referencedImageRefs).toBeUndefined();
    expect(result.references?.[0].text).not.toContain('[引用图');
  });

  test('uses outer ownership for images inside a referenced merged forward', async () => {
    const client = clientWith(() => ({
      data: {
        items: [
          {
            message_id: 'om_forward_parent',
            msg_type: 'merge_forward',
            body: { content: 'Merged and Forwarded Message' },
          },
          {
            message_id: 'om_forward_child_image',
            upper_message_id: 'om_forward_parent',
            msg_type: 'image',
            body: {
              content: JSON.stringify({ image_key: 'img_v3_child_owned' }),
            },
          },
        ],
      },
    }));
    const result = await enrichFeishuInboundContent({
      client,
      messageId: 'om_current',
      messageType: 'text',
      fallbackText: '看看转发里的图',
      parentId: 'om_forward_parent',
      parseContent,
    });

    expect(result.referencedImageRefs).toEqual([
      {
        messageId: 'om_forward_parent',
        referenceMessageId: 'om_forward_parent',
        imageKey: 'img_v3_child_owned',
        marker: '[引用图片 1]',
      },
    ]);
  });

  test('falls back immediately when rich lookup rejects', async () => {
    const client = clientWith(async () => {
      throw new Error('tenant API unavailable');
    });
    const result = await enrichFeishuInboundContent({
      client,
      messageId: 'om_card',
      messageType: 'interactive',
      fallbackText: '[飞书卡片消息]',
      fallbackImageKeys: ['img_v3_event'],
      parseContent,
    });
    expect(result).toEqual({
      text: '[飞书卡片消息]',
      imageKeys: ['img_v3_event'],
      currentImageRefs: [{ messageId: 'om_card', imageKey: 'img_v3_event' }],
      richMessageResolved: false,
      referencedMessages: 0,
    });
  });

  test('enforces an overall timeout without blocking the admitted message', async () => {
    vi.useFakeTimers();
    try {
      const client = clientWith(() => new Promise(() => {}));
      const pending = enrichFeishuInboundContent({
        client,
        messageId: 'om_card',
        messageType: 'interactive',
        fallbackText: '[飞书卡片消息]',
        parseContent,
        limits: { requestTimeoutMs: 5_000, totalTimeoutMs: 25 },
      });
      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toMatchObject({
        text: '[飞书卡片消息]',
        richMessageResolved: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
