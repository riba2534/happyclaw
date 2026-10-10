import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  hashSkillDirectory,
  invalidateSkillHashCache,
  resolveEffectiveSkills,
} from '../src/effective-skill-resolver.js';

/**
 * Verbatim copy of the pre-memoization implementation. Warm runners and
 * capability snapshots compare these values, so the cached path must keep
 * producing exactly the same digest.
 */
function oracleHash(skillDir: string): string {
  const ignored = new Set([
    '.DS_Store',
    '.cache',
    '.git',
    '__pycache__',
    'node_modules',
  ]);
  const hash = createHash('sha256');
  const visit = (directory: string, relativeRoot: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs
        .readdirSync(directory, { withFileTypes: true })
        .filter((entry) => !ignored.has(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      hash.update(`unreadable-directory\0${relativeRoot}\0`);
      return;
    }
    for (const entry of entries) {
      const relativePath = relativeRoot
        ? path.posix.join(relativeRoot, entry.name)
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let target = 'unreadable';
        try {
          target = fs.readlinkSync(absolutePath);
        } catch {
          /* captured by marker */
        }
        hash.update(`symlink\0${relativePath}\0${target}\0`);
      } else if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`);
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        hash.update(`file\0${relativePath}\0`);
        try {
          hash.update(fs.readFileSync(absolutePath));
        } catch {
          hash.update('unreadable');
        }
        hash.update('\0');
      }
    }
  };
  visit(skillDir, '');
  return hash.digest('hex');
}

let root: string;
const realNow = Date.now.bind(Date);

function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function buildSkill(directory: string): void {
  write(path.join(directory, 'SKILL.md'), '---\nname: demo\n---\n# Demo\n');
  write(path.join(directory, 'scripts', 'run.js'), 'export const v = 1;\n');
  write(path.join(directory, 'scripts', 'Zeta.py'), 'print("z")\n');
  write(path.join(directory, 'scripts', 'alpha.sh'), '#!/bin/sh\necho a\n');
  write(path.join(directory, 'references', 'deep', 'nested', 'note.md'), 'n');
  write(path.join(directory, 'references', 'empty.txt'), '');
  write(
    path.join(directory, 'assets', 'blob.bin'),
    Buffer.from([0, 1, 2, 255]),
  );
  write(path.join(directory, 'assets', 'ünïcode-名.txt'), 'unicode\n');
  fs.mkdirSync(path.join(directory, 'empty-dir'));
  // Excluded payload must not influence the hash.
  write(path.join(directory, 'node_modules', 'dep', 'index.js'), 'dep');
  write(path.join(directory, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(directory, 'scripts', '__pycache__', 'x.pyc'), 'pyc');
  write(path.join(directory, '.cache', 'tmp'), 'cache');
  write(path.join(directory, '.DS_Store'), 'ds');
  fs.symlinkSync('scripts/run.js', path.join(directory, 'link-to-run'));
  fs.symlinkSync('does/not/exist', path.join(directory, 'dangling'));
}

/** Move the clock past the racy window so freshly written files are cacheable. */
function settleClock(): void {
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 60_000);
}

function countContentReads(): {
  reads: () => number;
  restore: () => void;
} {
  const readSpy = vi.spyOn(fs, 'readFileSync');
  const openSpy = vi.spyOn(fs, 'openSync');
  return {
    reads: () => readSpy.mock.calls.length + openSpy.mock.calls.length,
    restore: () => {
      readSpy.mockRestore();
      openSpy.mockRestore();
    },
  };
}

beforeEach(() => {
  invalidateSkillHashCache();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-hash-cache-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  invalidateSkillHashCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('hashSkillDirectory memoization', () => {
  test('produces the original digest for nested, excluded and symlinked entries', () => {
    const skillDir = path.join(root, 'skills', 'demo');
    buildSkill(skillDir);
    const linkedRoot = path.join(root, 'linked-skills');
    fs.mkdirSync(linkedRoot);
    fs.symlinkSync(skillDir, path.join(linkedRoot, 'demo'));

    const expected = oracleHash(skillDir);
    expect(hashSkillDirectory(skillDir)).toBe(expected);
    settleClock();
    expect(hashSkillDirectory(skillDir)).toBe(expected);
    expect(hashSkillDirectory(skillDir)).toBe(expected);
    // Host Skills are frequently symlinked directories.
    expect(hashSkillDirectory(path.join(linkedRoot, 'demo'))).toBe(expected);
    expect(oracleHash(path.join(linkedRoot, 'demo'))).toBe(expected);

    const manifest = resolveEffectiveSkills({
      layers: [{ source: 'managed', root: path.join(root, 'skills') }],
    });
    expect(manifest.selected[0].definitionHash).toBe(expected);
  });

  test('a cache hit returns the same digest without reading file contents', () => {
    const skillDir = path.join(root, 'demo');
    buildSkill(skillDir);
    settleClock();
    const first = hashSkillDirectory(skillDir);

    const counter = countContentReads();
    expect(hashSkillDirectory(skillDir)).toBe(first);
    expect(counter.reads()).toBe(0);
    counter.restore();
  });

  test('resolveEffectiveSkills only reads SKILL.md metadata on a warm cache', () => {
    const skillsRoot = path.join(root, 'skills');
    buildSkill(path.join(skillsRoot, 'one'));
    buildSkill(path.join(skillsRoot, 'two'));
    settleClock();
    const layers = [{ source: 'host' as const, root: skillsRoot }];
    const cold = resolveEffectiveSkills({ layers });

    const readSpy = vi.spyOn(fs, 'readFileSync');
    const openSpy = vi.spyOn(fs, 'openSync');
    const warm = resolveEffectiveSkills({ layers });
    expect(warm.hash).toBe(cold.hash);
    expect(openSpy).not.toHaveBeenCalled();
    const payloadReads = readSpy.mock.calls.filter(
      ([file]) =>
        typeof file !== 'string' || path.basename(file) !== 'SKILL.md',
    );
    expect(payloadReads).toEqual([]);
  });

  test('content, size, mtime, rename and symlink changes all rehash to the oracle', () => {
    const skillDir = path.join(root, 'demo');
    buildSkill(skillDir);
    settleClock();
    const script = path.join(skillDir, 'scripts', 'run.js');
    const check = () => {
      const expected = oracleHash(skillDir);
      expect(hashSkillDirectory(skillDir)).toBe(expected);
      return expected;
    };
    const seen = new Set([check()]);
    const expectNew = () => {
      const value = check();
      expect(seen.has(value)).toBe(false);
      seen.add(value);
    };

    // Different size.
    fs.writeFileSync(script, 'export const v = 10;\n');
    expectNew();

    // Same size and an identical mtime: ctime still exposes the edit.
    const pinned = new Date(realNow() - 3_600_000);
    fs.utimesSync(script, pinned, pinned);
    const before = fs.statSync(script);
    expect(check()).toBe([...seen].at(-1));
    // settleClock() fakes "now" so fresh files count as settled; real ctime
    // has coarse (kernel tick) granularity, so let it tick before the edit
    // or both writes can share one ctime — the racy case production avoids
    // by never caching trees changed within the last 3s.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    fs.writeFileSync(script, 'export const v = 20;\n');
    fs.utimesSync(script, pinned, pinned);
    expect(fs.statSync(script).size).toBe(before.size);
    expect(fs.statSync(script).mtimeMs).toBe(before.mtimeMs);
    expectNew();

    // Added and removed files, including in nested directories.
    write(path.join(skillDir, 'references', 'deep', 'added.md'), 'added');
    expectNew();
    fs.rmSync(path.join(skillDir, 'references', 'deep', 'added.md'));
    expect(check()).toBe([...seen][seen.size - 2]);

    // A same-content replacement via rename keeps the digest stable.
    const replacement = path.join(root, 'replacement.js');
    fs.writeFileSync(replacement, fs.readFileSync(script));
    fs.renameSync(replacement, script);
    expect(seen.has(check())).toBe(true);

    // Same-size replacement via rename changes the inode.
    fs.writeFileSync(replacement, 'export const v = 30;\n');
    fs.utimesSync(replacement, pinned, pinned);
    fs.renameSync(replacement, script);
    expectNew();

    // Retargeting a symlink changes only its target string.
    fs.rmSync(path.join(skillDir, 'link-to-run'));
    fs.symlinkSync('scripts/alpha.sh', path.join(skillDir, 'link-to-run'));
    expectNew();

    // Directory ↔ file type changes.
    fs.rmSync(path.join(skillDir, 'empty-dir'), { recursive: true });
    write(path.join(skillDir, 'empty-dir'), '');
    expectNew();
  });

  test('touching only mtime keeps the original digest', () => {
    const skillDir = path.join(root, 'demo');
    buildSkill(skillDir);
    settleClock();
    const expected = hashSkillDirectory(skillDir);
    const earlier = new Date(realNow() - 10_000);
    fs.utimesSync(path.join(skillDir, 'SKILL.md'), earlier, earlier);
    expect(hashSkillDirectory(skillDir)).toBe(expected);
    expect(oracleHash(skillDir)).toBe(expected);
  });

  test('changes inside excluded directories keep the cache warm', () => {
    const skillDir = path.join(root, 'demo');
    buildSkill(skillDir);
    settleClock();
    const expected = hashSkillDirectory(skillDir);
    write(path.join(skillDir, 'node_modules', 'dep', 'index.js'), 'changed!');
    write(path.join(skillDir, '.git', 'ORIG_HEAD'), 'x');

    const counter = countContentReads();
    expect(hashSkillDirectory(skillDir)).toBe(expected);
    expect(counter.reads()).toBe(0);
    counter.restore();
    expect(oracleHash(skillDir)).toBe(expected);
  });

  test('recently modified trees are rehashed until their timestamps settle', () => {
    const skillDir = path.join(root, 'demo');
    buildSkill(skillDir);
    const expected = oracleHash(skillDir);
    const readsFor = (): number => {
      const counter = countContentReads();
      expect(hashSkillDirectory(skillDir)).toBe(expected);
      const reads = counter.reads();
      counter.restore();
      return reads;
    };

    // A same-size edit inside one timestamp tick keeps the stat signature,
    // so signatures this fresh are never trusted.
    readsFor();
    expect(readsFor()).toBeGreaterThan(0);

    settleClock();
    readsFor();
    expect(readsFor()).toBe(0);
  });

  test('explicit invalidation drops one Skill, a Skills root, or everything', () => {
    const skillsRoot = path.join(root, 'skills');
    const siblingRoot = path.join(root, 'skills-other');
    const one = path.join(skillsRoot, 'one');
    const two = path.join(skillsRoot, 'two');
    const sibling = path.join(siblingRoot, 'one');
    for (const directory of [one, two, sibling]) buildSkill(directory);
    settleClock();
    for (const directory of [one, two, sibling]) hashSkillDirectory(directory);

    const readsFor = (directory: string): number => {
      const counter = countContentReads();
      hashSkillDirectory(directory);
      const reads = counter.reads();
      counter.restore();
      return reads;
    };

    invalidateSkillHashCache(one);
    expect(readsFor(one)).toBeGreaterThan(0);
    expect(readsFor(two)).toBe(0);

    // Root invalidation must not match a sibling root sharing its prefix.
    invalidateSkillHashCache(skillsRoot);
    expect(readsFor(sibling)).toBe(0);
    expect(readsFor(one)).toBeGreaterThan(0);
    expect(readsFor(two)).toBeGreaterThan(0);

    invalidateSkillHashCache();
    expect(readsFor(sibling)).toBeGreaterThan(0);
    expect(hashSkillDirectory(one)).toBe(oracleHash(one));
  });

  test('the cache is bounded and evicts the least recently used directory', () => {
    const skillsRoot = path.join(root, 'many');
    const directories = Array.from({ length: 2_001 }, (_, index) =>
      path.join(skillsRoot, `skill-${index}`),
    );
    for (const directory of directories) {
      write(path.join(directory, 'SKILL.md'), directory);
    }
    settleClock();
    hashSkillDirectory(directories[0]);
    hashSkillDirectory(directories[1]);
    for (const directory of directories.slice(2, 2_000)) {
      hashSkillDirectory(directory);
    }
    // Refresh [0] so [1] becomes the least recently used entry.
    hashSkillDirectory(directories[0]);
    hashSkillDirectory(directories[2_000]);

    const readsFor = (directory: string): number => {
      const counter = countContentReads();
      hashSkillDirectory(directory);
      const reads = counter.reads();
      counter.restore();
      return reads;
    };
    expect(readsFor(directories[0])).toBe(0);
    expect(readsFor(directories[2_000])).toBe(0);
    expect(readsFor(directories[1])).toBeGreaterThan(0);
  });
});

describe('resolveEffectiveSkills computeHashes option', () => {
  test('listing mode skips payload hashing but keeps the same selection', () => {
    const lower = path.join(root, 'project');
    const upper = path.join(root, 'managed');
    buildSkill(path.join(lower, 'shared'));
    buildSkill(path.join(upper, 'shared'));
    buildSkill(path.join(upper, 'solo'));
    const layers = [
      { source: 'project' as const, root: lower },
      { source: 'managed' as const, root: upper },
    ];
    const full = resolveEffectiveSkills({ layers });

    const openSpy = vi.spyOn(fs, 'openSync');
    const listing = resolveEffectiveSkills({ layers, computeHashes: false });
    expect(openSpy).not.toHaveBeenCalled();
    expect(listing.hash).toBe('');
    expect(listing.candidates.every((c) => c.definitionHash === '')).toBe(true);
    const shape = (manifest: typeof full) => ({
      selected: manifest.selected.map(({ id, source, path, overrides }) => ({
        id,
        source,
        path,
        overrides,
      })),
      conflicts: manifest.conflicts,
      candidates: manifest.candidates.map(
        ({ id, source, selected, excludedReason }) => ({
          id,
          source,
          selected,
          excludedReason,
        }),
      ),
    });
    expect(shape(listing)).toEqual(shape(full));
    expect(full.selected.find((s) => s.id === 'shared')?.definitionHash).toBe(
      oracleHash(path.join(upper, 'shared')),
    );
  });

  test('pre-scanned layers are not scanned again', () => {
    const managed = path.join(root, 'managed');
    buildSkill(path.join(managed, 'alpha'));
    const readSpy = vi.spyOn(fs, 'readFileSync');
    const manifest = resolveEffectiveSkills({
      layers: [
        {
          source: 'managed',
          root: managed,
          skills: [{ id: 'alpha', enabled: true }],
        },
      ],
      computeHashes: false,
    });
    expect(readSpy).not.toHaveBeenCalled();
    expect(manifest.selected).toMatchObject([
      { id: 'alpha', source: 'managed', path: path.join(managed, 'alpha') },
    ]);
  });
});
