import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('Agent effort runtime contracts', () => {
  test('conversations forward runtime policy', () => {
    expect(read('src/runner-agent-profile.ts')).toMatch(
      /function toRunnerAgentProfile[\s\S]*runtimePolicy: profile\.runtime_policy/,
    );
    for (const caller of ['src/index.ts']) {
      expect(read(caller)).toContain('agentProfile: toRunnerAgentProfile(');
    }
  });

  test('host and container starts write the launch effort of the resolved connection', () => {
    const host = read('src/container-runner.ts');
    const calls = host.match(
      /applyLaunchEffortEnv\(\s*envLines,\s*resolveAgentSdkEffort\([^)]*\),\s*(resolvedProvider|hostPoolResult)\s*\?\s*\(\1\.(?:resolved\.)?launchEffort \?\? null\)\s*:\s*undefined,\s*\)/g,
    );
    expect(calls).toHaveLength(2);
  });

  test('host and container starts mint the conversation effort into the gateway lease', () => {
    const host = read('src/container-runner.ts');
    // The pick travels out of band: the SDK option cannot express every level.
    expect(
      host.match(
        /sessionEffort: (?:hostPoolResult|poolResult)\?\.sessionEffort/g,
      ),
    ).toHaveLength(2);
    expect(read('container/agent-runner/src/index.ts')).not.toContain(
      'sessionEffort',
    );
  });

  test('host and container starts hand the launch effort to the runner', () => {
    const host = read('src/container-runner.ts');
    expect(
      host.match(
        /input = prepareLaunchInput\(input, (?:hostPoolResult|poolResult)\);/g,
      ),
    ).toHaveLength(2);
    expect(read('container/agent-runner/src/index.ts')).toContain(
      'const agentEffort = resolveRunSdkEffort(containerInput);',
    );
  });

  test('runner passes the resolved value through the supported SDK option', () => {
    const runner = read('container/agent-runner/src/index.ts');
    expect(runner).toContain('...(agentEffort ? { effort: agentEffort } : {})');
  });
});
