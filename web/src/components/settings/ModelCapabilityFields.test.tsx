// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  resolveModelCapabilities,
  type ProviderModelEntry,
} from '@/lib/model-providers';
import {
  ModelCapabilityFields,
  withAddDefaults,
} from './ModelCapabilityFields';
import { click } from './test-helpers';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const FULL = ['low', 'medium', 'high', 'xhigh', 'max'];

describe('withAddDefaults', () => {
  test('an empty effort list is a declaration and stays empty', () => {
    // The shared resolver reads [] as declared, not as unknown.
    expect(
      resolveModelCapabilities({ id: 'acme/vx-mini', efforts: [] })
        .effortsSource,
    ).toBe('declared');
    expect(withAddDefaults({ id: 'acme/vx-mini', efforts: [] }, true)).toEqual({
      entry: { id: 'acme/vx-mini', efforts: [] },
      effortsUnverified: false,
      windowSuggested: false,
    });
  });

  test('a model nothing is known about gets every effort, unverified', () => {
    expect(withAddDefaults({ id: 'acme/vx-lab' }, true)).toEqual({
      entry: { id: 'acme/vx-lab', efforts: FULL },
      effortsUnverified: true,
      windowSuggested: false,
    });
  });

  test('declared efforts are left as they are', () => {
    expect(
      withAddDefaults({ id: 'acme/vx-pro', efforts: ['high'] }, true).entry,
    ).toEqual({ id: 'acme/vx-pro', efforts: ['high'] });
  });

  test('effort-suffixed relay variants pin that single effort and inherit the base window', () => {
    expect(withAddDefaults({ id: 'gemini-4-neon-high' }, true)).toEqual({
      entry: {
        id: 'gemini-4-neon-high',
        contextWindow: 1_048_576,
        efforts: ['high'],
      },
      effortsUnverified: false,
      windowSuggested: true,
    });
    expect(withAddDefaults({ id: 'gemini-4-neon-high' }, false)).toEqual({
      entry: { id: 'gemini-4-neon-high', efforts: ['high'] },
      effortsUnverified: false,
      windowSuggested: false,
    });
    // Unsupported suffix or -max model tier falls back to unverified full list.
    expect(withAddDefaults({ id: 'gemini-4-argon-xhigh' }, true)).toEqual({
      entry: { id: 'gemini-4-argon-xhigh', efforts: FULL },
      effortsUnverified: true,
      windowSuggested: false,
    });
    expect(withAddDefaults({ id: 'kimi-k3-max' }, true)).toEqual({
      entry: { id: 'kimi-k3-max', efforts: FULL },
      effortsUnverified: true,
      windowSuggested: false,
    });
  });
});

describe('ModelCapabilityFields', () => {
  let root: Root;
  let container: HTMLDivElement;
  const onChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(entry: ProviderModelEntry) {
    await act(async () => {
      root.render(<ModelCapabilityFields entry={entry} onChange={onChange} />);
    });
  }

  const group = () =>
    container.querySelector('[role="group"][aria-label$="的推理等级"]')!;
  const chips = () => [...group().querySelectorAll('button')];

  test('a model declared to take none keeps the levels to tick again', async () => {
    await render({ id: 'acme/vx-mini', efforts: [] });
    expect(group().textContent).toContain('不传档位');
    expect(chips().map((chip) => chip.getAttribute('aria-pressed'))).toEqual(
      FULL.map(() => 'false'),
    );
    await click(chips().find((chip) => chip.textContent === '高'));
    expect(onChange).toHaveBeenCalledWith(
      { id: 'acme/vx-mini', efforts: ['high'] },
      true,
    );
  });

  test('only a vendor that says the model does not reason marks it so', async () => {
    await render({ id: 'acme/vx-mini', efforts: [], thinks: false });
    expect(group().textContent).toContain('不推理');
  });

  test('unticking the last level stops passing an effort', async () => {
    await render({
      id: 'acme/vx-pro',
      efforts: ['high'],
      defaultEffort: 'high',
    });
    const high = chips().find((chip) => chip.textContent === '高')!;
    expect(high.disabled).toBe(false);
    await click(high);
    expect(onChange).toHaveBeenCalledWith(
      { id: 'acme/vx-pro', efforts: [] },
      true,
    );
    // An admin's empty list passes no effort but keeps thinking on.
    expect(
      resolveModelCapabilities({ id: 'acme/vx-pro', efforts: [] })
        .thinkingDisabled,
    ).toBe(false);
  });

  test('a model nothing is known about offers the levels to declare, marked 未知', async () => {
    await render({ id: 'acme/vx-lab' });
    expect(group().textContent).toContain('未知');
    expect(chips().map((chip) => chip.getAttribute('aria-pressed'))).toEqual(
      FULL.map(() => 'false'),
    );
    await click(chips().find((chip) => chip.textContent === '高'));
    expect(onChange).toHaveBeenCalledWith(
      { id: 'acme/vx-lab', efforts: ['high'] },
      true,
    );
  });

  test('an unknown model can be marked as passing no effort in one click', async () => {
    await render({ id: 'acme/vx-lab' });
    const clearButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '设为不传档位',
    );
    expect(clearButton).toBeTruthy();
    await click(clearButton);
    expect(onChange).toHaveBeenCalledWith(
      { id: 'acme/vx-lab', efforts: [] },
      true,
    );
  });

  test('a declared-none model does not show the one-click clear action', async () => {
    await render({ id: 'acme/vx-mini', efforts: [] });
    const clearButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '设为不传档位',
    );
    expect(clearButton).toBeUndefined();
  });
});
