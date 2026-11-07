import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import viteConfig, { BUILD_INFO_FILE, buildInfo } from '../web/vite.config';
import {
  BUILD_META_NAME,
  parseBuildInfo,
  readLocalBuild,
} from '../web/src/utils/versionCheck';
import { BUILD_INFO_FILE as SERVER_BUILD_INFO_FILE } from '../src/build-info.js';

type ViteModule = typeof import('vite');

// The frontend's own Vite (the root one is a different major, used by vitest).
const vitePath = path.resolve('web/node_modules/vite/dist/node/index.js');

describe('frontend build identity', () => {
  test('stays out of the JS module graph', () => {
    // A per-build value compiled into the entry chunk renames nearly every
    // chunk on every deploy, so old tabs 404 on lazy routes.
    const config = viteConfig as { define?: Record<string, unknown> };
    expect(config.define ?? {}).toEqual({});
    const names = (viteConfig.plugins ?? []).map(
      (plugin) => (plugin as { name?: string } | null)?.name,
    );
    expect(names).toContain('happyclaw-build-info');
  });

  test('is written where the server reads it', () => {
    expect(BUILD_INFO_FILE).toBe(SERVER_BUILD_INFO_FILE);
  });
});

describe('build-info plugin', () => {
  let fixture: string;
  let build: ViteModule['build'];
  // For readLocalBuild; vitest's node environment has no DOMParser.
  let parser: DOMParser;

  beforeAll(async () => {
    ({ build } = (await import(pathToFileURL(vitePath).href)) as ViteModule);
    const { Window } = await import('happy-dom');
    parser = new new Window().DOMParser() as unknown as DOMParser;
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'web-build-info-'));
    const src = path.join(fixture, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(
      path.join(fixture, 'index.html'),
      '<!doctype html><html><head><title>t</title></head><body>' +
        '<script type="module" src="/src/main.js"></script></body></html>',
    );
    fs.writeFileSync(
      path.join(src, 'main.js'),
      "import './main.css';\n" +
        "document.body.onclick = () => import('./lazy.js');\n",
    );
    fs.writeFileSync(path.join(src, 'main.css'), 'body { margin: 0; }\n');
    fs.writeFileSync(
      path.join(src, 'lazy.js'),
      "document.body.onkeydown = () => import('./later.js');\n",
    );
    fs.writeFileSync(path.join(src, 'later.js'), "document.title = 'later';\n");
  });
  afterAll(() => {
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  async function buildFixture(name: string, withPlugin: boolean) {
    const outDir = path.join(fixture, name);
    await build({
      root: fixture,
      configFile: false,
      logLevel: 'silent',
      plugins: withPlugin ? [buildInfo()] : [],
      build: { outDir, emptyOutDir: true },
    });
    const assets = fs.readdirSync(path.join(outDir, 'assets')).sort();
    const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    const buildJsonPath = path.join(outDir, BUILD_INFO_FILE);
    const buildJson = fs.existsSync(buildJsonPath)
      ? parseBuildInfo(JSON.parse(fs.readFileSync(buildJsonPath, 'utf8')))
      : null;
    const doc = parser.parseFromString(html, 'text/html');
    return { assets, html, buildJson, meta: readLocalBuild(doc), outDir };
  }

  test('the same source builds the same id and the same asset names', async () => {
    const first = await buildFixture('first', true);
    const second = await buildFixture('second', true);
    const plain = await buildFixture('plain', false);

    expect(first.assets.filter((f) => f.endsWith('.js'))).toHaveLength(3);
    expect(second.assets).toEqual(first.assets);
    expect(plain.assets).toEqual(first.assets);
    for (const file of first.assets) {
      expect(fs.readFileSync(path.join(first.outDir, 'assets', file))).toEqual(
        fs.readFileSync(path.join(plain.outDir, 'assets', file)),
      );
    }

    expect(first.meta).not.toBeNull();
    expect(first.buildJson).toEqual(first.meta);
    expect(second.buildJson).toEqual(second.meta);
    expect(second.meta?.id).toBe(first.meta?.id);
    expect(second.meta!.builtAt).toBeGreaterThanOrEqual(first.meta!.builtAt);
    expect(first.html).toContain(`<meta name="${BUILD_META_NAME}"`);

    expect(plain.meta).toBeNull();
    expect(plain.buildJson).toBeNull();
  });

  test('a source change changes the id', async () => {
    const before = await buildFixture('before', true);
    const later = path.join(fixture, 'src', 'later.js');
    const original = fs.readFileSync(later, 'utf8');
    fs.writeFileSync(later, "document.title = 'changed';\n");
    try {
      const after = await buildFixture('after', true);
      expect(after.meta?.id).not.toBe(before.meta?.id);
    } finally {
      fs.writeFileSync(later, original);
    }
  });
});
