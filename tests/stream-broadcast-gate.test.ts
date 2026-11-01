import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

// A proactive workspace promises the Web never receives the model's answer
// text, and what else it receives depends on its process visibility. That only
// holds if no code path hands a Runner event to the WebSocket without going
// through projectSdkStreamEventForWeb. The system-triggered terminal warmup
// run once did exactly that, found only by running a proactive container
// workspace against the real provider: its raw text, reasoning and usage
// events reached the Web.
const source = fs.readFileSync(
  path.join(process.cwd(), 'src', 'index.ts'),
  'utf8',
);

/** The body of a top-level `function name(` up to the next top-level one. */
function functionBody(name: string): string {
  const start = source.search(new RegExp(`\\n(async )?function ${name}\\(`));
  expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf('\nasync function ', start + 1);
  const nextSync = source.indexOf('\nfunction ', start + 1);
  const ends = [next, nextSync].filter((index) => index > start);
  return source.slice(start, ends.length ? Math.min(...ends) : undefined);
}

describe('Runner events reach the Web only through the projection', () => {
  test('no broadcast hands a raw Runner stream event to the Web', () => {
    expect(source).not.toMatch(
      /broadcastStreamEvent\(\s*[A-Za-z_.]+,\s*(?:result|output)\.streamEvent\b/,
    );
  });

  test('the narration relay sits beside each projection that feeds a live turn', () => {
    // A session holds text back until a tool call follows it; a projection
    // without a relay would lose the narration, a relay without a projection
    // would send what the projection withholds.
    expect(source.match(/new ProactiveCommentaryRelay\(\)/g)).toHaveLength(1);
    expect(source.match(/commentaryRelay\.take\(/g)).toHaveLength(1);
    // Its output is broadcast to the Web only, never handed to a channel.
    for (const call of source.match(
      /for \(const note of commentaryRelay\.take\([\s\S]*?\n\s*\}\n/g,
    ) ?? []) {
      expect(call).toContain('broadcastStreamEvent(chatJid, note');
      expect(call).not.toMatch(/stream(ing)?Session|sendMessage|feishu/i);
    }
  });

  test('a proactive turn announces the trace it stores', () => {
    // The reply was announced mid-turn, before its trace existed. Each place
    // that stores a proactive turn's trace says so to the clients, through a
    // helper that cannot keep the turn from settling.
    const bodies = source.split('const persistProactiveTurnTrace = (').slice(1);
    expect(bodies).toHaveLength(1);
    for (const body of bodies) {
      expect(body.slice(0, 900)).toContain('announceTurnTrace(');
    }
    const helper = functionBody('announceTurnTrace');
    expect(helper).toContain('broadcastMessageTrace(');
    expect(helper).toMatch(/try \{[\s\S]*broadcastMessageTrace[\s\S]*\} catch/);
  });

  test('the terminal warmup run is no turn: nothing of it reaches the Web', () => {
    const warmup = functionBody('runTerminalWarmup');
    expect(warmup).not.toContain('broadcastStreamEvent(');
    expect(warmup).not.toContain('sendMessageWithOutcome(');
    // It takes no session input; the next turn closes it.
    expect(functionBody('ensureTerminalContainerStarted')).toContain(
      'acceptsInput: false',
    );
  });
});
