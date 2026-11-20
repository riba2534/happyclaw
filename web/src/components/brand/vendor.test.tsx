// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, test } from 'vitest';

import { MODEL_PRESETS } from '@/lib/model-providers';
import { vendorOfConnection, vendorOfModel } from './vendor';
import { VENDOR_MARKS } from './vendorMarks';
import { VendorTile } from './VendorTile';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('vendorOfModel', () => {
  test('reads the maker from the name, or from a gateway prefix', () => {
    expect(vendorOfModel('claude-opus-5-5')).toBe('anthropic');
    expect(vendorOfModel('opus')).toBe('anthropic');
    expect(vendorOfModel('sonnet[1m]')).toBe('anthropic');
    expect(vendorOfModel('gpt-6.1-sol')).toBe('openai');
    expect(vendorOfModel('gemini-4-neon-medium')).toBe('gemini');
    expect(vendorOfModel('google/gemini-3.8-flash')).toBe('gemini');
    expect(vendorOfModel('glm-5.3[1m]')).toBe('zhipu');
    expect(vendorOfModel('kimi-k3.1-pro')).toBe('moonshot');
    expect(vendorOfModel('deepseek-v4-pro')).toBe('deepseek');
    expect(vendorOfModel('MiniMax-M3')).toBe('minimax');
    expect(vendorOfModel('qwen3.8-max')).toBe('alibaba');
    expect(vendorOfModel('mimo-v2.6-pro')).toBe('xiaomi');
    expect(vendorOfModel('z-ai/glm-5.2')).toBe('zhipu');
    expect(vendorOfModel('moonshotai/kimi-k2.6')).toBe('moonshot');
    expect(vendorOfModel('anthropic/claude-sonnet-4.6')).toBe('anthropic');
    expect(vendorOfModel('house-model')).toBeNull();
    expect(vendorOfModel('')).toBeNull();
  });
});

describe('vendorOfConnection', () => {
  test('a subscription by its kind, a preset or address by that, else its model', () => {
    expect(vendorOfConnection({ kind: 'official' })).toBe('anthropic');
    expect(vendorOfConnection({ kind: 'agy' })).toBe('antigravity');
    expect(vendorOfConnection({ kind: 'codex', model: 'glm-5' })).toBe(
      'openai',
    );
    expect(
      vendorOfConnection({
        kind: 'third_party',
        presetId: 'moonshot-kimi-code',
      }),
    ).toBe('kimi');
    expect(
      vendorOfConnection({
        kind: 'third_party',
        presetId: 'volcengine-coding-plan',
      }),
    ).toBe('bytedance');
    expect(
      vendorOfConnection({
        kind: 'third_party',
        baseUrl: 'https://api.deepseek.com/anthropic',
      }),
    ).toBe('deepseek');
    // A relay of known models takes its default model's maker.
    expect(
      vendorOfConnection({
        kind: 'third_party',
        baseUrl: 'https://relay.example.test',
        model: 'glm-5.3',
      }),
    ).toBe('zhipu');
    expect(
      vendorOfConnection({
        kind: 'third_party',
        baseUrl: 'https://relay.example.test',
        model: 'house-model',
      }),
    ).toBeNull();
    // A host only matches on a DNS boundary.
    expect(
      vendorOfConnection({
        kind: 'third_party',
        baseUrl: 'https://notdeepseek.com/x',
      }),
    ).toBeNull();
  });

  test('names only marks that exist, for every preset it knows', () => {
    for (const preset of MODEL_PRESETS) {
      const vendor = vendorOfConnection({
        kind: 'third_party',
        presetId: preset.id,
      });
      if (vendor) expect(VENDOR_MARKS[vendor], preset.id).toBeDefined();
    }
  });
});

describe('VendorTile', () => {
  test('draws the mark, or the first letter when none is known', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <>
          <VendorTile vendor="openai" name="ChatGPT 订阅" />
          <VendorTile vendor={null} name="relay 中转" size="sm" />
        </>,
      ),
    );
    const [mark, monogram] = [...container.children] as HTMLElement[];
    expect(mark.getAttribute('data-vendor')).toBe('openai');
    const svg = mark.querySelector('svg')!;
    expect(svg.getAttribute('fill-rule')).toBe('evenodd');
    expect(svg.querySelectorAll('path')).toHaveLength(
      VENDOR_MARKS.openai.paths.length,
    );
    expect(monogram.querySelector('svg')).toBeNull();
    expect(monogram.textContent).toBe('R');
    await act(async () => root.unmount());
    container.remove();
  });
});
