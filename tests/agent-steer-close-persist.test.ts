import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();
const indexSource = fs.readFileSync(path.join(root, 'src', 'index.ts'), 'utf8');

/**
 * Conversation-agent region from clean-steer close log through processAgent
 * return. Must not include the main-session twin (different log string).
 */
function agentRunnerClosePersistRegion(source: string): string {
  const marker =
    'Conversation agent close resolved as a clean steer transition';
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('async function startMessageLoop', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function mainRunnerClosePersistRegion(source: string): string {
  const marker = 'Container close resolved as a clean steer transition';
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  // Main finally persist is before agent function; stop before agent warm path.
  const end = source.indexOf(
    'Conversation agent close resolved as a clean steer transition',
    start,
  );
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('agent runnerClosedBySteer persist steered partial', () => {
  test('main wasInterrupted has no cursor gate (reference contract)', () => {
    const main = mainRunnerClosePersistRegion(indexSource);
    const m = main.match(/const wasInterrupted =\s*([\s\S]*?);/);
    expect(m).not.toBeNull();
    const decl = m![1];
    expect(decl).toMatch(/streamInterrupted/);
    expect(decl).toMatch(/!sentReply/);
    expect(decl).not.toMatch(/isCursorCommitted/);
  });

  test('agent early commitCursor on runnerClosedBySteer still present', () => {
    // Keep supersede seal; bug is persist gated after seal, not the seal itself.
    const agent = agentRunnerClosePersistRegion(indexSource);
    // Region starts AFTER the early-commit block's log; look in full source for
    // the agent-specific early seal immediately before the marker.
    const marker =
      'Conversation agent close resolved as a clean steer transition';
    const markerAt = indexSource.indexOf(marker);
    const prelude = indexSource.slice(Math.max(0, markerAt - 500), markerAt);
    expect(prelude).toMatch(
      /if \(runnerClosedBySteer\) \{[\s\S]*commitCursor\(activeAgentInputTurnId\)/,
    );
    expect(agent).toMatch(
      /else if \(runnerClosedBySteer\) \{[\s\S]{0,120}\.complete\(agentStreamingAccText\)/,
    );
  });

  test('agent wasInterrupted must persist despite early cursor seal on steer-close', () => {
    const agent = agentRunnerClosePersistRegion(indexSource);
    const m = agent.match(/const wasInterrupted =\s*([\s\S]*?);/);
    expect(m).not.toBeNull();
    const decl = m![1];

    expect(decl).toMatch(/agentStreamInterrupted/);
    expect(decl).toMatch(/!agentInterruptFinalized/);

    // Tip bug: wasInterrupted && !isCursorCommitted() after early commitCursor
    // on runnerClosedBySteer → storeMessageDirect(buildSteeredReply) skipped
    // while card twin complete() still runs and host returns SUCCESS.
    // Fix: mirror main (no cursor gate) OR open gate for runnerClosedBySteer.
    const hasCursorGate = /!isCursorCommitted\(\)/.test(decl);
    if (hasCursorGate) {
      expect(decl).toMatch(/runnerClosedBySteer/);
    }

    // Durable persist still keyed off wasInterrupted → interrupt_partial.
    expect(agent).toMatch(
      /if \(wasInterrupted\) \{[\s\S]*?buildSteeredReply\(agentStreamingAccText\)[\s\S]*?storeMessageDirect\([\s\S]*?sourceKind:\s*'interrupt_partial'/,
    );
  });

  test('agent crash/partial fallback stays cursor-gated (cannot save steer-close alone)', () => {
    // Document that the crash/partial fallback also requires !isCursorCommitted(),
    // so once runnerClosedBySteer seals the cursor it cannot salvage history —
    // wasInterrupted ungating is required.
    const agent = agentRunnerClosePersistRegion(indexSource);
    const marker = '兜底：进程异常退出导致累积文本未持久化';
    const at = agent.indexOf(marker);
    expect(at).toBeGreaterThanOrEqual(0);
    const window = agent.slice(at, at + 280);
    expect(window).toMatch(/!isCursorCommitted\(\)/);
  });
});