import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const dockerfile = fs.readFileSync(
  path.join(root, 'container', 'Dockerfile'),
  'utf8',
);
const entrypoint = fs.readFileSync(
  path.join(root, 'container', 'entrypoint.sh'),
  'utf8',
);
const runnerSource = fs.readFileSync(
  path.join(root, 'container', 'agent-runner', 'src', 'index.ts'),
  'utf8',
);
const containerRunnerSource = fs.readFileSync(
  path.join(root, 'src', 'container-runner.ts'),
  'utf8',
);

describe('Agent runner image artifact contract', () => {
  test('production defaults to an immutable precompiled runner outside hot mounts', () => {
    expect(dockerfile).toContain('FROM node:24-slim AS agent-build');
    expect(dockerfile).toContain(
      'COPY --from=agent-build /build/agent-runner/dist /opt/happyclaw-agent/dist',
    );
    expect(dockerfile).toContain(
      'COPY --from=agent-build /build/agent-runner/prompts /opt/happyclaw-agent/prompts',
    );
    expect(dockerfile).toContain('ENV HAPPYCLAW_AGENT_RUNNER_MODE=image');

    expect(entrypoint).toContain(
      'AGENT_RUNNER_ENTRY=/opt/happyclaw-agent/dist/index.js',
    );
    expect(entrypoint).toContain(
      'runuser -u node -- node "$AGENT_RUNNER_ENTRY"',
    );
    expect(entrypoint).toContain('runner_status=$?');
    expect(entrypoint).toContain('trap - EXIT');
    expect(entrypoint).toContain('exit "$runner_status"');
    expect(entrypoint).not.toContain(
      'runuser -u node -- node /tmp/dist/index.js',
    );
  });

  test('hot compilation is an explicit development-only mode', () => {
    expect(entrypoint).toContain('HAPPYCLAW_AGENT_RUNNER_MODE:-image');
    expect(entrypoint).toContain('development)');
    expect(entrypoint).toContain(
      'Development Agent runner mode requires /app/src and /app/prompts mounts',
    );
    expect(entrypoint).toContain(
      'npx tsc --outDir /tmp/dist --incremental false',
    );
    expect(entrypoint).toContain('runner_compile_start');
    expect(entrypoint).toContain('runner_compile_done');
    expect(containerRunnerSource).toContain(
      "if (resolveAgentRunnerMode() === 'development')",
    );
    expect(containerRunnerSource).toContain(
      '`HAPPYCLAW_AGENT_RUNNER_MODE=${resolveAgentRunnerMode()}`',
    );
  });

  test('records stable cold-start phases without logging task input', () => {
    for (const phase of [
      'entrypoint_start',
      'runner_artifact_ready',
      'browser_deferred',
      'input_buffered',
      'runner_exec',
    ]) {
      expect(entrypoint).toContain(`happyclaw_startup_metric ${phase}`);
    }
    expect(entrypoint).toContain("'[happyclaw:startup] phase=%s elapsed_ms=%s");
  });
});

describe('target architecture dependency pruning', () => {
  test('keeps one glibc agent-browser binary and removes duplicate Claude natives', () => {
    expect(dockerfile).toContain('AGENT_BROWSER_ARCH=x64');
    expect(dockerfile).toContain('AGENT_BROWSER_ARCH=arm64');
    expect(dockerfile).toContain(
      'AGENT_BROWSER_BINARY="agent-browser-linux-${AGENT_BROWSER_ARCH}"',
    );
    expect(dockerfile).toContain(
      '-name \'agent-browser-*\' ! -name "$AGENT_BROWSER_BINARY" -delete',
    );
    expect(dockerfile).toContain("-name 'claude-agent-sdk-*'");
    expect(dockerfile).toContain("-name 'claude-code-*'");
    expect(dockerfile).toContain('node_modules/.bin/claude --version');
    expect(dockerfile).toContain('node_modules/.bin/agent-browser --version');
    expect(dockerfile).toContain('ENV HAPPYCLAW_REQUIRE_BUNDLED_CLAUDE=1');
    expect(runnerSource).toContain(
      "process.env.HAPPYCLAW_REQUIRE_BUNDLED_CLAUDE === '1'",
    );
    expect(entrypoint).toContain(
      'HAPPYCLAW_REQUIRE_BUNDLED_CLAUDE="$HAPPYCLAW_TRUSTED_REQUIRE_BUNDLED_CLAUDE"',
    );
  });
});
