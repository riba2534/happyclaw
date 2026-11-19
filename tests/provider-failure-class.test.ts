import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import {
  accountFailureNotice,
  isContextOverflowText,
  PROVIDER_CONTEXT_OVERFLOW_USER_NOTICE,
  PROVIDER_FAILURE_USER_NOTICE,
  PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE,
  PROVIDER_MODEL_CONFIG_USER_NOTICE,
  PROVIDER_REQUEST_REJECTED_USER_NOTICE,
  PROVIDER_TRANSIENT_FAILURE_USER_NOTICE,
  resolveProviderFailureClass,
  resolveTerminalProviderFailureNotice,
  upstreamErrorExcerpt,
} from '../src/provider-failure.js';
import { isContextOverflowText as runnerIsContextOverflowText } from '../container/agent-runner/src/provider-error-text.js';

const hostRunner = readFileSync('src/container-runner.ts', 'utf8');
const hostIndex = readFileSync('src/index.ts', 'utf8');
const agentRunner = readFileSync('container/agent-runner/src/index.ts', 'utf8');

describe('provider failure class resolution', () => {
  test('honours the class the runner reported', () => {
    expect(
      resolveProviderFailureClass({ providerFailureClass: 'transient' }),
    ).toBe('transient');
    expect(
      resolveProviderFailureClass({ providerFailureClass: 'config' }),
    ).toBe('config');
    expect(
      resolveProviderFailureClass({ providerFailureClass: 'account' }),
    ).toBe('account');
  });

  test('an unclassified failure keeps the historical account disposition', () => {
    // A runner built before the classification still frames outputs without the
    // field. Defaulting to `transient` there would silently stop quarantining a
    // genuinely dead account, so the safe default is the old behaviour.
    expect(resolveProviderFailureClass({})).toBe('account');
  });

  test('a batch-1 stall flag alone still avoids the account verdict', () => {
    // The liveness flag shipped one commit before the class did. An output
    // carrying only the flag must keep the never-quarantine disposition rather
    // than regress to the quota verdict the flag was introduced to remove.
    expect(resolveProviderFailureClass({ providerLivenessTimeout: true })).toBe(
      'transient',
    );
  });
});

describe('terminal provider failure notices', () => {
  test('each class names its own cause and none reuses the quota wording', () => {
    const notices = [
      PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE,
      PROVIDER_TRANSIENT_FAILURE_USER_NOTICE,
      PROVIDER_MODEL_CONFIG_USER_NOTICE,
    ];
    expect(new Set(notices).size).toBe(notices.length);
    for (const notice of notices) {
      expect(notice).not.toBe(PROVIDER_FAILURE_USER_NOTICE);
      expect(notice).not.toContain('额度已用尽');
    }
    // A config failure is the one case the user must act on, so it has to say
    // what to fix instead of suggesting a retry.
    expect(PROVIDER_MODEL_CONFIG_USER_NOTICE).toContain('模型配置');
    expect(PROVIDER_MODEL_CONFIG_USER_NOTICE).not.toContain('请稍后重新发送');
  });

  test('a silent stall and a reported upstream error are worded apart', () => {
    expect(
      resolveTerminalProviderFailureNotice({
        providerFailureClass: 'transient',
        providerLivenessTimeout: true,
      }),
    ).toBe(PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE);
    expect(
      resolveTerminalProviderFailureNotice({
        providerFailureClass: 'transient',
      }),
    ).toBe(PROVIDER_TRANSIENT_FAILURE_USER_NOTICE);
  });

  test('a config failure gets the configuration notice', () => {
    expect(
      resolveTerminalProviderFailureNotice({ providerFailureClass: 'config' }),
    ).toBe(PROVIDER_MODEL_CONFIG_USER_NOTICE);
  });

  // 2026-11-19: a magpie 400 read as "过载或服务端错误" hid what to fix.
  test("a refused request says so and carries the upstream's words", () => {
    const notice = resolveTerminalProviderFailureNotice({
      providerFailureClass: 'config',
      providerErrorText:
        'API Error: 400 tools.defer_loading: deferred tools are not loaded in place on this route',
    });
    expect(notice).toBe(
      `${PROVIDER_REQUEST_REJECTED_USER_NOTICE}\n上游返回：400 tools.defer_loading: deferred tools are not loaded in place on this route`,
    );
    expect(notice).not.toContain('模型名称');
  });

  test('an overflow left after compaction tells the user what to do', () => {
    expect(
      resolveTerminalProviderFailureNotice({
        providerFailureClass: 'config',
        providerErrorText:
          "Prompt is too long · the provider said: This model's maximum context length is 131072 tokens.",
      }),
    ).toMatch(
      new RegExp(
        `^${PROVIDER_CONTEXT_OVERFLOW_USER_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n上游返回：Prompt is too long`,
      ),
    );
    expect(PROVIDER_CONTEXT_OVERFLOW_USER_NOTICE).toContain('/fresh');
  });

  test("a reported transient error appends the upstream's words; a stall has none", () => {
    expect(
      resolveTerminalProviderFailureNotice({
        providerFailureClass: 'transient',
        providerErrorText: 'API Error: 529 Overloaded',
      }),
    ).toBe(
      `${PROVIDER_TRANSIENT_FAILURE_USER_NOTICE}\n上游返回：529 Overloaded`,
    );
    expect(
      resolveTerminalProviderFailureNotice({
        providerFailureClass: 'transient',
        providerLivenessTimeout: true,
        providerErrorText: 'API Error: 529 Overloaded',
      }),
    ).toBe(PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE);
  });

  test('an account failure keeps whatever notice the caller already resolved', () => {
    // Account walls carry the upstream limit text or the generic pool notice;
    // overwriting them here would discard the reset time the user needs.
    expect(
      resolveTerminalProviderFailureNotice({ providerFailureClass: 'account' }),
    ).toBeUndefined();
    expect(resolveTerminalProviderFailureNotice({})).toBeUndefined();
  });
});

describe('host disposition is keyed on the class, not on individual flags', () => {
  test('transient failures are replayed on the same connection', () => {
    expect(hostRunner).toMatch(
      /if \(failureClass === 'transient'\) \{[\s\S]*?transientRetries\.consume\([\s\S]*?resolveTransientRetryKey\(output\),[\s\S]*?selectedProfileId/,
    );
    // A connection is authoritative: nothing fails over to another one.
    expect(hostRunner).not.toContain('providerPool');
  });

  test('a repeated transient terminates without rewriting the class', () => {
    expect(hostRunner).toContain(
      'Transient provider failure repeated after its replay; ending the input',
    );
    expect(hostRunner).not.toContain(
      "output.providerFailureClass = 'account';",
    );
    expect(hostRunner).not.toContain('providerFailureEscalatedFrom');
  });

  test('the first transient failure still replays without touching the account', () => {
    expect(hostRunner).toMatch(
      /if \([\s\S]*?transientRetries\.consume\([\s\S]*?resolveTransientRetryKey\(output\),[\s\S]*?selectedProfileId[\s\S]*?\)[\s\S]*?\) \{\s*applyKnownProviderFailureDisposition\(output, false\);\s*return false;\s*\}/,
    );
  });

  test('config failures are terminal; only a usage limit with a reset waits', () => {
    expect(hostRunner).toMatch(
      /const terminal =\s*failureClass === 'config' \|\|\s*!deferUsageLimitFailure\(output, selectedProfileId, waitScope\);/,
    );
  });

  test('a session is cleared only for a real account switch', () => {
    expect(hostIndex).toContain(
      "resolveProviderFailureClass(output) === 'account' &&",
    );
    expect(hostIndex).not.toContain('!output.providerLivenessTimeout &&');
  });
});

describe('model fallback is visible to the user', () => {
  test('every activation path announces the downgrade before retrying', () => {
    const activations = agentRunner.match(
      /PROVIDER_FALLBACK_MODELS\.activateForScope\(/g,
    );
    expect(activations?.length).toBe(2);
    // A silent downgrade is indistinguishable from a primary-model reply, so
    // both retry paths must announce it — not just the structured one.
    expect(agentRunner.match(/emitModelFallbackNotice\(\);/g)?.length).toBe(2);
    expect(agentRunner).toContain("sourceKind: 'provider_fallback_notice'");
  });

  test('the notice names both models so the user can act on it', () => {
    expect(agentRunner).toContain('PROVIDER_FALLBACK_MODELS.primaryModel');
    expect(agentRunner).toMatch(
      /emitModelFallbackNotice[\s\S]{0,900}PROVIDER_FALLBACK_MODELS\.fallbackModel/,
    );
  });

  test('the notice is emitted before the retry marker, not after the answer', () => {
    // The notice has to precede providerFailureRetrying: emitting it later
    // would put it after the fallback answer the user is reading.
    for (const marker of agentRunner.matchAll(
      /emitModelFallbackNotice\(\);/g,
    )) {
      const after = agentRunner.slice(
        marker.index ?? 0,
        (marker.index ?? 0) + 400,
      );
      expect(after).toContain('providerFailureRetrying: true');
    }
  });
});

describe('account failure notice', () => {
  test("the runner's limit text stands; the generic notice gets the upstream's words", () => {
    expect(
      accountFailureNotice({
        providerFailureNotice: "You've hit your limit · resets 3pm",
        providerErrorText: 'API Error: 429 rate limited',
      }),
    ).toBe("You've hit your limit · resets 3pm");
    // 2026-11-20: magpie's 403 for a model the subscription lacks read as
    // "额度已用尽".
    expect(
      accountFailureNotice({
        providerErrorText:
          'API Error: 403 {"error":{"type":"permission_error","message":"Kimi Code: Your current subscription does not have access to Kimi Code right now."},"type":"error"}',
      }),
    ).toBe(
      `${PROVIDER_FAILURE_USER_NOTICE}\n上游返回：403 Kimi Code: Your current subscription does not have access to Kimi Code right now.`,
    );
    expect(accountFailureNotice({})).toBe(PROVIDER_FAILURE_USER_NOTICE);
  });
});

describe('upstream error excerpt', () => {
  test('takes the message of a JSON error body and keeps the status', () => {
    expect(
      upstreamErrorExcerpt(
        'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 200000 > 128000, which is the maximum"}}',
      ),
    ).toBe('400 max_tokens: 200000 > 128000, which is the maximum');
  });

  test('blanks addresses and key-shaped strings but keeps model names', () => {
    const excerpt = upstreamErrorExcerpt(
      'API Error: 403 user ops@example.com with key sk-ant-api03-abcdefgh12345678 and request 0123456789abcdef0123456789abcdef may not use anthropic/claude-opus-5-5-20251101',
    );
    expect(excerpt).toBe(
      '403 user [已隐藏] with key [已隐藏] and request [已隐藏] may not use anthropic/claude-opus-5-5-20251101',
    );
  });

  test('keeps what the user acts on: field names and model paths', () => {
    expect(
      upstreamErrorExcerpt(
        'API Error: 404 Publisher Model `projects/my-proj/locations/us-east5/publishers/anthropic/models/claude-opus-4-5` was not found',
      ),
    ).toBe(
      '404 Publisher Model `projects/my-proj/locations/us-east5/publishers/anthropic/models/claude-opus-4-5` was not found',
    );
    expect(
      upstreamErrorExcerpt(
        'API Error: 400 context_management.edits.0: clear_thinking_20251015_requires_thinking unsupported',
      ),
    ).toBe(
      '400 context_management.edits.0: clear_thinking_20251015_requires_thinking unsupported',
    );
    expect(
      upstreamErrorExcerpt(
        'API Error: 401 bad token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      ),
    ).toBe('401 bad token [已隐藏]');
  });

  test('blanks keys a gateway may echo back', () => {
    expect(
      upstreamErrorExcerpt(
        'API Error: 400 API key not valid: AIzaSyA1234567890abcdefghijklmnopqrstu (https://example.test/v1?key=abc123&alt=sse) Authorization: Bearer abc.def-ghi AKIAABCDEFGHIJKLMNOP',
      ),
    ).toBe(
      '400 API key not valid: [已隐藏] (https://example.test/v1?key=[已隐藏]&alt=sse) Authorization: Bearer [已隐藏] [已隐藏]',
    );
  });

  test('never cuts a character in half', () => {
    const excerpt = upstreamErrorExcerpt(`API Error: 400 ${'😀'.repeat(300)}`);
    expect(excerpt).toBe(`400 ${'😀'.repeat(236)}…`);
    expect(excerpt?.isWellFormed()).toBe(true);
  });

  test('keeps one short line', () => {
    const excerpt = upstreamErrorExcerpt(
      `API Error: 400 ${'word '.repeat(200)}`,
    );
    expect(excerpt?.length).toBeLessThanOrEqual(241);
    expect(excerpt?.endsWith('…')).toBe(true);
    expect(upstreamErrorExcerpt('API Error: 400 line one\n\nline two')).toBe(
      '400 line one line two',
    );
    expect(upstreamErrorExcerpt('   ')).toBeUndefined();
    expect(upstreamErrorExcerpt(undefined)).toBeUndefined();
  });
});

describe('context overflow wording', () => {
  // One table for the Runner's and the host's matcher, so they cannot drift.
  const overflow = [
    "Prompt is too long · the provider said: This model's maximum context length is 131072 tokens.",
    'prompt is too long: 1050000 tokens > 1000000 maximum',
    "This model's maximum prompt length is 131072 but the request contains 190011 tokens.",
    'context_length_exceeded: Input tokens exceed the configured limit',
    'The context window was exceeded',
    'Request context too large for model',
    'Input exceeds the token limit of 131072',
    'The input token count (190011) exceeds the maximum number of tokens allowed (131072).',
    'Input is too long for requested model.',
    'Too many input tokens',
    'API Error: 400 Your input exceeds the context window of this model.',
  ];
  const other = [
    'API Error: 400 model X does not support the 1M context window',
    'API Error: 400 tools.defer_loading: deferred tools are not loaded in place',
    'API Error: 400 Invalid value for temperature: must be between 0 and 1.',
    'API Error: 529 Overloaded',
  ];
  test.each(overflow)('overflow: %s', (text) => {
    expect(isContextOverflowText(text)).toBe(true);
    expect(runnerIsContextOverflowText(text)).toBe(true);
  });
  test.each(other)('not overflow: %s', (text) => {
    expect(isContextOverflowText(text)).toBe(false);
    expect(runnerIsContextOverflowText(text)).toBe(false);
  });
});
