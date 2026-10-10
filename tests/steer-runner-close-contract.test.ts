import fs from 'node:fs';

import { describe, expect, test } from 'vitest';

const main = fs.readFileSync('src/index.ts', 'utf8');

describe('steer runner-close orchestration contract', () => {
  test('main and conversation-agent close paths consume steer instead of replaying', () => {
    expect(main.match(/consumeRunnerClose\(/g)).toHaveLength(2);
    expect(main).toMatch(
      /if \(runnerClosedBySteer\) \{\s+await clearProcessingIndicatorForInput[\s\S]{0,180}return true/,
    );
    expect(main).toMatch(/output\.status === 'closed' && !runnerClosedBySteer/);
    expect(
      main.match(/runnerClosedBySteer\) \{[\s\S]{0,320}markRunnerQueryIdle/g),
    ).toHaveLength(2);
  });

  test('durable channel turns cancel the superseded input on both paths', () => {
    // Run-end settlement on both paths, plus the interrupt-time settlement
    // that closes the superseded Turn without waiting for the warm runner.
    expect(main.match(/Input superseded by explicit steer/g)).toHaveLength(4);
  });
});
