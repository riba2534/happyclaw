import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('Agent Builder runtime scope contract', () => {
  test('injects guidance and MCP tools by main-Agent identity instead of Home workspace', () => {
    const runner = read('container/agent-runner/src/index.ts');
    const tools = read('container/agent-runner/src/mcp-tools.ts');

    const promptAssembly = section(
      runner,
      'const promptPlan = buildHappyClawPromptPlan({',
      'const systemPromptAppend = promptPlan.text;',
    );
    expect(promptAssembly).toMatch(/agentBuilderEnabled/);
    expect(promptAssembly).not.toMatch(/\.\.\.\(isHome &&/);

    const toolRegistration = section(
      tools,
      '// Agent Builder follows the effective top-level AgentProfile',
      '// Skill 安装/卸载仅限主容器',
    );
    expect(toolRegistration).toMatch(/if \(ctx\.agentBuilderEnabled\)/);
    expect(toolRegistration).not.toMatch(/if \(ctx\.isHome\)/);
  });

  test('derives capability from the effective profile of every conversation session', () => {
    const host = read('src/index.ts');
    const web = read('src/web.ts');
    const runner = read('container/agent-runner/src/index.ts');

    expect(host).toMatch(
      /agentBuilderEnabled:\s*agent\.kind === 'conversation' &&\s*agentProfile\?\.is_default === true/,
    );
    // The runner never infers it from a missing session id.
    expect(runner).toMatch(/input\.agentBuilderEnabled === true/);
    expect(runner).not.toMatch(/!input\.agentId/);

    const actorGate = section(
      host,
      'const requireAgentBuilderActor =',
      "case 'agent_profile_list':",
    );
    expect(actorGate).toMatch(/getAgentBuilderRuntimeRejection/);
    expect(actorGate).toMatch(
      /agentBuilderTurnScope\(sourceGroup, ipcAgentId\)/,
    );
    expect(actorGate).not.toMatch(/!isHome/);

    expect(web).toMatch(
      /updateRoute\(agent\.group_folder, agentId, null, receipt\)/,
    );
  });
});
