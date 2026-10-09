import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

// Ratchet for the Web UI conventions (see CLAUDE.md §3.2). Counts may only go
// down: new code should use semantic tokens, confirmDialog(), the shared
// primitives and the z-50 overlay layer instead of these escape hatches.

const SRC = path.join(process.cwd(), 'web/src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [full]
      : [];
  });
}

const files = sourceFiles(SRC).map((file) => ({
  rel: path.relative(SRC, file).split(path.sep).join('/'),
  source: fs.readFileSync(file, 'utf8'),
}));

function countBy(
  pattern: RegExp,
  include: (rel: string) => boolean = () => true,
) {
  const counts: Record<string, number> = {};
  for (const { rel, source } of files) {
    if (!include(rel)) continue;
    const n = source.match(pattern)?.length ?? 0;
    if (n > 0) counts[rel] = n;
  }
  return counts;
}

function expectWithinAllowance(
  counts: Record<string, number>,
  allowance: Record<string, number>,
) {
  const over = Object.entries(counts)
    .filter(([rel, n]) => n > (allowance[rel] ?? 0))
    .map(([rel, n]) => `${rel}: ${n} (allowed ${allowance[rel] ?? 0})`);
  expect(over).toEqual([]);
}

describe('web design-system guard', () => {
  test('uses semantic color tokens instead of Tailwind palette colors', () => {
    const palette =
      /\b(?:[a-z-]+:)*(?:bg|text|border|ring|from|to|via|fill|stroke|divide|outline)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
    expectWithinAllowance(countBy(palette), {
      // File-type icon colors and the terminal theme are intentionally fixed
      // and do not follow the app palette.
      'components/chat/FilePanel.tsx': 9,
      'components/chat/TerminalPanel.tsx': 9,
    });
  });

  test('asks for confirmation through confirmDialog()', () => {
    expectWithinAllowance(countBy(/(?<![\w.])(?:window\.)?confirm\(/g), {
      // Unsaved-change navigation guards must stay synchronous.
      'pages/AgentProfilesPage.tsx': 3,
      'pages/MemoryPage.tsx': 3,
      // Mentioned in the doc comment of confirmDialog itself.
      'stores/confirm.ts': 1,
    });
  });

  test('keeps overlays on the shared layer without z-index hacks', () => {
    expectWithinAllowance(countBy(/z-\[\d{3,}\]/g), {});
    expectWithinAllowance(
      countBy(/fixed inset-0/g, (rel) => !rel.startsWith('components/ui/')),
      {
        // Full-screen media viewers that stack above dialogs.
        'components/chat/ImageLightbox.tsx': 1,
        'components/chat/PreviewDialog.tsx': 1,
      },
    );
  });

  test('uses the select primitives outside of pinned native selects', () => {
    expectWithinAllowance(
      countBy(/<select\b/g, (rel) => !rel.startsWith('components/ui/')),
      {},
    );
  });
});
