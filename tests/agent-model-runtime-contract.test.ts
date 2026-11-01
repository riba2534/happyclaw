import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

/**
 * An Agent's model travels with its model configuration: into every runner
 * launch, and into every prediction of a session reset, so the history the
 * new session needs is injected beforehand.
 */
describe('Agent model runtime contracts', () => {
  test('conversations hand the Agent model to the runner', () => {
    expect(read('src/runner-agent-profile.ts')).toMatch(
      /function toRunnerAgentProfile[\s\S]*?modelConfigId: profile\.model_config_id,\s*model: profile\.model,/,
    );
    for (const caller of ['src/index.ts']) {
      expect(read(caller)).toContain('toRunnerAgentProfile(');
    }
  });

  test('host and container starts select the provider with the Agent model', () => {
    const runner = read('src/container-runner.ts');
    expect(
      runner.match(
        /trySelectPoolProvider\(\s*group\.folder,\s*input\.agentId,\s*input\.agentProfile\?\.modelConfigId,\s*input\.agentProfile\?\.model,\s*resolveAgentSdkEffort\(input\.agentProfile\?\.runtimePolicy\),\s*\)/g,
      ),
    ).toHaveLength(2);
  });

  test('every session reset prediction knows the Agent model', () => {
    const main = read('src/index.ts');
    const calls = main.match(/willClearSessionOnProviderSwitch\(/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(
      main.match(
        /willClearSessionOnProviderSwitch\(\s*effectiveGroup\.folder,\s*(?:undefined|agentId),\s*agentProfile\?\.model_config_id,\s*agentProfile\?\.model,\s*\)/g,
      ),
    ).toHaveLength(calls.length);
  });
});
