import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mergeCatalogModels } = await import('../src/model-catalog-sync.js');
const { MODEL_EFFORTS } = await import('../src/model-providers.js');

const NOW = '2026-11-15T00:00:00.000Z';

describe('mergeCatalogModels', () => {
  test("efforts: the gateway's while unset or still synced, the admin's otherwise", () => {
    const merged = mergeCatalogModels({
      models: [
        // Saved by an earlier release: the wizard filled every effort.
        { id: 'a', efforts: [...MODEL_EFFORTS] },
        // Chosen by the admin.
        { id: 'b', efforts: ['low', 'high'] },
        // Still what the last sync wrote.
        { id: 'c', efforts: ['low'], synced: { efforts: ['low'] } },
        // The admin changed it after a sync.
        { id: 'd', efforts: ['high'], synced: { efforts: ['low'] } },
      ],
      discovered: ['a', 'b', 'c', 'd'].map((id) => ({
        id,
        efforts: [] as never[],
      })),
      previous: { knownIds: ['a', 'b', 'c', 'd'] },
      autoAdd: false,
      now: NOW,
    });
    expect(merged.models.map((entry) => entry.efforts)).toEqual([
      [],
      ['low', 'high'],
      [],
      ['high'],
    ]);
    expect(merged.models.every((entry) => entry.synced?.efforts)).toBe(true);
  });

  test('a model gone upstream keeps the time it was first found gone', () => {
    const first = mergeCatalogModels({
      models: [{ id: 'gone' }],
      discovered: [],
      previous: { knownIds: ['gone'] },
      autoAdd: false,
      now: NOW,
    });
    expect(first.models[0].upstreamMissingSince).toBe(NOW);
    const later = mergeCatalogModels({
      models: first.models,
      discovered: [],
      previous: { knownIds: [] },
      autoAdd: false,
      now: '2026-11-16T00:00:00.000Z',
    });
    expect(later.models[0].upstreamMissingSince).toBe(NOW);
    const back = mergeCatalogModels({
      models: later.models,
      discovered: [{ id: 'gone' }],
      previous: { knownIds: [] },
      autoAdd: false,
      now: NOW,
    });
    expect(back.models[0].upstreamMissingSince).toBeUndefined();
  });

  test('auto-add stops at the list limit; the rest wait', () => {
    const models = Array.from({ length: 99 }, (_, i) => ({ id: `m${i}` }));
    const merged = mergeCatalogModels({
      models,
      discovered: [...models, { id: 'new-1' }, { id: 'new-2' }],
      previous: { knownIds: models.map((entry) => entry.id) },
      autoAdd: true,
      now: NOW,
    });
    expect(merged.added).toEqual(['new-1']);
    expect(merged.newModels.map((entry) => entry.id)).toEqual(['new-2']);
    expect(merged.models).toHaveLength(100);
  });
});
