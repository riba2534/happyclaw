import { describe, expect, test } from 'vitest';
import {
  classifyFeishuError,
  feishuErrorCode,
  neutralizeFeishuMentions,
} from '../src/feishu-errors';

const axios = (
  status: number,
  code: number,
  headers: Record<string, string> = {},
) => ({
  code: 'ERR_BAD_REQUEST',
  message: `Request failed with status code ${status}`,
  response: { status, data: { code, msg: 'x' }, headers },
});

describe('feishuErrorCode', () => {
  test('reads the body code of an SDK AxiosError, not its string code', () => {
    expect(feishuErrorCode(axios(400, 300309))).toBe(300309);
  });
  test('reads top-level codes from resolved envelopes', () => {
    expect(feishuErrorCode({ code: 230020, msg: 'limit' })).toBe(230020);
    expect(feishuErrorCode({ data: { code: '200850' } })).toBe(200850);
  });
});

describe('classifyFeishuError', () => {
  test('rate limits carry the platform wait', () => {
    expect(classifyFeishuError(axios(400, 230020))).toMatchObject({
      kind: 'rate_limited',
      code: 230020,
    });
    expect(
      classifyFeishuError(
        axios(429, 99991400, { 'x-ogw-ratelimit-reset': '3' }),
      ),
    ).toMatchObject({ kind: 'rate_limited', retryAfterMs: 3000 });
  });
  test('recalled anchors, closed streaming and DLP have their own kinds', () => {
    expect(classifyFeishuError(axios(400, 230011)).kind).toBe(
      'target_unavailable',
    );
    expect(classifyFeishuError(axios(400, 200850)).kind).toBe(
      'streaming_closed',
    );
    expect(classifyFeishuError(axios(400, 230028))).toMatchObject({
      kind: 'content_rejected',
      reason: expect.stringContaining('敏感信息'),
    });
  });
  test('other 4xx are definitive; no response, 5xx and 408 stay transient', () => {
    expect(classifyFeishuError(axios(400, 99999)).kind).toBe('definitive');
    expect(classifyFeishuError(new Error('socket hang up')).kind).toBe(
      'transient',
    );
    expect(
      classifyFeishuError({ response: { status: 502, data: {} } }).kind,
    ).toBe('transient');
    expect(
      classifyFeishuError({ response: { status: 408, data: {} } }).kind,
    ).toBe('transient');
  });
});

describe('neutralizeFeishuMentions', () => {
  test('escapes <at> outside code for cards and text', () => {
    const md = 'hi <at id=all></at> and <AT user_id="all">x</AT>';
    expect(neutralizeFeishuMentions(md, 'card')).toBe(
      'hi &#60;at id=all></at> and &#60;at user_id="all">x</AT>',
    );
    expect(neutralizeFeishuMentions(md, 'text')).toContain('＜at id=all>');
  });
  test('leaves fenced and inline code untouched', () => {
    const md =
      'use `<at id=all>` here\n```html\n<at id=all></at>\n```\n<at email=a@b.c>';
    const out = neutralizeFeishuMentions(md, 'card');
    expect(out).toContain('`<at id=all>`');
    expect(out).toContain('```html\n<at id=all></at>\n```');
    expect(out.endsWith('&#60;at email=a@b.c>')).toBe(true);
  });
});
