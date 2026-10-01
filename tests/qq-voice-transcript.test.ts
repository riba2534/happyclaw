import { describe, expect, test } from 'vitest';

import {
  getQQVoiceTranscript,
  isQQVoiceAttachment,
  withQQVoiceTranscript,
} from '../src/qq.js';

describe('QQ voice attachments', () => {
  test.each([
    [{ content_type: 'voice', url: 'https://x/a' }, true],
    [{ content_type: 'audio/amr' }, true],
    [{ filename: 'abc.amr' }, true],
    [{ url: 'https://x/abc.silk?t=1' }, true],
    [{ content_type: 'image/png', filename: 'a.png' }, false],
    [{ content_type: 'file', filename: 'report.pdf' }, false],
  ])('detects %j', (attachment, expected) => {
    expect(isQQVoiceAttachment(attachment)).toBe(expected);
  });

  test('uses the platform ASR transcript for voice attachments', () => {
    expect(
      getQQVoiceTranscript({
        content_type: 'voice',
        asr_refer_text: '  帮我查一下天气  ',
      }),
    ).toBe('帮我查一下天气');
  });

  test('ignores blank transcripts and non-voice attachments', () => {
    expect(
      getQQVoiceTranscript({ content_type: 'voice', asr_refer_text: '  ' }),
    ).toBeUndefined();
    expect(
      getQQVoiceTranscript({
        content_type: 'image/png',
        asr_refer_text: 'should not leak',
      }),
    ).toBeUndefined();
  });

  test('prepends the transcript to message content', () => {
    expect(withQQVoiceTranscript('', '你好')).toBe('[语音转文字] 你好');
    expect(withQQVoiceTranscript('附言', '你好')).toBe(
      '[语音转文字] 你好\n附言',
    );
    expect(withQQVoiceTranscript('附言', undefined)).toBe('附言');
  });
});
