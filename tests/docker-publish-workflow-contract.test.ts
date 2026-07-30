import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Docker image distribution contract', () => {
  test('builds and smokes on pinned native runners before promoting latest', () => {
    const workflow = read('.github/workflows/docker-publish.yml');

    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('platform: linux/amd64');
    expect(workflow).toContain('platform: linux/arm64');
    expect(workflow).toContain('runner: ubuntu-24.04');
    expect(workflow).toContain('runner: ubuntu-24.04-arm');
    expect(workflow).toContain('uses: docker/build-push-action@');
    expect(workflow).toContain('context: ./container');
    expect(workflow).toContain('file: ./container/Dockerfile');
    expect(workflow).toContain('pull: true');
    expect(workflow).toContain(
      'push-by-digest=true,name-canonical=true,push=true',
    );
    expect(workflow).toContain('TOOL_REFRESH=${{ github.sha }}');
    expect(workflow).toContain(
      './scripts/smoke-agent-image.sh "$IMAGE_REF" "${{ matrix.arch }}"',
    );
    expect(workflow).toContain(
      '[[ "$IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]',
    );
    expect(workflow).toContain('needs: build-and-smoke');
    expect(workflow).toContain(
      'docker buildx imagetools create --tag "$commit_tag"',
    );
    expect(workflow).toContain(
      '(($platforms | sort) == ["linux/amd64", "linux/arm64"])',
    );
    expect(workflow).toContain('cosign sign --yes');
    expect(workflow).toContain('cosign verify');
    expect(workflow).toContain('--tag "${IMAGE_NAME}:latest"');
    expect(workflow).toContain('username: ${{ secrets.DOCKERHUB_USERNAME }}');
    expect(workflow).toContain('password: ${{ secrets.DOCKERHUB_TOKEN }}');
    expect(workflow).not.toContain(`${['dckr', 'pat'].join('_')}_`);
    expect(workflow).not.toContain('docker/setup-qemu-action');

    const actionUses = [
      ...workflow.matchAll(/^\s*uses:\s+(\S+)(?:\s+#.*)?$/gm),
    ].map(([, value]) => value);
    expect(actionUses.length).toBeGreaterThan(0);
    for (const action of actionUses) {
      expect(action).toMatch(/^[^@\s]+@[a-f0-9]{40}$/);
    }

    const smokeIndex = workflow.indexOf(
      './scripts/smoke-agent-image.sh "$IMAGE_REF" "${{ matrix.arch }}"',
    );
    const latestIndex = workflow.indexOf('--tag "${IMAGE_NAME}:latest"');
    expect(smokeIndex).toBeGreaterThan(-1);
    expect(latestIndex).toBeGreaterThan(smokeIndex);
  });

  test('keeps remote and local image lifecycles separate', () => {
    expect(read('src/config.ts')).toContain(
      "'riba2534/happyclaw-agent:latest'",
    );
    const makefile = read('Makefile');
    expect(makefile).toContain(
      'CONTAINER_IMAGE ?= riba2534/happyclaw-agent:latest',
    );
    expect(makefile).toContain(
      'LOCAL_CONTAINER_IMAGE ?= happyclaw-agent:local',
    );
    expect(makefile).toContain('CONTAINER_IMAGE_PULL ?= always');
    expect(makefile).toContain('docker pull "$(CONTAINER_IMAGE)"');
    expect(makefile).toContain('docker-build-local:');
    expect(makefile).toContain(
      './container/build.sh "$(LOCAL_CONTAINER_IMAGE)"',
    );
    expect(makefile).toContain('dev-local:');
    expect(makefile).toContain('start-local:');
    expect(makefile).toContain('CONTAINER_IMAGE_PULL=never');

    const buildScript = read('container/build.sh');
    expect(buildScript).toContain(
      '${LOCAL_CONTAINER_IMAGE:-happyclaw-agent:local}',
    );
    expect(buildScript).toContain('docker build --pull');
  });

  test('smoke helper exercises the production entrypoint and real HTTP endpoint', () => {
    const smoke = read('scripts/smoke-agent-image.sh');

    expect(smoke).toContain('docker run --detach --interactive');
    expect(smoke).not.toContain('--entrypoint');
    expect(smoke).toContain(
      "docker image inspect --format '{{.Architecture}}'",
    );
    expect(smoke).toContain(
      '[ "$actual_architecture" != "$EXPECTED_ARCHITECTURE" ]',
    );
    expect(smoke).toContain('curl --noproxy');
    expect(smoke).toContain('http://127.0.0.1:9222/json/version');
    expect(smoke).toContain('docker rm -f "$SMOKE_CONTAINER_NAME"');
  });
});
