import { beforeEach, expect, test, vi } from 'vitest';

// The hourly expiry pass keeps running while billing is off (so turning it
// back on finds lapsed subscriptions already expired); only single-user host
// mode, which has no subscriptions, skips it.
const mocks = vi.hoisted(() => ({
  expire: vi.fn(() => 0),
  singleUserHost: false,
  billingEnabled: false,
}));
vi.mock('../src/db.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  expireSubscriptions: mocks.expire,
}));
vi.mock('../src/deployment-mode.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  isSingleUserHost: () => mocks.singleUserHost,
}));
vi.mock('../src/runtime-config.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/runtime-config.js')>();
  return {
    ...real,
    getSystemSettings: () => ({
      ...real.getSystemSettings(),
      billingEnabled: mocks.billingEnabled,
    }),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { runScheduledSubscriptionExpiry } = await import('../src/billing.js');

beforeEach(() => {
  mocks.expire.mockClear();
  mocks.singleUserHost = false;
});

test('runs in multi-user mode with billing off, as before single-user host mode', () => {
  mocks.billingEnabled = false;
  runScheduledSubscriptionExpiry();
  expect(mocks.expire).toHaveBeenCalledTimes(1);
});

test('runs in multi-user mode with billing on', () => {
  mocks.billingEnabled = true;
  runScheduledSubscriptionExpiry();
  expect(mocks.expire).toHaveBeenCalledTimes(1);
});

test('is skipped in single-user host mode', () => {
  mocks.singleUserHost = true;
  mocks.billingEnabled = true;
  runScheduledSubscriptionExpiry();
  expect(mocks.expire).not.toHaveBeenCalled();
});
