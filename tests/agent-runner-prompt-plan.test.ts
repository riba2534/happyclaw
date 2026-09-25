import { describe, expect, test } from 'vitest';

import {
  buildHappyClawPromptPlan,
  createPromptPlan,
  hasBackgroundTaskTools,
} from '../container/agent-runner/src/prompt-plan.js';

describe('HappyClaw PromptPlan', () => {
  test('keeps identity first and includes only capabilities that are active', () => {
    const plan = buildHappyClawPromptPlan({
      platformIdentity: 'built-in HappyClaw identity',
      platformBootstrap: 'first wake',
      agentIdentity: '<agent-identity>MAIN_MARKER</agent-identity>',
      interaction: 'interaction',
      security: 'security',
      memory: { id: 'memory-system.workspace', text: 'memory' },
      output: 'output',
      web: 'web',
      channel: { id: 'telegram', text: 'telegram' },
      deliveryContract: 'delivery',
    });

    expect(plan.blocks.map((block) => block.id)).toEqual([
      'identity.happyclaw',
      'bootstrap.happyclaw',
      'agent-profile',
      'interaction',
      'security-rules',
      'memory-system.workspace',
      'output',
      'web-fetch',
      'channel.telegram',
      'delivery-contract',
    ]);
    expect(plan.blocks.some((block) => block.id === 'skill-routing')).toBe(
      false,
    );
    expect(plan.blocks.some((block) => block.id === 'background-tasks')).toBe(
      false,
    );
    expect(plan.blocks[0]).toMatchObject({
      owner: 'platform',
      scope: 'main',
      required: true,
    });
    expect(plan.blocks[1]).toMatchObject({
      owner: 'platform',
      scope: 'main',
      required: false,
    });
    expect(plan.blocks[2]).toMatchObject({
      owner: 'agent_profile',
      scope: 'main',
      required: false,
    });
    expect(plan.blocks.find((block) => block.id === 'web-fetch')).toMatchObject(
      { condition: 'WebSearch or WebFetch is available' },
    );
  });

  test('does not inject built-in identity or bootstrap into a custom Agent', () => {
    const plan = buildHappyClawPromptPlan({
      agentIdentity: 'custom identity',
      interaction: 'interaction',
      security: 'security',
      output: 'output',
    });

    expect(plan.blocks.map((block) => block.id)).toEqual([
      'agent-profile',
      'interaction',
      'security-rules',
      'output',
    ]);
  });

  test('background-task guidance needs only Task now that TaskOutput is gone', () => {
    // Claude Code 2.1.277 removed TaskOutput; Task still starts background
    // agents and their completion arrives as a task notification.
    expect(hasBackgroundTaskTools(['Bash', 'Read', 'Task', 'TaskStop'])).toBe(
      true,
    );
    expect(hasBackgroundTaskTools(['Bash', 'Read', 'TaskStop'])).toBe(false);

    const plan = buildHappyClawPromptPlan({
      interaction: 'interaction',
      security: 'security',
      output: 'output',
      backgroundTasks: 'background tasks',
    });
    expect(
      plan.blocks.find((block) => block.id === 'background-tasks'),
    ).toMatchObject({ condition: 'Task is available' });
  });

  test('hashes are deterministic and content-sensitive', () => {
    const base = [
      {
        id: 'one',
        version: 1,
        scope: 'main' as const,
        owner: 'platform' as const,
        required: true,
        condition: 'always',
        text: 'same',
      },
    ];
    const first = createPromptPlan(base);
    const second = createPromptPlan(base);
    const changed = createPromptPlan([{ ...base[0], text: 'different' }]);
    const metadataChanged = createPromptPlan([
      { ...base[0], condition: 'feature enabled' },
    ]);

    expect(first.hash).toBe(second.hash);
    expect(first.blocks[0].hash).toBe(second.blocks[0].hash);
    expect(first.estimatedTokens).toBeGreaterThan(0);
    expect(first.totalBytes).toBe(Buffer.byteLength('same'));
    expect(changed.hash).not.toBe(first.hash);
    expect(changed.blocks[0].hash).not.toBe(first.blocks[0].hash);
    expect(metadataChanged.blocks[0].hash).toBe(first.blocks[0].hash);
    expect(metadataChanged.hash).not.toBe(first.hash);
  });

  test('reports oversized generated plans instead of truncating them', () => {
    const huge = createPromptPlan([
      {
        id: 'huge',
        version: 1,
        scope: 'main',
        owner: 'agent_profile',
        required: false,
        condition: 'agent profile configured',
        text: '\u4e2d'.repeat(100_000),
      },
    ]);

    expect(huge.blocks[0].text).toHaveLength(100_000);
    expect(huge.warnings).toHaveLength(1);
    expect(huge.errors).toHaveLength(1);
  });

  test('rejects empty required blocks and duplicate ids', () => {
    const plan = createPromptPlan([
      {
        id: 'required',
        version: 1,
        scope: 'main',
        owner: 'platform',
        required: true,
        condition: 'always',
        text: '   ',
      },
      {
        id: 'duplicate',
        version: 1,
        scope: 'main',
        owner: 'platform',
        required: false,
        condition: 'feature one',
        text: 'one',
      },
      {
        id: 'duplicate',
        version: 1,
        scope: 'main',
        owner: 'platform',
        required: false,
        condition: 'feature two',
        text: 'two',
      },
    ]);

    expect(plan.errors).toEqual([
      'required prompt block is empty: required',
      'duplicate prompt block id: duplicate',
    ]);
    expect(plan.blocks.map((block) => block.id)).toEqual([
      'duplicate',
      'duplicate',
    ]);
  });

  test('budgets the exact joined prompt including block separators', () => {
    const blocks = ['甲', 'second'].map((text, index) => ({
      id: `block-${index}`,
      version: 1,
      scope: 'main' as const,
      owner: 'platform' as const,
      required: true,
      condition: 'always',
      text,
    }));
    const plan = createPromptPlan(blocks);

    expect(plan.text).toBe('甲\nsecond');
    expect(plan.totalBytes).toBe(Buffer.byteLength(plan.text, 'utf8'));
    expect(plan.estimatedTokens).toBeGreaterThan(0);
  });
});
