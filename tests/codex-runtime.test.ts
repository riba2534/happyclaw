import { describe, expect, it } from 'vitest';

import { probeCodexDependencies } from '../src/codex-runtime.js';

describe('Codex runtime dependency probe', () => {
  it(
    'reports SDK availability and validates required CLI flags when a CLI exists',
    async () => {
      const status = await probeCodexDependencies();

      expect(status.sdk.packageName).toBe('@openai/codex-sdk');
      if (!status.sdk.available) {
        expect(status.sdk.error).toBeTruthy();
      }
      if (status.cli.available) {
        expect(status.cli.path).toBeTruthy();
        expect(status.cli.version).toBeTruthy();
        expect(status.cli.supportsExecRequiredFlags).toBe(true);
      } else {
        expect(status.cli.error).toBeTruthy();
      }
    },
    15_000,
  );
});
