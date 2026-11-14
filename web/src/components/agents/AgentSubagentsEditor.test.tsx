// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { AgentSubagentPolicy } from '@/types';
import {
  AgentSubagentsEditor,
  compactSubagentPolicy,
  subagentPolicyWithoutModels,
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

  test('without the Agent’s own connection no sub-agent model can be picked', () => {
    render(null);
    const trigger = container!.querySelector<HTMLButtonElement>(
      '[aria-label="智能体默认子代理模型"]',
    )!;
    expect(trigger.disabled).toBe(true);
    expect(container!.textContent).toContain('为本智能体选择自己的模型连接');
  });
});
