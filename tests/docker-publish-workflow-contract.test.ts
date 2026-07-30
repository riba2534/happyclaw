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
    expect(workflow).toContain('for attempt in {1..12}');
    expect(workflow).toContain('if [ "$latest_digest" = "$MANIFEST_DIGEST" ]');
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

  test('builds only in GitHub Actions and pulls published images at runtime', () => {
    expect(read('src/config.ts')).toContain(
      "'riba2534/happyclaw-agent:latest'",
    );
    const makefile = read('Makefile');
    expect(makefile).toContain(
      'CONTAINER_IMAGE ?= riba2534/happyclaw-agent:latest',
    );
    expect(makefile).toContain('docker-pull:');
    expect(makefile).toContain('docker pull "$(CONTAINER_IMAGE)"');
    expect(makefile).not.toContain('docker-build-local:');
    expect(makefile).not.toContain('dev-local:');
    expect(makefile).not.toContain('start-local:');
    expect(makefile).not.toContain('LOCAL_CONTAINER_IMAGE');
    expect(makefile).not.toContain('CONTAINER_IMAGE_PULL');
    expect(fs.existsSync(path.join(root, 'container/build.sh'))).toBe(false);

    const monitorRoute = read('src/routes/monitor.ts');
    expect(monitorRoute).toContain("'/docker/pull'");
    expect(monitorRoute).toContain("spawn('docker', ['pull', CONTAINER_IMAGE]");
    expect(monitorRoute).not.toContain("'/docker/build'");
    expect(monitorRoute).not.toMatch(
      /spawn\(['"](?:docker|bash)['"],\s*\[['"]build/,
    );

    const localEntrypoints = [
      'Makefile',
      'package.json',
      'web/package.json',
      'container/agent-runner/package.json',
      ...['scripts', 'container'].flatMap((directory) =>
        fs
          .readdirSync(path.join(root, directory))
          .filter((file) => file.endsWith('.sh'))
          .map((file) => path.join(directory, file)),
      ),
    ];
    for (const source of localEntrypoints.map(read)) {
      expect(source).not.toMatch(
        /\b(?:docker\s+(?:buildx?\b|compose\s+build\b)|podman\s+build\b)/,
      );
    }
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
