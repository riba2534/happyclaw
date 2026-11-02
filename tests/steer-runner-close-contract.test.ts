import fs from 'node:fs';

import { describe, expect, test } from 'vitest';

const main = fs.readFileSync('src/index.ts', 'utf8');

describe('steer runner-close orchestration contract', () => {
  test('the session close path consumes steer instead of replaying', () => {
    expect(main.match(/consumeRunnerClose\(/g)).toHaveLength(1);
    expect(main).toMatch(/output\.status === 'closed' && !runnerClosedBySteer/);
    expect(
      main.match(/runnerClosedBySteer\) \{[\s\S]{0,320}markRunnerQueryIdle/g),
    ).toHaveLength(1);
  });

  test('durable channel turns cancel the superseded input', () => {
    // Run-end settlement, plus the interrupt-time settlement that closes the
    // superseded Turn without waiting for the warm runner.
    expect(main.match(/Input superseded by explicit steer/g)).toHaveLength(2);
  });
});
