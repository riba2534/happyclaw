import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();
const indexSource = fs.readFileSync(path.join(root, 'src', 'index.ts'), 'utf8');
const commandsSource = fs.readFileSync(
  path.join(root, 'src', 'commands.ts'),
  'utf8',
);

function freshWindowIpcCase(source: string): string {
  const start = source.indexOf("case 'fresh_window':");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n    default:', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('IPC fresh_window result contract', () => {
  test('does not acknowledge success before reset, and reports failure on reset error', () => {
    const block = freshWindowIpcCase(indexSource);

    // Old bug: write success, then best-effort reset that only logs on failure.
    expect(block).not.toContain('fresh_window accepted but reset failed');

    const successWrite = block.indexOf('success: true');
    const resetCall = block.indexOf('executeFreshWindowReset(');
    const beforeStop = block.indexOf('beforeStop:');
    const resetFailedLog = block.indexOf('fresh_window reset failed');
    const acceptedGuard = block.indexOf('if (!accepted)');
    const failFreshAfterGuard = block.indexOf('failFresh(', acceptedGuard);

    expect(resetCall).toBeGreaterThanOrEqual(0);
    expect(beforeStop).toBeGreaterThan(resetCall);
    expect(successWrite).toBeGreaterThan(beforeStop);
    expect(resetFailedLog).toBeGreaterThan(resetCall);
    expect(acceptedGuard).toBeGreaterThan(resetFailedLog);
    expect(failFreshAfterGuard).toBeGreaterThan(acceptedGuard);
  });

  test('commands support beforeStop so success can land before force-stopGroup', () => {
    expect(commandsSource).toContain('beforeStop?: () => void | Promise<void>');
    expect(commandsSource).toContain('await opts.beforeStop()');
    expect(commandsSource).toContain('await stopActive()');
  });
});
