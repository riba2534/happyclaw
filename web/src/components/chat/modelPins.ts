/**
 * Models a user pins to the top of the model picker (after Open WebUI's
 * pinned models), kept per user in this browser. A pin names a connection
 * and a model the way 最近 does; the server knows nothing of it.
 */

/** A pinned 「连接 · 模型」: the connection and the model it runs. */
export interface ModelPin {
  modelConfigId: string;
  model: string;
}

export function modelPinsKey(userId: string): string {
  return `happyclaw:model-picker:pins:${userId}`;
}

const samePin = (a: ModelPin, b: ModelPin) =>
  a.modelConfigId === b.modelConfigId && a.model === b.model;

/** In the order they were pinned; empty without a user or a readable storage. */
export function readModelPins(userId: string | undefined): ModelPin[] {
  if (!userId) return [];
  try {
    const value: unknown = JSON.parse(
      globalThis.localStorage.getItem(modelPinsKey(userId)) ?? '[]',
    );
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is ModelPin =>
        typeof item?.modelConfigId === 'string' &&
        typeof item?.model === 'string',
    );
  } catch {
    return [];
  }
}

export function isModelPinned(pins: ModelPin[], pin: ModelPin): boolean {
  return pins.some((item) => samePin(item, pin));
}

/**
 * Pins a model after the ones pinned before, or unpins it. A pin whose
 * connection is gone stays stored: hiding it is up to whoever lists them,
 * and a connection that lost its key comes back pinned once fixed.
 */
export function toggleModelPin(
  userId: string | undefined,
  pin: ModelPin,
): ModelPin[] {
  const pins = readModelPins(userId);
  const next = isModelPinned(pins, pin)
    ? pins.filter((item) => !samePin(item, pin))
    : [...pins, { modelConfigId: pin.modelConfigId, model: pin.model }];
  if (userId) {
    try {
      globalThis.localStorage.setItem(
        modelPinsKey(userId),
        JSON.stringify(next),
      );
    } catch {
      // Storage full or disabled: the pin holds until the page reloads.
    }
  }
  return next;
}

/**
 * Splits a list into its pinned rows, in pin order, and the rest in their
 * own order. `pinOf` names what a row would pin, or null for a row that may
 * not lead the list (the default, a model gone from its connection, a
 * connection that cannot run): such a row stays among the rest.
 */
export function splitPinnedRows<T>(
  rows: T[],
  pins: ModelPin[],
  pinOf: (row: T) => ModelPin | null,
): { pinned: T[]; rest: T[] } {
  const pinned: T[] = [];
  for (const pin of pins) {
    const found = rows.find((row) => {
      const own = pinOf(row);
      return !!own && samePin(own, pin);
    });
    if (found !== undefined && !pinned.includes(found)) pinned.push(found);
  }
  return { pinned, rest: rows.filter((row) => !pinned.includes(row)) };
}
