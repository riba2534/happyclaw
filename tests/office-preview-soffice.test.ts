/**
 * The LibreOffice converter, driven through a fake `soffice` shell script
 * that records its arguments and environment and can hang, fork a grandchild
 * or write an oversized result. No real LibreOffice is needed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-soffice-'));
const stateDir = path.join(tmpDir, 'state');
const binDir = path.join(tmpDir, 'bin');
const fakeSoffice = path.join(binDir, 'soffice');
const docsDir = path.join(tmpDir, 'docs');

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, DATA_DIR: tmpDir };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const {
  getOfficePreviewCacheDir,
  hashOfficePreviewSource,
  openOfficePreviewPdf,
  resolveConverter,
} = await import('../src/office-preview.js');

// The script cannot rely on its environment (that is what is under test),
// so the state directory is baked in.
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(
  fakeSoffice,
  `#!/bin/sh
state='${stateDir}'
printf '%s\\n' "$@" > "$state/args"
env > "$state/env"
if [ -e "$state/hang" ]; then
  sleep 300 &
  echo $! > "$state/grandchild.pid"
  wait
fi
outdir=''
input=''
while [ $# -gt 0 ]; do
  case "$1" in
    --outdir) outdir="$2"; shift ;;
    *) input="$1" ;;
  esac
  shift
done
name=$(basename "$input")
out="$outdir/\${name%.*}.pdf"
if [ -e "$state/big" ]; then
  head -c "$(cat "$state/big")" /dev/zero > "$out"
  exit 0
fi
printf '%%PDF-1.7\\nfake soffice output\\n' > "$out"
`,
  { mode: 0o755 },
);

async function preview(rel: string) {
  const file = path.join(docsDir, rel);
  return openOfficePreviewPdf(file, await hashOfficePreviewSource(file));
}

/** The scratch directory soffice was pointed at (its --outdir). */
function workDirOfLastRun(): string {
  const args = fs
    .readFileSync(path.join(stateDir, 'args'), 'utf-8')
    .split('\n');
  return args[args.indexOf('--outdir') + 1];
}

/** A killed process may linger briefly as a zombie until it is reaped. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch {
    return true;
  }
}

beforeEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(docsDir, { recursive: true, force: true });
  fs.rmSync(getOfficePreviewCacheDir(), { recursive: true, force: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  vi.stubEnv('OFFICE_PREVIEW_STIRLING_URL', undefined);
  vi.stubEnv('OFFICE_PREVIEW_MAX_MB', undefined);
  vi.stubEnv('OFFICE_PREVIEW_TIMEOUT_MS', undefined);
  vi.stubEnv('OFFICE_PREVIEW_SOFFICE_BIN', fakeSoffice);
});

afterEach(() => {
  vi.unstubAllEnvs();
  // Should the group kill regress, do not leave the sleeper behind.
  try {
    const pid = Number(
      fs.readFileSync(path.join(stateDir, 'grandchild.pid'), 'utf-8'),
    );
    if (pid > 0) process.kill(pid, 'SIGKILL');
  } catch {
    // No grandchild, or already gone.
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('soffice converter', () => {
  test('is not used unless OFFICE_PREVIEW_SOFFICE_BIN names it, even when soffice is on PATH', async () => {
    vi.stubEnv('OFFICE_PREVIEW_SOFFICE_BIN', undefined);
    const env = { PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
    expect(resolveConverter(env)).toBeNull();
    // A bare name would be looked up on PATH: only an absolute path counts.
    expect(
      resolveConverter({ ...env, OFFICE_PREVIEW_SOFFICE_BIN: 'soffice' }),
    ).toBeNull();
    expect(
      resolveConverter({ ...env, OFFICE_PREVIEW_SOFFICE_BIN: fakeSoffice }),
    ).toEqual({ kind: 'soffice', bin: fakeSoffice });

    vi.stubEnv('PATH', env.PATH);
    fs.writeFileSync(path.join(docsDir, 'a.docx'), 'docx');
    await expect(preview('a.docx')).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(fs.existsSync(path.join(stateDir, 'args'))).toBe(false);
  });

  test('converts in a scratch directory with a minimal environment, then removes it', async () => {
    vi.stubEnv('HAPPYCLAW_FAKE_SECRET', 'leak-me');
    fs.writeFileSync(path.join(docsDir, 'report.docx'), 'docx-bytes');

    const pdf = await preview('report.docx');
    const body = await pdf.handle.readFile();
    await pdf.handle.close();
    expect(body.toString('latin1')).toContain('fake soffice output');
    expect(pdf.cacheHit).toBe(false);

    const work = workDirOfLastRun();
    const childEnv = Object.fromEntries(
      fs
        .readFileSync(path.join(stateDir, 'env'), 'utf-8')
        .trim()
        .split('\n')
        .map((line) => [
          line.slice(0, line.indexOf('=')),
          line.slice(line.indexOf('=') + 1),
        ]),
    );
    expect(JSON.stringify(childEnv)).not.toContain('leak-me');
    expect(childEnv.HOME).toBe(work);
    expect(childEnv.TMPDIR).toBe(work);
    expect(childEnv.PATH).toBe(process.env.PATH);
    expect(childEnv.LANG).toBeTruthy();
    expect(childEnv.LC_ALL).toBeTruthy();
    // Whatever the shell adds itself, nothing else from the service leaks.
    const shellOwn = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);
    expect(
      Object.keys(childEnv)
        .filter((k) => !shellOwn.has(k))
        .sort(),
    ).toEqual(['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR']);
    expect(fs.existsSync(work)).toBe(false);
  });

  test('a timeout kills the whole process group, grandchildren included', async () => {
    vi.stubEnv('OFFICE_PREVIEW_TIMEOUT_MS', '500');
    fs.writeFileSync(path.join(stateDir, 'hang'), '');
    fs.writeFileSync(path.join(docsDir, 'slow.xlsx'), 'xlsx');

    await expect(preview('slow.xlsx')).rejects.toMatchObject({
      code: 'TIMEOUT',
    });

    const grandchild = Number(
      fs.readFileSync(path.join(stateDir, 'grandchild.pid'), 'utf-8'),
    );
    expect(grandchild).toBeGreaterThan(0);
    await vi.waitFor(() => expect(isAlive(grandchild)).toBe(false), {
      timeout: 3000,
    });
    expect(fs.existsSync(workDirOfLastRun())).toBe(false);
    expect(fs.existsSync(getOfficePreviewCacheDir())).toBe(false);
  });

  test('an oversized result is rejected by its size before it is read', async () => {
    vi.stubEnv('OFFICE_PREVIEW_MAX_MB', '1');
    // Not a PDF either: only a size check that comes first reports 413.
    fs.writeFileSync(path.join(stateDir, 'big'), String(4 * 1024 * 1024 + 1));
    fs.writeFileSync(path.join(docsDir, 'deck.pptx'), 'pptx');

    await expect(preview('deck.pptx')).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
      status: 413,
    });
    expect(fs.existsSync(getOfficePreviewCacheDir())).toBe(false);
  });
});
