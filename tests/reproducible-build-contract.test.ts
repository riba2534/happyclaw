import fs from 'node:fs';
import path from 'node:path';
import { check as prettierCheck, resolveConfig } from 'prettier';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

const lockfiles = [
  'package-lock.json',
  'web/package-lock.json',
  'container/agent-runner/package-lock.json',
];

const streamEventFiles = [
  'shared/stream-event.ts',
  'src/stream-event.types.ts',
  'web/src/stream-event.types.ts',
  'container/agent-runner/src/stream-event.types.ts',
];

describe('reproducible build contract', () => {
  test('all npm projects commit lockfiles and install them with npm ci', () => {
    const gitignore = read('.gitignore');
    for (const lockfile of lockfiles) {
      expect(fs.existsSync(path.join(root, lockfile))).toBe(true);
      expect(gitignore).not.toMatch(
        new RegExp(
          `^${lockfile.replaceAll('/', '\\/').replace('.', '\\.')}\$`,
          'm',
        ),
      );

      const lock = JSON.parse(read(lockfile)) as {
        packages: Record<string, { resolved?: string }>;
      };
      for (const dependency of Object.values(lock.packages)) {
        expect(dependency.resolved ?? '').not.toMatch(/^git\+ssh:/);
      }
    }

    const makefile = read('Makefile');
    const installTarget = makefile
      .split(/\n(?=\S)/)
      .find((target) => target.startsWith('install:'));
    expect(installTarget).toContain('$(PKG) ci');
    expect(installTarget).toContain('container/agent-runner && $(PKG) ci');
    expect(installTarget).toContain('web && $(PKG) ci');
    expect(installTarget).not.toMatch(/\$\(PKG\) install(?:\s|$)/);

    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('npm ci');
    expect(ci).toContain('npm --prefix web ci');
    expect(ci).toContain('npm --prefix container/agent-runner ci');
    expect(ci).not.toMatch(/^\s+npm(?: --prefix \S+)? install\s*$/m);
    expect(ci).toMatch(/uses: actions\/checkout@[a-f0-9]{40}/);
    expect(ci).toMatch(/uses: actions\/setup-node@[a-f0-9]{40}/);
  });

  test('generated StreamEvent copies stay synchronized and formatted', async () => {
    const canonical = read(streamEventFiles[0]);
    for (const file of streamEventFiles) {
      const source = read(file);
      expect(source).toBe(canonical);
      const filepath = path.join(root, file);
      expect(
        await prettierCheck(source, {
          ...(await resolveConfig(filepath)),
          filepath,
        }),
      ).toBe(true);
    }
  });

  test('container tools refresh to latest with rollback and audit controls', () => {
    const dockerfile = read('container/Dockerfile');
    const publishWorkflow = read('.github/workflows/docker-publish.yml');

    expect(dockerfile).toMatch(/^FROM node:24-slim$/m);
    expect(dockerfile).toContain('COPY --from=ghcr.io/astral-sh/uv:latest');
    expect(dockerfile).toContain('ARG CLAUDE_AGENT_SDK_VERSION=latest');
    expect(dockerfile).toContain('ARG CLAUDE_CODE_VERSION=latest');
    expect(dockerfile).toContain('ARG AGENT_BROWSER_VERSION=latest');
    expect(dockerfile).toContain('ARG HEADROOM_VERSION=latest');
    expect(dockerfile).toContain('ARG FEISHU_CLI_VERSION=latest');
    expect(dockerfile).toContain('ARG OH_MY_ZSH_REF=master');
    expect(dockerfile).toContain(
      'github.com/riba2534/feishu-cli/releases/latest/download',
    );
    expect(dockerfile).toContain('sha256sum -c checksum.txt');
    expect(dockerfile).toContain('happyclaw-tool-versions.txt');
    expect(dockerfile).toContain("version('headroom-ai')");
    expect(dockerfile).toContain('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1');
    expect(dockerfile).not.toContain('npm install -g');
    expect(publishWorkflow).toContain('TOOL_REFRESH=${{ github.sha }}');
    expect(fs.existsSync(path.join(root, 'container/build.sh'))).toBe(false);
  });
});
