// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { AgentSubagentPolicy, ConnectionModel } from '@/types';
import {
  AgentSubagentsEditor,
  compactSubagentPolicy,
  invalidSubagentTool,
  parseSubagentTools,
  subagentDefinitionError,
  subagentEffortChoices,
  subagentPolicyWithoutModels,
  unavailableSubagentTools,
} from './AgentSubagentsEditor';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const policy: AgentSubagentPolicy = {
  model: 'flash',
  max_concurrent: null,
  definitions: [
    {
      name: 'reviewer',
      description: 'Reviews diffs',
      prompt: 'Review.',
      tools: ['Read'],
      model: 'pro',
      effort: 'high',
    },
  ],
};

describe('sub-agent policy helpers', () => {
  test('nothing set saves as null', () => {
    expect(
      compactSubagentPolicy({
        model: null,
        max_concurrent: null,
        definitions: [],
      }),
    ).toBeNull();
    expect(compactSubagentPolicy(policy)).toBe(policy);
  });

  test('another connection drops every model name but keeps definitions', () => {
    expect(subagentPolicyWithoutModels(policy)).toEqual({
      model: null,
      max_concurrent: null,
      definitions: [{ ...policy.definitions[0], model: null }],
    });
    expect(
      subagentPolicyWithoutModels({ ...policy, definitions: [] }),
    ).toBeNull();
  });
});

describe('tool rules', () => {
  test('one per line or comma-separated; a rule keeps its argument', () => {
    expect(
      parseSubagentTools('Read, Grep\nBash(git log:*)\n\n Read ，WebFetch'),
    ).toEqual(['Read', 'Grep', 'Bash(git log:*)', 'WebFetch']);
  });

  test('a rule the server would refuse is named', () => {
    expect(invalidSubagentTool(['Read', 'Bash(git log:*)'])).toBeNull();
    expect(invalidSubagentTool(['Read', 'two words'])).toBe('two words');
    expect(invalidSubagentTool(['Bash(unclosed'])).toBe('Bash(unclosed');
  });

  test('tools no session has are named, and a list of only them is refused', () => {
    expect(
      unavailableSubagentTools(['Read', 'EnterPlanMode', 'CronList(x)']),
    ).toEqual(['EnterPlanMode', 'CronList(x)']);
    const withTools = (tools: string[] | null) =>
      subagentDefinitionError(
        {
          name: 'planner',
          description: 'Plans work',
          prompt: 'Plan.',
          tools,
          model: null,
          effort: null,
        },
        [],
      );
    expect(withTools(['EnterPlanMode'])).toContain('都不可用');
    expect(withTools(['EnterPlanMode', 'ExitPlanMode'])).toContain('都不可用');
    expect(withTools(['EnterPlanMode', 'Read'])).toBeNull();
    expect(withTools(null)).toBeNull();
  });
});

describe('sub-agent effort choices', () => {
  const model = (patch: Partial<ConnectionModel>): ConnectionModel => ({
    id: 'm',
    efforts: [],
    defaultEffort: null,
    contextWindow: null,
    ...patch,
  });

  test('the levels the model takes', () => {
    expect(
      subagentEffortChoices(
        model({ efforts: ['low', 'high'], effortsSource: 'registry' }),
      ),
    ).toEqual({ efforts: ['low', 'high'], unverified: false });
  });

  test('none for a model declared to take none', () => {
    expect(
      subagentEffortChoices(model({ efforts: [], effortsSource: 'declared' })),
    ).toEqual({ efforts: [], unverified: false });
  });

  test('every level, unverified, for a model nothing is known about', () => {
    expect(
      subagentEffortChoices(model({ efforts: [], effortsSource: 'none' })),
    ).toEqual({
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      unverified: true,
    });
  });

  test('every level while it follows a model the form cannot name', () => {
    expect(subagentEffortChoices(undefined)).toEqual({
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      unverified: false,
    });
  });
});

describe('AgentSubagentsEditor', () => {
  function render(
    connectionModels: Array<{ id: string; efforts: string[] }> | null,
  ) {
    const onChange = vi.fn();
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
    act(() =>
      root!.render(
        <AgentSubagentsEditor
          value={policy}
          onChange={onChange}
          connectionModels={connectionModels as never}
          labelPrefix="智能体"
        />,
      ),
    );
    return onChange;
  }

  test('lists the definitions with their model and effort', () => {
    render([{ id: 'pro', efforts: ['high'] }]);
    expect(container!.textContent).toContain('reviewer');
    expect(container!.textContent).toContain('Reviews diffs');
    expect(container!.textContent).toContain('pro');
  });

  test('says what the cap does without promising a number', () => {
    render([{ id: 'pro', efforts: ['high'] }]);
    const text = container!.textContent ?? '';
    expect(text).toContain('达到上限后，Claude Code 会拒绝再派出新的子代理');
    expect(text).not.toContain('排队');
    expect(text).not.toContain('默认（20）');
  });

  test('without the Agent’s own connection no sub-agent model can be picked', () => {
    render(null);
    const trigger = container!.querySelector<HTMLButtonElement>(
      '[aria-label="智能体默认子代理模型"]',
    )!;
    expect(trigger.disabled).toBe(true);
    expect(container!.textContent).toContain('为本智能体选择自己的模型连接');
  });
});
