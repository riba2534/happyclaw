import { describe, expect, test } from 'vitest';

import { backgroundHandoffRefusal } from '../src/background-handoff-policy.js';

const person = {
  route: 'feishu:oc_a',
  unattended: false,
  ownerAlone: true,
  agentBuilderOwnerAlone: true,
};
const allowed = {
  teamRole: null,
  runtimeKind: 'conversation',
  heldReplySettleable: true,
  held: person,
  next: person,
};

describe('backgroundHandoffRefusal', () => {
  test('hands over between attended inputs on one route with one authority', () => {
    expect(backgroundHandoffRefusal(allowed)).toBeNull();
  });

  test('Web inputs hand over to Web, never to or from an IM route', () => {
    const web = { ...person, route: null };
    expect(
      backgroundHandoffRefusal({ ...allowed, held: web, next: web }),
    ).toBeNull();
    expect(backgroundHandoffRefusal({ ...allowed, next: web })).toBe(
      'different_route',
    );
    expect(backgroundHandoffRefusal({ ...allowed, held: web })).toBe(
      'different_route',
    );
  });

  test('another thread or account of a channel is another route', () => {
    expect(
      backgroundHandoffRefusal({
        ...allowed,
        next: { ...person, route: 'feishu:oc_a#thread:omt_2' },
      }),
    ).toBe('different_route');
  });

  test('automation and work-item inputs neither hand over nor take over', () => {
    const unattended = { ...person, unattended: true };
    expect(backgroundHandoffRefusal({ ...allowed, held: unattended })).toBe(
      'held_unattended',
    );
    expect(backgroundHandoffRefusal({ ...allowed, next: unattended })).toBe(
      'next_unattended',
    );
  });

  test('team and one-off sessions keep waiting', () => {
    expect(backgroundHandoffRefusal({ ...allowed, teamRole: 'worker' })).toBe(
      'team_session',
    );
    expect(backgroundHandoffRefusal({ ...allowed, runtimeKind: 'spawn' })).toBe(
      'not_a_conversation',
    );
  });

  test("a member's sub-agents never run under the owner's turn, nor the reverse", () => {
    const member = { ...person, ownerAlone: false };
    expect(backgroundHandoffRefusal({ ...allowed, held: member })).toBe(
      'different_authority',
    );
    expect(backgroundHandoffRefusal({ ...allowed, next: member })).toBe(
      'different_authority',
    );
    expect(
      backgroundHandoffRefusal({ ...allowed, held: member, next: member }),
    ).toBeNull();
  });

  test('the Agent Builder gate judges owners more narrowly: it must agree too', () => {
    // Owner for Skills and Memory (say, an `auto_feishu` claim), not for Agent
    // Builder: taking over from them would widen what their sub-agents may do.
    const skillOwnerOnly = { ...person, agentBuilderOwnerAlone: false };
    expect(backgroundHandoffRefusal({ ...allowed, held: skillOwnerOnly })).toBe(
      'different_authority',
    );
    expect(
      backgroundHandoffRefusal({
        ...allowed,
        held: skillOwnerOnly,
        next: skillOwnerOnly,
      }),
    ).toBeNull();
  });

  test('a held input with nothing to settle keeps the queue waiting', () => {
    expect(
      backgroundHandoffRefusal({ ...allowed, heldReplySettleable: false }),
    ).toBe('held_reply_not_delivered');
  });
});
