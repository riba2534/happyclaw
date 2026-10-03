import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const indexSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/index.ts'),
  'utf8',
);

function onAgentMessageSource(): string {
  const start = indexSource.indexOf('function buildOnAgentMessage()');
  const end = indexSource.indexOf(
    "'IM message triggered agent conversation processing'",
    start,
  );
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return indexSource.slice(start, end);
}

describe('conversation agent IM intake contract', () => {
  test('IM messages never force-close a warm agent runner', () => {
    const source = onAgentMessageSource();
    // A runner held open for background Tasks must survive a new IM message;
    // closing stdin killed the sub-agents and dropped their final summary.
    expect(source).not.toContain('queue.closeStdin(');
    expect(source).not.toContain('agent-im-restart');
    expect(source).not.toMatch(/\bisImSource\b/);
  });

  test('IM and Web share the pipe-first path with exact route admission', () => {
    const source = onAgentMessageSource();
    expect(source).toContain('queue.sendMessage(');
    expect(source).toContain('activeHeldCardFinalizers.get(virtualChatJid)');
    expect(source).toContain('invokeActiveRouteAdmission(');
    expect(source).toContain("if (sendResult === 'no_active')");
    expect(source).toContain('processAgentConversation(homeChatJid, agentId)');
  });
});
