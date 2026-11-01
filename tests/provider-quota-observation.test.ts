import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  isTerminalSdkRateLimitRejection,
  normalizeSdkRateLimitObservation,
} from '../container/agent-runner/src/provider-quota-observation.js';
import {
  captureProviderQuotaObservationEpoch,
  clearAllProviderQuotaObservations,
  clearProviderQuotaObservation,
  consumeProviderQuotaControlOutput,
  getProviderQuotaObservation,
  MAX_PROVIDER_QUOTA_OBSERVATIONS,
  observeProviderQuota,
} from '../src/provider-quota-observation.js';

afterEach(() => clearAllProviderQuotaObservations());

describe('SDK provider quota observation', () => {
  test('preserves the SDK/header units and bounded overage signals', () => {
    const observedAt = Date.parse('2026-09-02T08:00:00.000Z');
    const observation = normalizeSdkRateLimitObservation(
      {
        status: 'allowed_warning',
        rateLimitType: 'seven_day',
        utilization: 0.53,
        resetsAt: 1_788_000_000,
        overageStatus: 'allowed',
        overageResetsAt: 1_788_100_000,
        overageDisabledReason: 'member_zero_credit_limit',
        isUsingOverage: false,
        overageInUse: false,
        surpassedThreshold: 0.5,
      },
      observedAt,
    );

    expect(observation).toMatchObject({
      source: 'sdk_rate_limit_event',
      observedAt,
      status: 'allowed_warning',
      rateLimitType: 'seven_day',
      utilization: 0.53,
      resetsAt: 1_788_000_000,
      overageStatus: 'allowed',
      overageResetsAt: 1_788_100_000,
      surpassedThreshold: 0.5,
    });
    // Epoch seconds must not be silently converted into milliseconds.
    expect(observation.resetsAt).toBe(1_788_000_000);
  });

  test('omits malformed fractions instead of clamping them into valid data', () => {
    expect(
      normalizeSdkRateLimitObservation({
        status: 'allowed_warning',
        utilization: 1.7,
        surpassedThreshold: -0.2,
      }),
    ).not.toHaveProperty('utilization');
  });

  test('does not fail an allowed warning or an active overage transition', () => {
    expect(isTerminalSdkRateLimitRejection({ status: 'allowed_warning' })).toBe(
      false,
    );
    expect(
      isTerminalSdkRateLimitRejection({
        status: 'rejected',
        rateLimitType: 'seven_day',
        overageStatus: 'allowed',
        isUsingOverage: true,
      }),
    ).toBe(false);
    expect(
      isTerminalSdkRateLimitRejection({
        status: 'rejected',
        rateLimitType: 'overage',
        overageInUse: true,
      }),
    ).toBe(false);
    expect(
      isTerminalSdkRateLimitRejection({
        status: 'rejected',
        rateLimitType: 'seven_day',
        overageStatus: 'allowed_warning',
      }),
    ).toBe(true);
    expect(
      isTerminalSdkRateLimitRejection({
        status: 'rejected',
        rateLimitType: 'five_hour',
        isUsingOverage: false,
      }),
    ).toBe(true);
  });

  test('replaces the whole snapshot and never resurrects older fields', () => {
    observeProviderQuota('provider-a', {
      source: 'sdk_rate_limit_event',
      observedAt: 100,
      status: 'allowed_warning',
      rateLimitType: 'seven_day',
      utilization: 0.8,
      overageStatus: 'rejected',
      overageDisabledReason: 'out_of_credits',
    });
    observeProviderQuota('provider-a', {
      source: 'sdk_rate_limit_event',
      observedAt: 200,
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 0.1,
    });

    expect(getProviderQuotaObservation('provider-a')).toEqual({
      source: 'sdk_rate_limit_event',
      observedAt: 200,
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 0.1,
    });
    expect(getProviderQuotaObservation('provider-a')).not.toHaveProperty(
      'overageStatus',
    );
  });

  test('ignores an older concurrent observation and bounds provider cardinality', () => {
    observeProviderQuota('newest', {
      source: 'sdk_rate_limit_event',
      observedAt: 300,
      status: 'rejected',
    });
    observeProviderQuota('newest', {
      source: 'sdk_rate_limit_event',
      observedAt: 200,
      status: 'allowed',
    });
    expect(getProviderQuotaObservation('newest')?.status).toBe('rejected');

    clearAllProviderQuotaObservations();
    for (let index = 0; index <= MAX_PROVIDER_QUOTA_OBSERVATIONS; index += 1) {
      observeProviderQuota(`provider-${index}`, {
        source: 'sdk_rate_limit_event',
        observedAt: index + 1,
        status: 'allowed',
      });
    }
    expect(getProviderQuotaObservation('provider-0')).toBeNull();
    expect(
      getProviderQuotaObservation(
        `provider-${MAX_PROVIDER_QUOTA_OBSERVATIONS}`,
      ),
    ).not.toBeNull();
  });

  test('consumes a control frame without requiring a selected provider', () => {
    const output = {
      providerQuotaObservation: {
        source: 'sdk_rate_limit_event' as const,
        observedAt: 100,
        status: 'allowed' as const,
      },
    };
    expect(consumeProviderQuotaControlOutput(null, output)).toBe(true);
    expect(getProviderQuotaObservation('')).toBeNull();
    expect(consumeProviderQuotaControlOutput('provider-a', output)).toBe(true);
    expect(getProviderQuotaObservation('provider-a')?.status).toBe('allowed');
    expect(consumeProviderQuotaControlOutput('provider-a', {})).toBe(false);
  });

  test('rejects a late frame from the credential generation that was cleared', () => {
    const providerId = 'provider-rotated';
    const oldEpoch = captureProviderQuotaObservationEpoch(providerId);
    const output = {
      providerQuotaObservation: {
        source: 'sdk_rate_limit_event' as const,
        observedAt: 100,
        status: 'rejected' as const,
      },
    };

    clearProviderQuotaObservation(providerId);
    expect(
      consumeProviderQuotaControlOutput(providerId, output, oldEpoch),
    ).toBe(true);
    expect(getProviderQuotaObservation(providerId)).toBeNull();

    const newEpoch = captureProviderQuotaObservationEpoch(providerId);
    expect(newEpoch).not.toBe(oldEpoch);
    consumeProviderQuotaControlOutput(providerId, output, newEpoch);
    expect(getProviderQuotaObservation(providerId)?.status).toBe('rejected');
  });

  test('wires both Host and Container frames through activity before projection', () => {
    const runner = fs.readFileSync(
      path.resolve(process.cwd(), 'src/container-runner.ts'),
      'utf8',
    );
    const main = fs.readFileSync(
      path.resolve(process.cwd(), 'src/index.ts'),
      'utf8',
    );

    expect(
      runner.match(
        /consumeProviderQuotaControlOutput\([\s\S]*?output,[\s\S]*?QuotaEpoch,[\s\S]*?\)/g,
      ),
    ).toHaveLength(2);
    expect(
      runner.match(/if \(onOutput\) await onOutput\(output\);/g),
    ).toHaveLength(2);
    expect(main).toMatch(
      /queue\.markRunnerActivity\(virtualJid\);\s*if \(isProviderQuotaControlOutput\(output\)\) return;/,
    );

    const agentRunner = fs.readFileSync(
      path.resolve(process.cwd(), 'container/agent-runner/src/index.ts'),
      'utf8',
    );
    expect(agentRunner).toMatch(
      /if \(message\.type === 'rate_limit_event'\) \{\s*const info:[^;]+;\s*publishProviderQuotaObservation\(info\);\s*if \(isTerminalSdkRateLimitRejection\(info\)\)/,
    );
  });
});
