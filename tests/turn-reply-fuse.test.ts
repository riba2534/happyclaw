import { describe, expect, test } from 'vitest';
import {
  ActiveTurnOutputRegistry,
  TurnOutputCoordinator,
} from '../src/turn-output-coordinator.js';

const CALLBACKS = {
  onProgress: () => true,
  onFinalCandidate: () => true,
};

describe('per-turn reply fuse', () => {
  test('is disabled when the limit is zero', () => {
    const coordinator = new TurnOutputCoordinator(0);
    for (let i = 0; i < 100; i++) {
      expect(coordinator.canDeliverUtterance()).toBe(true);
      coordinator.recordDeliveredUtterance();
    }
    expect(coordinator.deliveredUtterances).toBe(100);
  });

  test('stops accepting output once the limit is reached', () => {
    const coordinator = new TurnOutputCoordinator(3);
    for (let i = 0; i < 3; i++) {
      expect(coordinator.canDeliverUtterance()).toBe(true);
      expect(coordinator.recordDeliveredUtterance()).toBe(true);
    }
    // Already-delivered output stands; only further sends are refused.
    expect(coordinator.canDeliverUtterance()).toBe(false);
    expect(coordinator.deliveredUtterances).toBe(3);
  });

  test('a finalized turn accepts no further output regardless of the limit', () => {
    const coordinator = new TurnOutputCoordinator(10);
    coordinator.markFinalized();
    expect(coordinator.canDeliverUtterance()).toBe(false);
  });
});

describe('ActiveTurnOutputRegistry reply fuse', () => {
  test('applies the configured limit to turns it tracks', () => {
    const registry = new ActiveTurnOutputRegistry(() => 2);
    registry.bind('scope', 'turn-1', CALLBACKS);

    const input = { scopeKey: 'scope', inputTurnId: 'turn-1' };
    expect(registry.canDeliverUtterance(input)).toBe(true);
    registry.recordDeliveredUtterance(input);
    expect(registry.canDeliverUtterance(input)).toBe(true);
    registry.recordDeliveredUtterance(input);
    expect(registry.canDeliverUtterance(input)).toBe(false);
  });

  test('reads the limit per turn so a settings change applies to new turns', () => {
    let limit = 1;
    const registry = new ActiveTurnOutputRegistry(() => limit);

    registry.bind('scope', 'turn-old', CALLBACKS);
    const oldTurn = { scopeKey: 'scope', inputTurnId: 'turn-old' };
    registry.recordDeliveredUtterance(oldTurn);
    expect(registry.canDeliverUtterance(oldTurn)).toBe(false);

    limit = 5;
    registry.bind('scope', 'turn-new', CALLBACKS);
    const newTurn = { scopeKey: 'scope', inputTurnId: 'turn-new' };
    registry.recordDeliveredUtterance(newTurn);
    expect(registry.canDeliverUtterance(newTurn)).toBe(true);
    // The in-flight turn keeps the bound it started with.
    expect(registry.canDeliverUtterance(oldTurn)).toBe(false);
  });

  test('does not suppress turns it is not tracking', () => {
    // Scheduled tasks and other untracked paths have their own accounting; the
    // fuse must never be the reason one of them silently stops delivering.
    const registry = new ActiveTurnOutputRegistry(() => 1);
    expect(
      registry.canDeliverUtterance({
        scopeKey: 'scope',
        inputTurnId: 'never-bound',
      }),
    ).toBe(true);
  });

  test('an unbound turn stops counting delivered output', () => {
    const registry = new ActiveTurnOutputRegistry(() => 5);
    const coordinator = registry.bind('scope', 'turn-1', CALLBACKS);
    const input = { scopeKey: 'scope', inputTurnId: 'turn-1' };
    expect(registry.recordDeliveredUtterance(input)).toBe(true);
    registry.unbind('scope', 'turn-1', coordinator);
    expect(registry.recordDeliveredUtterance(input)).toBe(false);
  });
});
