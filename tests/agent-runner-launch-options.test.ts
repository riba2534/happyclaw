import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { resolveRunSdkThinking } from '../container/agent-runner/src/agent-effort.js';
import { pinBoundProviderSettings } from '../container/agent-runner/src/provider-env-pin.js';
import {
  assistantMessageText,
  PROVIDER_ERROR_TEXT_MAX_CHARS,
  providerErrorText,
} from '../container/agent-runner/src/provider-error-text.js';
import { pinToolSearch } from '../container/agent-runner/src/tool-search.js';
import { pinMaxOutputTokens } from '../container/agent-runner/src/max-output-pin.js';

const runner = fs.readFileSync(
  path.join(process.cwd(), 'container', 'agent-runner', 'src', 'index.ts'),
  'utf8',
);

describe('run thinking', () => {
  test('a model declared not to reason runs with thinking off', () => {
    expect(resolveRunSdkThinking({ thinking: 'disabled' })).toEqual({
      type: 'disabled',
    });
  });

  test('every other run lets the model decide and streams the summary', () => {
    expect(resolveRunSdkThinking({})).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });
  });

  test('the query takes the resolved option', () => {
    expect(runner).toContain(
      'const runThinking = resolveRunSdkThinking(containerInput);',
    );
    expect(runner).toContain('      thinking: runThinking,\n');
  });
});

describe('reply limit', () => {
  const pinned = pinBoundProviderSettings({
    ANTHROPIC_BASE_URL: 'http://bound',
  });

  test('a limit the host derived is pinned', () => {
    expect(pinMaxOutputTokens(pinned, 64_000).env).toEqual({
      ...pinned.env,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
    });
  });

  test('without one nothing is written, and an inherited value is not pinned', () => {
    expect(pinMaxOutputTokens(pinned, undefined)).toEqual(pinned);
    expect(
      pinBoundProviderSettings({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000' }).env,
    ).not.toHaveProperty('CLAUDE_CODE_MAX_OUTPUT_TOKENS');
  });
});

describe('tool search', () => {
  const pinned = pinBoundProviderSettings({
    ANTHROPIC_BASE_URL: 'http://bound',
  });

  test('a connection that turns it on pins true next to the bound connection', () => {
    const settings = pinToolSearch(pinned, true);
    expect(settings).toEqual({
      apiKeyHelper: '',
      env: { ...pinned.env, ENABLE_TOOL_SEARCH: 'true' },
    });
    expect(pinned.env).not.toHaveProperty('ENABLE_TOOL_SEARCH');
  });

  // Claude Code 2.1.304+ turns tool search on behind a custom endpoint by
  // itself, so a connection that has it off has to say so.
  test('a connection that has it off pins false', () => {
    expect(pinToolSearch(pinned, false)).toEqual({
      apiKeyHelper: '',
      env: { ...pinned.env, ENABLE_TOOL_SEARCH: 'false' },
    });
  });

  // Flag settings outrank every settings file, so a pinned 'false' would
  // undo a workspace's own ENABLE_TOOL_SEARCH.
  test('without a connection choice nothing is written, not even false', () => {
    expect(pinToolSearch(pinned, undefined)).toEqual(pinned);
  });
});

describe('provider error text', () => {
  test('is trimmed, and absent when there are no words', () => {
    expect(providerErrorText('  API Error: Request rejected (429)\n')).toBe(
      'API Error: Request rejected (429)',
    );
    expect(providerErrorText(' \n ')).toBeUndefined();
    expect(providerErrorText('')).toBeUndefined();
    expect(providerErrorText(null)).toBeUndefined();
    expect(providerErrorText(undefined)).toBeUndefined();
  });

  test(`is capped at ${PROVIDER_ERROR_TEXT_MAX_CHARS} characters`, () => {
    const long = `usage limit reached: ${'x'.repeat(2000)}`;
    const capped = providerErrorText(long);
    expect(PROVIDER_ERROR_TEXT_MAX_CHARS).toBe(1000);
    expect(capped).toHaveLength(1000);
    expect(long.startsWith(capped!)).toBe(true);
    const exact = 'y'.repeat(1000);
    expect(providerErrorText(exact)).toBe(exact);
  });

  test("comes from the text blocks of Claude Code's assistant error", () => {
    const message = {
      type: 'assistant',
      error: 'rate_limit',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'not the upstream' },
          {
            type: 'text',
            text: 'API Error: Request rejected (429) · usage limit reached: resets at 18:00',
          },
          { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: {} },
        ],
      },
    };
    expect(providerErrorText(assistantMessageText(message))).toBe(
      'API Error: Request rejected (429) · usage limit reached: resets at 18:00',
    );
    expect(
      assistantMessageText({
        message: {
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        },
      }),
    ).toBe('first\nsecond');
    expect(assistantMessageText({ message: { content: 'plain' } })).toBe(
      'plain',
    );
  });

  test('an assistant message without text has none', () => {
    expect(
      assistantMessageText({
        message: { content: [{ type: 'thinking', thinking: 'x' }] },
      }),
    ).toBeUndefined();
    expect(assistantMessageText({ message: {} })).toBeUndefined();
    expect(assistantMessageText({})).toBeUndefined();
    expect(assistantMessageText(null)).toBeUndefined();
  });

  test('only the assistant error and the compatibility text carry it', () => {
    expect(runner).toContain(
      'const upstreamText = providerErrorText(errorText);',
    );
    expect(runner).toContain(
      '...(upstreamText ? { providerErrorText: upstreamText } : {}),',
    );
    expect(runner).toMatch(
      /publishProviderFailure\(\{\s*error: assistantError,\s*failureClass: assistantErrorClass,\s*errorText: assistantMessageText\(message\),\s*\}\)/,
    );
    expect(runner).toMatch(
      /publishProviderFailure\(\{\s*error: 'rate_limit',\s*failureClass: 'account',\s*errorText: textResult,\s*\}\)/,
    );
    // The liveness watchdog and the rate-limit events have no upstream words.
    expect(runner.match(/^\s+errorText: /gm)).toHaveLength(2);
  });
});
