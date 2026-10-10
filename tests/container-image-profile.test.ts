import { describe, expect, test } from 'vitest';

import { deriveContainerProfileImage } from '../src/config.js';
import {
  buildContainerArgs,
  runtimeMcpServersRequireHeadroom,
} from '../src/container-runner.js';

describe('container image profiles', () => {
  test('derives the matching immutable Headroom tag', () => {
    expect(
      deriveContainerProfileImage(
        'riba2534/happyclaw-agent:git-012345',
        'headroom',
      ),
    ).toBe('riba2534/happyclaw-agent:git-012345-headroom');
    expect(
      deriveContainerProfileImage(
        'riba2534/happyclaw-agent@sha256:abc',
        'headroom',
      ),
    ).toBeNull();
  });

  test('selects Headroom only for an explicit Headroom MCP executable', () => {
    expect(
      runtimeMcpServersRequireHeadroom({
        compressor: { command: '/usr/local/bin/headroom', args: ['mcp'] },
      }),
    ).toBe(true);
    expect(
      runtimeMcpServersRequireHeadroom({
        browser: { command: 'agent-browser' },
        custom: { command: 'uvx', args: ['some-package'] },
      }),
    ).toBe(false);
  });

  test('runs the agent container without privilege gain and with a pids cap', () => {
    const args = buildContainerArgs(
      [],
      'happyclaw-test',
      'UTC',
      { mode: 'host-root' },
      { addHostGateway: false },
      'happyclaw-agent:test',
    );
    const imageIndex = args.indexOf('happyclaw-agent:test');
    const optionIndex = args.indexOf('--security-opt');
    expect(args[optionIndex + 1]).toBe('no-new-privileges');
    expect(args[args.indexOf('--pids-limit') + 1]).toBe('4096');
    // docker options must precede the image, or they become its arguments.
    expect(optionIndex).toBeLessThan(imageIndex);
    expect(args.indexOf('--pids-limit')).toBeLessThan(imageIndex);
    expect(args).not.toContain('--memory');
  });

  test('places the selected profile image at the end of docker arguments', () => {
    const args = buildContainerArgs(
      [],
      'happyclaw-test',
      'Asia/Shanghai',
      { mode: 'host-root' },
      { addHostGateway: false },
      'happyclaw-agent:test-headroom',
    );
    expect(args.at(-1)).toBe('happyclaw-agent:test-headroom');
  });
});
