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

    // The merge gate is local (make check, scripts/check-all.sh): it audits
    // production dependencies and checks shared copies before typecheck
    // (which syncs them) could hide drift.
    expect(makefile).toMatch(/^check:.*\n\t@\.\/scripts\/check-all\.sh$/m);
    const gate = read('scripts/check-all.sh');
    expect(gate).toContain('npm run -s audit:prod');
    expect(gate.indexOf('check-stream-event-sync.sh')).toBeLessThan(
      gate.indexOf('make --no-print-directory typecheck'),
    );
    expect(read('package.json')).toContain(
      '"audit:prod": "node scripts/audit-prod.mjs"',
    );
    const auditProd = read('scripts/audit-prod.mjs');
    expect(auditProd).toContain("cwd: path.join(root, 'web')");
    expect(auditProd).toContain(
      "cwd: path.join(root, 'container/agent-runner')",
    );
    expect(auditProd).toContain("['audit', '--omit=dev', '--json']");

    // The image workflow is the only GitHub Actions workflow left; its
    // actions stay pinned to full commit SHAs.
    const workflows = fs.readdirSync(path.join(root, '.github/workflows'));
    expect(workflows).not.toContain('ci.yml');
    for (const workflow of workflows) {
      const text = read(`.github/workflows/${workflow}`);
      for (const [, ref] of text.matchAll(/uses: [\w./-]+@(\S+)/g)) {
        expect(ref).toMatch(/^[a-f0-9]{40}$/);
      }
    }
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

  test('container Agent runtime follows the committed lockfile', () => {
    const dockerfile = read('container/Dockerfile');
    const publishWorkflow = read('.github/workflows/docker-publish.yml');

    expect(dockerfile).toMatch(/^FROM node:24-slim AS agent-build$/m);
    expect(dockerfile).toMatch(/^FROM node:24-slim AS runtime-base$/m);
    expect(dockerfile).toMatch(/^FROM runtime-base AS runtime-core$/m);
    expect(dockerfile).toMatch(/^FROM runtime-base AS runtime-headroom$/m);
    expect(dockerfile).toMatch(/^FROM runtime-core AS runtime$/m);
    expect(dockerfile).toContain('COPY --from=ghcr.io/astral-sh/uv:0.12.5');
    expect(dockerfile).toContain('npm ci');
    expect(dockerfile).not.toContain('ARG CLAUDE_AGENT_SDK_VERSION=latest');
    expect(dockerfile).not.toContain('ARG CLAUDE_CODE_VERSION=latest');
    expect(dockerfile).not.toContain('ARG AGENT_BROWSER_VERSION=latest');
    expect(dockerfile).not.toContain(
      'npm install --no-save --package-lock=false',
    );
    expect(dockerfile).toContain('ARG HEADROOM_VERSION=0.35.0');
    expect(dockerfile).toContain('ARG FEISHU_CLI_VERSION=v1.38.4');
    expect(dockerfile).toContain(
      'ARG OH_MY_ZSH_REF=97e11051e2f8053b1d694788d1cb4b0dbb1e2365',
    );
    expect(dockerfile).toContain('sha256sum -c checksum.txt');
    const toolAudit = read('container/write-tool-audit.sh');
    expect(toolAudit).toContain('happyclaw-tool-versions.txt');
    expect(toolAudit).toContain("version('headroom-ai')");
    expect(toolAudit).toContain('image-profile=%s');
    expect(dockerfile).toContain('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1');
    expect(dockerfile).not.toContain('npm install -g');
    expect(publishWorkflow).toContain('TOOL_REFRESH=${{ github.sha }}');
    expect(fs.existsSync(path.join(root, 'container/build.sh'))).toBe(false);
  });
});
