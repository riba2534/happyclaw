import { describe, expect, test } from 'vitest';

import { OutputFrameScanner } from '../src/output-frame-scanner.js';

const S = '---HAPPYCLAW_OUTPUT_START---';
const E = '---HAPPYCLAW_OUTPUT_END---';

function parseObject(json: string): unknown | null {
  try {
    const value = JSON.parse(json.trim());
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}

/** Frames the scanner yields that parse as JSON objects, in order. */
function scan(chunks: string[]): unknown[] {
  const scanner = new OutputFrameScanner(S, E);
  const out: unknown[] = [];
  for (const chunk of chunks) {
    for (const event of scanner.push(chunk)) {
      if (event.kind !== 'frame') continue;
      const parsed = parseObject(event.json);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

/** The previous whole-buffer parser, kept as the behavioral oracle. */
function referenceScan(chunks: string[]): unknown[] {
  const isWs = (ch: string) =>
    ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
  const objectEnd = (buf: string, start: number): number => {
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let i = start; i < buf.length; i++) {
      const ch = buf[i];
      if (inStr) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  };
  let buffer = '';
  const out: unknown[] = [];
  for (const chunk of chunks) {
    buffer += chunk;
    let startIdx: number;
    while ((startIdx = buffer.indexOf(S)) !== -1) {
      const contentStart = startIdx + S.length;
      let objStart = contentStart;
      while (objStart < buffer.length && isWs(buffer[objStart])) objStart++;
      if (objStart >= buffer.length) break;
      if (buffer[objStart] !== '{') {
        const nextStart = buffer.indexOf(S, contentStart);
        const endIdx = buffer.indexOf(E, contentStart);
        let resyncTo = -1;
        if (endIdx !== -1 && (nextStart === -1 || endIdx < nextStart)) {
          resyncTo = endIdx + E.length;
        } else if (nextStart !== -1) resyncTo = nextStart;
        if (resyncTo === -1) break;
        buffer = buffer.slice(resyncTo);
        continue;
      }
      const objEnd = objectEnd(buffer, objStart);
      if (objEnd === -1) break;
      const endIdx = buffer.indexOf(E, objEnd);
      if (endIdx === -1) break;
      const parsed = parseObject(buffer.slice(objStart, objEnd));
      buffer = buffer.slice(endIdx + E.length);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

function randomChunks(text: string, random: () => number): string[] {
  const chunks: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const size = 1 + Math.floor(random() * 40);
    chunks.push(text.slice(pos, pos + size));
    pos += size;
  }
  return chunks;
}

describe('OutputFrameScanner', () => {
  test('matches the previous parser on randomized streams and chunkings', () => {
    let seed = 11;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const pieces = [
      () =>
        `${S}${JSON.stringify({ status: 'stream', result: `r${seed}` })}${E}`,
      () =>
        `${S}${JSON.stringify({ status: 'success', result: `quote ${S} and ${E} {}` })}${E}`,
      () => `${S}  \n${JSON.stringify({ n: [1, { x: '"}' }] })}\n${E}`,
      () => `${S}42${E}`,
      () => `${S}"just a string"${E}`,
      () => `${S}{not valid json}${E}`,
      () => `${S}{"a":1}garbage before end${E}`,
      () => 'noise between frames ---HAPPY',
      () => '\n',
    ];
    for (let round = 0; round < 400; round += 1) {
      const count = 1 + Math.floor(random() * 8);
      let stream = '';
      for (let i = 0; i < count; i += 1) {
        stream += pieces[Math.floor(random() * pieces.length)]();
      }
      const chunks = randomChunks(stream, random);
      expect(scan(chunks)).toEqual(referenceScan(chunks));
      expect(scan([stream])).toEqual(referenceScan([stream]));
    }
  });

  test('a broken frame resyncs to a following START before its own END', () => {
    const frames = scan([`${S}oops ${S}${JSON.stringify({ ok: 1 })}${E}`]);
    expect(frames).toEqual([{ ok: 1 }]);
  });

  test('stays linear for one large frame delivered in small chunks', () => {
    const payload = JSON.stringify({
      status: 'success',
      result: 'x'.repeat(8 * 1024 * 1024),
    });
    const stream = `${S}${payload}${E}`;
    const scanner = new OutputFrameScanner(S, E);
    const started = performance.now();
    let frames = 0;
    for (let pos = 0; pos < stream.length; pos += 4096) {
      for (const event of scanner.push(stream.slice(pos, pos + 4096))) {
        if (event.kind === 'frame') frames += 1;
      }
    }
    const elapsed = performance.now() - started;
    expect(frames).toBe(1);
    // The previous parser rescanned the partial object on every chunk:
    // ~2,000 chunks x up to 8MB each. Linear scanning takes well under 1s.
    expect(elapsed).toBeLessThan(2_000);
    expect(scanner.pendingChars).toBe(0);
  });

  test('stays linear for many frames in one large chunk', () => {
    const frame = `${S}${JSON.stringify({ status: 'stream', result: 'delta' })}${E}`;
    const stream = frame.repeat(50_000);
    const scanner = new OutputFrameScanner(S, E);
    const started = performance.now();
    const events = scanner.push(stream);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(events.filter((event) => event.kind === 'frame')).toHaveLength(
      50_000,
    );
  });

  test('drops a runaway object beyond the size cap and recovers', () => {
    const scanner = new OutputFrameScanner(S, E, 1_000);
    const events = [
      ...scanner.push(`${S}{"a":"${'y'.repeat(2_000)}`),
      ...scanner.push(`"}${E}${S}${JSON.stringify({ b: 2 })}${E}`),
    ];
    expect(events[0]).toMatchObject({ kind: 'overflow' });
    const frames = events
      .filter((event) => event.kind === 'frame')
      .map((event) => parseObject((event as { json: string }).json));
    expect(frames).toEqual([{ b: 2 }]);
  });
});
