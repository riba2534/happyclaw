import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    // Avoid cross-test env pollution
    unstubEnvs: true,
    unstubGlobals: true,
    pool: 'forks',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['dist/**', '**/node_modules/**'],
  },
});
