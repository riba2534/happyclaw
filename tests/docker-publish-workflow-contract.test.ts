import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Docker image distribution contract', () => {
  test('main pushes publish from pinned native multi-platform runners', () => {
    const workflow = read('.github/workflows/docker-publish.yml');

    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain(
      'uses: docker/github-builder/.github/workflows/build.yml@27ade872c1e2296e62ef15ab3b10d37665e57cf7',
    );
    expect(workflow).toContain('meta-images: riba2534/happyclaw-agent');
    expect(workflow).toContain('type=raw,value=latest');
    expect(workflow).toContain('type=sha,format=long,prefix=git-');
    expect(workflow).toContain('platforms: linux/amd64,linux/arm64');
    expect(workflow).toContain('distribute: true');
    expect(workflow).toContain('setup-qemu: false');
    expect(workflow).toContain('linux/amd64=ubuntu-24.04');
    expect(workflow).toContain('linux/arm64=ubuntu-24.04-arm');
    expect(workflow).toContain('TOOL_REFRESH=${{ github.sha }}');
    expect(workflow).toContain('username: ${{ secrets.DOCKERHUB_USERNAME }}');
    expect(workflow).toContain('password: ${{ secrets.DOCKERHUB_TOKEN }}');
    expect(workflow).not.toContain(`${['dckr', 'pat'].join('_')}_`);
    expect(workflow).not.toContain('docker/setup-qemu-action');
    expect(workflow).toMatch(
      /uses: docker\/github-builder\/\.github\/workflows\/build\.yml@[a-f0-9]{40}(?:\s|$)/,
    );
  });

  test('runtime defaults to the remotely published image', () => {
    expect(read('src/config.ts')).toContain(
      "'riba2534/happyclaw-agent:latest'",
    );
    const makefile = read('Makefile');
    expect(makefile).toContain(
      'CONTAINER_IMAGE ?= riba2534/happyclaw-agent:latest',
    );
    expect(makefile).toContain('docker pull "$(CONTAINER_IMAGE)"');
    expect(makefile).toContain('docker-build-local:');
  });
});
