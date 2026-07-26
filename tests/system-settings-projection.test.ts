import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/**
 * The settings UI renders whatever `SystemSettings` declares, but the values
 * come from a hand-maintained projection in the config route. A setting added to
 * the runtime and to the UI type but missed in that projection type-checks
 * cleanly and still ships broken: the field is simply absent from the API
 * response, so the control renders as `undefined`.
 */
describe('system settings API projection', () => {
  test('exposes every field the settings UI declares', () => {
    const uiType = read('web/src/components/settings/types.ts');
    const block = uiType.slice(
      uiType.indexOf('export interface SystemSettings {'),
      uiType.indexOf('export interface HostIntegrationSettings'),
    );
    const uiKeys = [...block.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
    expect(uiKeys.length).toBeGreaterThan(5);

    const configRoute = read('src/routes/config.ts');
    for (const key of uiKeys) {
      expect(
        configRoute.includes(`${key}: settings.${key},`),
        `system settings projection is missing "${key}"`,
      ).toBe(true);
    }
  });
});
