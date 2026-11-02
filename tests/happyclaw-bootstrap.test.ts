import { describe, expect, test } from 'vitest';

import {
  isHappyClawBootstrapTurn,
  isHappyClawOwnerProfileRuntimeStructurallyEligible,
} from '../src/happyclaw-bootstrap.js';

describe('HappyClaw first-wake eligibility', () => {
  test('allows only a real interactive Home turn of the built-in profile', () => {
    expect(
      isHappyClawBootstrapTurn({
        turnId: 'owner-turn',
        isHome: true,
        isDefaultProfile: true,
      }),
    ).toBe(true);
    expect(
      isHappyClawBootstrapTurn({
        isHome: true,
        isDefaultProfile: true,
      }),
    ).toBe(false);
    expect(
      isHappyClawBootstrapTurn({
        turnId: 'custom-turn',
        isHome: true,
        isDefaultProfile: false,
      }),
    ).toBe(false);
    expect(
      isHappyClawBootstrapTurn({
        turnId: 'project-turn',
        isHome: false,
        isDefaultProfile: true,
      }),
    ).toBe(false);
  });
});

describe('HappyClaw Owner Profile structural runtime eligibility', () => {
  test('any conversation session of Home has it; other runtime kinds do not', () => {
    const session = {
      isHome: true,
      isDefaultProfile: true,
      runtimeAgentKind: 'conversation' as const,
    };
    expect(isHappyClawOwnerProfileRuntimeStructurallyEligible(session)).toBe(
      true,
    );
    for (const runtimeAgentKind of ['task', 'spawn', null] as const) {
      expect(
        isHappyClawOwnerProfileRuntimeStructurallyEligible({
          ...session,
          runtimeAgentKind,
        }),
      ).toBe(false);
    }
    expect(
      isHappyClawOwnerProfileRuntimeStructurallyEligible({
        ...session,
        isHome: false,
      }),
    ).toBe(false);
    expect(
      isHappyClawOwnerProfileRuntimeStructurallyEligible({
        ...session,
        isDefaultProfile: false,
      }),
    ).toBe(false);
  });
});
