import { describe, expect, test } from 'vitest';

import {
  PRUNED_HISTORY_IMAGE_MARKER,
  pruneProcessedHistoryImagesInTranscriptContent,
} from '../container/agent-runner/src/history-image-prune.js';

const makeImageBlock = (data = 'image-data', mediaType = 'image/png') => ({
  type: 'image',
  source: { type: 'base64', media_type: mediaType, data },
});

describe('pruneProcessedHistoryImagesInTranscriptContent', () => {
  test('保留最后一条 assistant 之后的图片，裁剪之前的历史图片', () => {
    const transcript = [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-04-14T02:03:04.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '历史图片' },
            { type: 'text', text: '[图片: downloads/old.png]' },
            makeImageBlock('old-base64'),
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '已处理' }],
        },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-04-14T03:03:04.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '最新图片' },
            makeImageBlock('latest-base64'),
          ],
        },
      }),
    ].join('\n');

    const result = pruneProcessedHistoryImagesInTranscriptContent(transcript);
    const entries = result.content.split('\n').map((line) => JSON.parse(line));

    expect(result.didMutate).toBe(true);
    expect(result.prunedImages).toBe(1);
    expect(entries[0].message.content).toEqual([
      { type: 'text', text: '历史图片' },
      { type: 'text', text: '[图片: downloads/old.png]' },
      {
        type: 'text',
        text: `${PRUNED_HISTORY_IMAGE_MARKER} [图片: downloads/old.png]`,
      },
    ]);
    expect(entries[2].message.content[1]).toEqual(
      makeImageBlock('latest-base64'),
    );
  });

  test('幂等，第二次执行不再修改 transcript', () => {
    const transcript = [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-04-14T02:03:04.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '历史图片' },
            { type: 'text', text: '[历史图片已归档 2026-04-14 02:03]' },
            {
              type: 'text',
              text: '[image data removed - already processed by model (640×480 image/png)]',
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '已处理' }],
        },
      }),
    ].join('\n');

    const firstRun = pruneProcessedHistoryImagesInTranscriptContent(
      transcript,
      {
        getImageDimensions: () => ({ width: 640, height: 480 }),
      },
    );
    const secondRun = pruneProcessedHistoryImagesInTranscriptContent(
      firstRun.content,
      {
        getImageDimensions: () => ({ width: 640, height: 480 }),
      },
    );

    expect(firstRun.didMutate).toBe(false);
    expect(secondRun.didMutate).toBe(false);
    expect(secondRun.prunedImages).toBe(0);
    expect(secondRun.content).toBe(transcript);
  });

  test('被裁消息保留图片线索，没有 [图片:] 时补 [历史图片已归档 ...] 和尺寸信息', () => {
    const transcript = [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-04-14T12:34:56.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '帮我看看这张图' },
            makeImageBlock('needs-dims', 'image/jpeg'),
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '已处理' }],
        },
      }),
    ].join('\n');

    const result = pruneProcessedHistoryImagesInTranscriptContent(transcript, {
      getImageDimensions: (data) =>
        data === 'needs-dims' ? { width: 1024, height: 768 } : null,
    });
    const [entry] = result.content.split('\n').map((line) => JSON.parse(line));

    expect(result.didMutate).toBe(true);
    expect(entry.message.content).toEqual([
      { type: 'text', text: '帮我看看这张图' },
      {
        type: 'text',
        text: '[image data removed - already processed by model (原 1024×768 image/jpeg)]',
      },
      { type: 'text', text: '[历史图片已归档 2026-04-14 12:34]' },
    ]);
  });

  test('tool_result 中的图片也会被处理', () => {
    const transcript = [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-04-14T12:34:56.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: [
                { type: 'text', text: '截图结果' },
                makeImageBlock('tool-result', 'image/webp'),
              ],
            },
          ],
        },
        toolUseResult: [
          { type: 'text', text: '截图结果' },
          makeImageBlock('tool-result', 'image/webp'),
        ],
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '已处理' }],
        },
      }),
    ].join('\n');

    const result = pruneProcessedHistoryImagesInTranscriptContent(transcript, {
      getImageDimensions: () => ({ width: 300, height: 200 }),
    });
    const [entry] = result.content.split('\n').map((line) => JSON.parse(line));

    expect(result.prunedImages).toBe(2);
    expect(entry.message.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: [
          { type: 'text', text: '截图结果' },
          {
            type: 'text',
            text: '[image data removed - already processed by model (原 300×200 image/webp)]',
          },
        ],
      },
      { type: 'text', text: '[历史图片已归档 2026-04-14 12:34]' },
    ]);
    expect(entry.toolUseResult).toEqual([
      { type: 'text', text: '截图结果' },
      {
        type: 'text',
        text: '[image data removed - already processed by model (原 300×200 image/webp)]',
      },
    ]);
  });

  test('assistant 自身的 image block 不被触碰', () => {
    const transcript = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [
            { type: 'text', text: '这是结果图' },
            makeImageBlock('assistant-image'),
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-04-14T12:34:56.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '下一轮输入' },
            makeImageBlock('latest-user-image'),
          ],
        },
      }),
    ].join('\n');

    const result = pruneProcessedHistoryImagesInTranscriptContent(transcript);
    const entries = result.content.split('\n').map((line) => JSON.parse(line));

    expect(result.didMutate).toBe(false);
    expect(entries[0].message.content[1]).toEqual(
      makeImageBlock('assistant-image'),
    );
    expect(entries[1].message.content[1]).toEqual(
      makeImageBlock('latest-user-image'),
    );
  });
});
