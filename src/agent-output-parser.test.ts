import { describe, it, expect } from 'vitest';
import {
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
  createStdoutParserState,
  createStderrState,
} from './agent-output-parser.js';

describe('output markers', () => {
  it('OUTPUT_START_MARKER is defined and non-empty', () => {
    expect(typeof OUTPUT_START_MARKER).toBe('string');
    expect(OUTPUT_START_MARKER.length).toBeGreaterThan(0);
  });

  it('OUTPUT_END_MARKER is defined and non-empty', () => {
    expect(typeof OUTPUT_END_MARKER).toBe('string');
    expect(OUTPUT_END_MARKER.length).toBeGreaterThan(0);
  });

  it('start and end markers are distinct', () => {
    expect(OUTPUT_START_MARKER).not.toBe(OUTPUT_END_MARKER);
  });
});

describe('createStdoutParserState', () => {
  it('returns a state with all expected fields initialised', () => {
    const state = createStdoutParserState();
    expect(state.stdout).toBe('');
    expect(state.stdoutTruncated).toBe(false);
    expect(state.parseBuffer).toBe('');
    expect(state.newSessionId).toBeUndefined();
    expect(state.hasSuccessOutput).toBe(false);
    expect(state.hasClosedOutput).toBe(false);
    expect(state.hasInterruptedOutput).toBe(false);
  });

  it('outputChain is a resolved Promise', async () => {
    const { outputChain } = createStdoutParserState();
    // Should resolve immediately without throwing
    await expect(outputChain).resolves.toBeUndefined();
  });

  it('returns a fresh object on each call', () => {
    const a = createStdoutParserState();
    const b = createStdoutParserState();
    expect(a).not.toBe(b);
  });
});

describe('createStderrState', () => {
  it('returns a state with empty stderr', () => {
    const state = createStderrState();
    expect(state.stderr).toBe('');
    expect(state.stderrTruncated).toBe(false);
  });

  it('returns a fresh object on each call', () => {
    const a = createStderrState();
    const b = createStderrState();
    expect(a).not.toBe(b);
  });
});
