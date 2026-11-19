import { describe, expect, test } from 'vitest';

import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';

import { calculateStaticStartupTokens } from '../container/agent-runner/src/context-budget.js';
import { pinBoundProviderSettings } from '../container/agent-runner/src/provider-env-pin.js';
import {
  pinSubagentConcurrency,
  sdkSubagentDefinitions,
  subagentConcurrencyEnv,
} from '../container/agent-runner/src/subagent-launch.js';

const agents = {
  reviewer: { description: 'Reviews diffs', prompt: 'Review.' },
};

describe('sub-agent concurrency cap', () => {
  const pinned = pinBoundProviderSettings({
    ANTHROPIC_BASE_URL: 'http://bound',
  });

  test('the Agent’s cap goes to the CLI and is pinned above settings files', () => {
    expect(subagentConcurrencyEnv({ maxConcurrent: 3 })).toEqual({
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '3',
    });
    expect(pinSubagentConcurrency(pinned, { maxConcurrent: 3 })).toEqual({
      ...pinned,
      env: { ...pinned.env, CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '3' },
    });
  });

  test('without a cap nothing is written, so Claude Code’s own limit stays', () => {
    for (const subagents of [undefined, {}, { agents }]) {
      expect(subagentConcurrencyEnv(subagents)).toEqual({});
      expect(pinSubagentConcurrency(pinned, subagents)).toBe(pinned);
    }
    // Not a cap the host would send.
    expect(subagentConcurrencyEnv({ maxConcurrent: 0 })).toEqual({});
    expect(subagentConcurrencyEnv({ maxConcurrent: 2.5 })).toEqual({});
  });
});

describe('custom sub-agents', () => {
  test('a session gets the Agent’s custom sub-agents', () => {
    expect(sdkSubagentDefinitions({ subagents: { agents } })).toBe(agents);
    expect(
      sdkSubagentDefinitions({ subagents: { agents }, workMode: 'multi' }),
    ).toBe(agents);
    expect(
      sdkSubagentDefinitions({
        subagents: { agents },
        teamRole: { role: 'worker', origin: 'team' } as never,
      }),
    ).toBe(agents);
  });

  test('a team router only routes and gets none', () => {
    expect(
      sdkSubagentDefinitions({
        subagents: { agents },
        teamRole: { role: 'router' } as never,
      }),
    ).toBeUndefined();
  });

  test('none set, none passed', () => {
    expect(sdkSubagentDefinitions({})).toBeUndefined();
    expect(
      sdkSubagentDefinitions({ subagents: { maxConcurrent: 2, agents: {} } }),
    ).toBeUndefined();
  });

  test('their descriptions count toward the startup context budget', () => {
    const usage = {
      memoryFiles: [],
      mcpTools: [],
      systemPromptSections: [{ name: 'HappyClaw', tokens: 1_000 }],
      agents: [{ agentType: 'reviewer', source: 'flagSettings', tokens: 250 }],
    } as unknown as SDKControlGetContextUsageResponse;
    expect(calculateStaticStartupTokens(usage)).toBe(1_250);
  });
});
