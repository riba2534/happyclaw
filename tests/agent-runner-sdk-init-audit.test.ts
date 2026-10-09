import { expect, test } from 'vitest';

import { pluginLoadWarnings } from '../container/agent-runner/src/sdk-init-audit.js';

test('turns system/init plugin_errors into audit warnings', () => {
  // Shape reported by Claude Code 2.1.296 for a --plugin-dir that is missing.
  expect(
    pluginLoadWarnings({
      type: 'system',
      subtype: 'init',
      plugin_errors: [
        {
          plugin: 'inline[0]',
          type: 'path-not-found',
          message: 'Path not found: /nonexistent/hc-plugin (commands)',
          path: '/nonexistent/hc-plugin',
        },
        { plugin: 'docs@market', type: 'hook-load-failed', message: 'bad' },
      ],
    }),
  ).toEqual([
    'plugin inline[0] (/nonexistent/hc-plugin) failed to load: path-not-found - Path not found: /nonexistent/hc-plugin (commands)',
    'plugin docs@market failed to load: hook-load-failed - bad',
  ]);
});

test('ignores inits without plugin errors and malformed entries', () => {
  expect(pluginLoadWarnings({ type: 'system', subtype: 'init' })).toEqual([]);
  expect(
    pluginLoadWarnings({ plugin_errors: [null, 'oops', { plugin: 1 }] }),
  ).toEqual(['plugin plugin failed to load: generic-error']);
});
