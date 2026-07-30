import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const dockerfile = fs.readFileSync(
  path.join(repoRoot, 'container', 'Dockerfile'),
  'utf8',
);
const entrypoint = fs.readFileSync(
  path.join(repoRoot, 'container', 'entrypoint.sh'),
  'utf8',
);
const containerRunner = fs.readFileSync(
  path.join(repoRoot, 'src', 'container-runner.ts'),
  'utf8',
);

describe('managed Chromium CDP contract', () => {
  test('defaults Chromium and agent-browser to container-local port 9222', () => {
    expect(dockerfile).toContain('ENV HAPPYCLAW_CHROMIUM_CDP_HOST=127.0.0.1');
    expect(dockerfile).toContain('ENV HAPPYCLAW_CHROMIUM_CDP_PORT=9222');
    expect(dockerfile).toContain('ENV AGENT_BROWSER_CDP=9222');

    expect(entrypoint).toContain(
      '--remote-debugging-address="$HAPPYCLAW_CHROMIUM_CDP_HOST"',
    );
    expect(entrypoint).toContain(
      '--remote-debugging-port="$HAPPYCLAW_CHROMIUM_CDP_PORT"',
    );
    expect(entrypoint).toContain(
      'export AGENT_BROWSER_CDP="$HAPPYCLAW_CHROMIUM_CDP_PORT"',
    );
  });

  test('waits for the real HTTP endpoint and cleans up the managed browser', () => {
    expect(entrypoint).toContain('/json/version');
    expect(entrypoint).toContain('kill "$CHROMIUM_PID"');
    expect(entrypoint).toContain('wait "$CHROMIUM_PID"');
  });

  test('does not expose the privileged raw CDP port to the host', () => {
    expect(dockerfile).not.toMatch(/^EXPOSE\s+9222$/m);
    expect(containerRunner).not.toMatch(
      /(?:--publish|-p)\s*(?:["'`])?9222:9222/,
    );
  });
});
