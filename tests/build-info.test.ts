import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  BUILD_INFO_FILE,
  createBuildInfoReader,
  parseBuildInfo,
} from '../src/build-info.js';

describe('parseBuildInfo', () => {
  test('accepts an id with a positive finite builtAt', () => {
    expect(
      parseBuildInfo({ id: '1.0.0-abc-x', builtAt: 1730000000000 }),
    ).toEqual({ id: '1.0.0-abc-x', builtAt: 1730000000000 });
  });

  test.each([
    null,
    'x',
    {},
    { id: '', builtAt: 1 },
    { id: 'a', builtAt: 0 },
    { id: 'a', builtAt: -5 },
    { id: 'a', builtAt: '1' },
    { id: 'a', builtAt: Number.NaN },
    { id: 7, builtAt: 1 },
    { id: 'x'.repeat(201), builtAt: 1 },
  ])('rejects %j', (raw) => {
    expect(parseBuildInfo(raw)).toBeNull();
  });
});

describe('createBuildInfoReader', () => {
  let dist: string;
  const file = () => path.join(dist, BUILD_INFO_FILE);
  const write = (info: unknown, mtimeSec: number) => {
    fs.writeFileSync(file(), JSON.stringify(info));
    fs.utimesSync(file(), mtimeSec, mtimeSec);
  };

  beforeEach(() => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-'));
  });
  afterEach(() => {
    fs.rmSync(dist, { recursive: true, force: true });
  });

  test('returns null while dist has no build.json', () => {
    expect(createBuildInfoReader(dist).read()).toBeNull();
  });

  test('reads the deployed id', () => {
    write({ id: 'a', builtAt: 100 }, 1000);
    expect(createBuildInfoReader(dist).read()).toEqual({
      id: 'a',
      builtAt: 100,
    });
  });

  test('picks up a rebuild without being recreated', () => {
    const reader = createBuildInfoReader(dist);
    write({ id: 'a', builtAt: 100 }, 1000);
    expect(reader.read()?.id).toBe('a');
    write({ id: 'b', builtAt: 200 }, 2000);
    expect(reader.read()).toEqual({ id: 'b', builtAt: 200 });
  });

  test('re-reads when only the size changes under the same mtime', () => {
    const reader = createBuildInfoReader(dist);
    write({ id: 'a', builtAt: 100 }, 1000);
    expect(reader.read()?.id).toBe('a');
    write({ id: 'longer-id', builtAt: 100 }, 1000);
    expect(reader.read()?.id).toBe('longer-id');
  });

  test('does not re-parse an unchanged file', () => {
    const reader = createBuildInfoReader(dist);
    write({ id: 'a', builtAt: 100 }, 1000);
    const first = reader.read();
    expect(reader.read()).toBe(first);
  });

  test('returns null while the frontend is being rebuilt, then recovers', () => {
    const reader = createBuildInfoReader(dist);
    write({ id: 'a', builtAt: 100 }, 1000);
    expect(reader.read()?.id).toBe('a');
    fs.rmSync(file());
    expect(reader.read()).toBeNull();
    write({ id: 'b', builtAt: 200 }, 2000);
    expect(reader.read()?.id).toBe('b');
  });

  test('ignores a corrupt or malformed file and reads the next good one', () => {
    const reader = createBuildInfoReader(dist);
    fs.writeFileSync(file(), '{not json');
    expect(reader.read()).toBeNull();
    write({ id: '', builtAt: 1 }, 3000);
    expect(reader.read()).toBeNull();
    write({ id: 'ok', builtAt: 5 }, 4000);
    expect(reader.read()?.id).toBe('ok');
  });
});
