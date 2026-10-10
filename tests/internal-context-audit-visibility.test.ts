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

describe('internal context audit visibility contract', () => {
  test('keeps context diagnostics internal to the service', () => {
    const runner = read('container/agent-runner/src/index.ts');
    const im = read('src/index.ts');
    const web = read('src/web.ts');

    // The diagnostic remains available to operators.
    expect(runner).toMatch(/eventType: 'context_audit'/);

    // IM cards log warnings instead of turning them into conversation events.
    const imContextCase = section(
      im,
      "case 'context_audit':",
      "case 'raw_sdk_event':",
    );
    expect(imContextCase).toMatch(/logger\.warn/);
    expect(imContextCase).not.toMatch(/pushRecentEvent/);

    // WebSocket clients never receive the audit, and snapshots cannot retain it.
    const broadcaster = section(
      web,
      'export function broadcastStreamEvent(',
      'export function broadcastGroupCreated(',
    );
    expect(broadcaster).toMatch(
      /if \(event\.eventType === 'context_audit'\)[\s\S]*?return;/,
    );
    expect(
      broadcaster.indexOf("event.eventType === 'context_audit'"),
    ).toBeLessThan(broadcaster.indexOf('safeBroadcast('));

    const snapshotUpdater = section(
      web,
      'function updateStreamingSnapshot(',
      'export function clearStreamingSnapshot(',
    );
    expect(snapshotUpdater).toMatch(
      /if \(event\.eventType === 'context_audit'\) return;/,
    );
    expect(snapshotUpdater).not.toMatch(/snap\.contextAudit/);
  });

  test('drops live and cached diagnostics before rendering chat UI', () => {
    const store = read('web/src/stores/chat.ts');
    const display = read('web/src/components/chat/StreamingDisplay.tsx');

    expect(store).toMatch(
      /if \(event\.eventType === 'context_audit'\) return;/,
    );
    expect(store).toMatch(/event\.kind !== 'context'/);
    expect(store).toMatch(/\.filter\(isUserVisibleTimelineEvent\)/);
    expect(store).toMatch(/\.filter\(isUserVisibleTraceEvent\)/);

    expect(display).not.toMatch(/AgentContextPanel/);
    expect(display).not.toMatch(/streaming\.contextAudit/);
    expect(display).not.toMatch(/label: 'Agent Context'/);
    // Generic request/compaction statuses are folded into the run phase.
    expect(display).toMatch(
      /status === 'requesting' \|\|[\s\S]{0,80}isCompactingStatus\(status\)/,
    );
  });
});
