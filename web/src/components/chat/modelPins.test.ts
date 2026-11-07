import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  isModelPinned,
  modelPinsKey,
  readModelPins,
  splitPinnedRows,
  toggleModelPin,
  type ModelPin,
} from './modelPins';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  get length() {
    return storage.size;
  },
  key: (index: number) => [...storage.keys()][index] ?? null,
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
} satisfies Storage);

beforeEach(() => storage.clear());

const opus = { modelConfigId: 'official', model: 'opus' };
const glm = { modelConfigId: 'glm', model: 'glm-5.3' };

describe('model pins', () => {
  test('a toggle pins after the earlier pins, a second one unpins', () => {
    expect(toggleModelPin('user-1', glm)).toEqual([glm]);
    expect(toggleModelPin('user-1', opus)).toEqual([glm, opus]);
    expect(readModelPins('user-1')).toEqual([glm, opus]);
    expect(isModelPinned(readModelPins('user-1'), opus)).toBe(true);
    expect(toggleModelPin('user-1', glm)).toEqual([opus]);
    expect(readModelPins('user-1')).toEqual([opus]);
  });

  test('each user has their own, and broken storage reads as empty', () => {
    toggleModelPin('user-1', opus);
    expect(readModelPins('user-2')).toEqual([]);
    expect(readModelPins(undefined)).toEqual([]);
    // Without a user nothing is stored.
    expect(toggleModelPin(undefined, opus)).toEqual([opus]);
    expect(storage.size).toBe(1);
    storage.set(modelPinsKey('user-1'), '{not json');
    expect(readModelPins('user-1')).toEqual([]);
    storage.set(
      modelPinsKey('user-1'),
      JSON.stringify([opus, { modelConfigId: 1 }, null, 'x']),
    );
    expect(readModelPins('user-1')).toEqual([opus]);
  });
});

describe('splitPinnedRows', () => {
  interface Row {
    pin: ModelPin;
    usable: boolean;
  }
  const row = (modelConfigId: string, model: string, usable = true): Row => ({
    pin: { modelConfigId, model },
    usable,
  });
  const pinOf = (item: Row) => (item.usable ? item.pin : null);
  const names = (items: Row[]) => items.map((item) => item.pin.model);

  test('pinned rows lead in pin order; the rest keep theirs', () => {
    const rows = [
      row('official', 'opus'),
      row('official', 'sonnet'),
      row('glm', 'glm-5.3'),
      row('glm', 'glm-4.6'),
    ];
    const { pinned, rest } = splitPinnedRows(
      rows,
      [glm, { modelConfigId: 'official', model: 'sonnet' }],
      pinOf,
    );
    expect(names(pinned)).toEqual(['glm-5.3', 'sonnet']);
    expect(names(rest)).toEqual(['opus', 'glm-4.6']);
  });

  test('a pin of a model gone or that cannot run leads nothing', () => {
    const rows = [row('official', 'opus', false), row('glm', 'glm-5.3')];
    const { pinned, rest } = splitPinnedRows(
      rows,
      [
        { modelConfigId: 'gone', model: 'old' },
        { modelConfigId: 'glm', model: 'removed' },
        opus,
        glm,
        glm,
      ],
      pinOf,
    );
    expect(names(pinned)).toEqual(['glm-5.3']);
    // The one that cannot run stays where it was.
    expect(names(rest)).toEqual(['opus']);
  });
});
