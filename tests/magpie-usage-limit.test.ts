/**
 * A magpie connection's turn that ends on magpie's usage limit waits for the
 * renewal magpie's quotas name, through the ordinary usage-limit wait;
 * anything that does not say when stays a failure.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

import { magpieQuotas, magpieUsageLimitBody } from './fixtures/magpie.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-usage-limit-'));
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: tmp,
  STORE_DIR: path.join(tmp, 'db'),
  GROUPS_DIR: path.join(tmp, 'groups'),
  TIMEZONE: 'UTC',
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const runtimeConfig = await import('../src/runtime-config.js');
const { applyProviderFailureDisposition } =
  await import('../src/container-runner.js');
const { attachMagpieUsageLimitReset, magpieRefusedModel } =
  await import('../src/magpie-usage-limit.js');
const { parseMagpieQuotas } = await import('../src/model-providers.js');
const wait = await import('../src/usage-limit-wait.js');
type ContainerOutput = import('../src/container-runner.js').ContainerOutput;

const NOW = Date.now();
const quotas = async () => ({
  ok: true as const,
  accounts: parseMagpieQuotas(magpieQuotas(NOW))!,
});

let magpieId = '';
let relayId = '';
let lane = 0;

beforeAll(() => {
  db.initDatabase();
  magpieId = runtimeConfig.createProvider({
    name: 'Magpie',
    type: 'third_party',
    presetId: 'magpie',
    anthropicBaseUrl: 'http://127.0.0.1:3425',
    anthropicAuthToken: 'magpie-gateway-key',
    anthropicModel: 'codex/gpt-5.6-sol',
  }).id;
  relayId = runtimeConfig.createProvider({
    name: 'Relay',
    type: 'third_party',
    anthropicBaseUrl: 'https://relay.example.com',
    anthropicAuthToken: 'relay-key-123456',
    anthropicModel: 'codex/gpt-5.6-sol',
  }).id;
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  lane += 1;
});

/** What the Runner reports for magpie's 429 (an Assistant `rate_limit`). */
function refusal(text: string): ContainerOutput {
  return {
    status: 'success',
    result: null,
    providerFailure: true,
    providerFailureClass: 'account',
    providerRateLimitScope: 'account',
    providerErrorText: text,
    inputTurnId: `turn-${lane}`,
  } as ContainerOutput;
}

const LIMIT = `API Error: Request rejected (429) · ${
  magpieUsageLimitBody('codex/gpt-5.6-sol').error.message
}`;

describe('magpie usage limits', () => {
  test('the input waits until the earliest spent window of the model’s provider renews', async () => {
    const output = refusal(LIMIT);
    await attachMagpieUsageLimitReset(output, magpieId, 'other/model', quotas);
    // The refusal names its model; the earliest spent codex window is in 1h.
    expect(output.providerRateLimitResetsAt).toBe(NOW + 3_600_000);
    const terminal = applyProviderFailureDisposition(output, magpieId, {
      scopeKey: `web:lane-${lane}`,
      inputKey: output.inputTurnId,
    });
    expect(terminal).toBe(false);
    expect(output.providerUsageLimitResumeAt).toBeGreaterThanOrEqual(
      NOW + 3_600_000 + wait.USAGE_LIMIT_RESUME_GRACE_MS,
    );
  });

  test('nothing is guessed', async () => {
    const cases: Array<[string, string | null, string]> = [
      // A routing group has no one provider to wait for.
      [
        LIMIT.replace('codex/gpt-5.6-sol', 'group/fast'),
        magpieId,
        'group/fast',
      ],
      // Not magpie's usage-limit wording.
      ['API Error: Request rejected (429) · slow down', magpieId, 'x'],
      // Not a magpie connection.
      [LIMIT, relayId, 'codex/gpt-5.6-sol'],
      // A provider with no spent window.
      [LIMIT.replace('codex/gpt-5.6-sol', 'relaya/glm-5'), magpieId, 'x'],
    ];
    for (const [text, providerId, model] of cases) {
      const output = refusal(text);
      await attachMagpieUsageLimitReset(output, providerId, model, quotas);
      expect(output.providerRateLimitResetsAt).toBeUndefined();
      expect(
        applyProviderFailureDisposition(output, providerId, {
          scopeKey: `web:lane-${lane}-${model}`,
          inputKey: output.inputTurnId,
        }),
      ).toBe(true);
    }
    // Quotas that cannot be read leave the failure as it was.
    const unread = refusal(LIMIT);
    await attachMagpieUsageLimitReset(unread, magpieId, null, async () => ({
      ok: false as const,
      code: 'UPSTREAM_ERROR' as const,
      status: 500,
      message: 'down',
    }));
    expect(unread.providerRateLimitResetsAt).toBeUndefined();
  });

  test('a reset the upstream already named stands, and transient failures are left alone', async () => {
    const named = { ...refusal(LIMIT), providerRateLimitResetsAt: 12345 };
    const read = vi.fn(quotas);
    await attachMagpieUsageLimitReset(named, magpieId, null, read);
    expect(named.providerRateLimitResetsAt).toBe(12345);
    const transient = {
      ...refusal(LIMIT),
      providerFailureClass: 'transient' as const,
    };
    await attachMagpieUsageLimitReset(transient, magpieId, null, read);
    expect(read).not.toHaveBeenCalled();
  });

  test('the refused model is read from magpie’s words', () => {
    expect(magpieRefusedModel(LIMIT)).toBe('codex/gpt-5.6-sol');
    expect(magpieRefusedModel('usage limit reached')).toBeNull();
  });
});
