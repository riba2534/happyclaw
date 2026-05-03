import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EXTRACT_MAX_BYTES,
  extractFileText,
} from '../src/file-text-extractor.js';

const tmp = (suffix: string) =>
  path.join(os.tmpdir(), `happyclaw-extractor-${Date.now()}-${Math.random()}${suffix}`);

describe('extractFileText', () => {
  test('returns null for unknown extension', async () => {
    const p = tmp('.bin');
    fs.writeFileSync(p, Buffer.from([0, 1, 2, 3]));
    try {
      const out = await extractFileText(p);
      expect(out).toBeNull();
    } finally {
      fs.rmSync(p, { force: true });
    }
  });

  test('reads .md file directly via fs', async () => {
    const p = tmp('.md');
    fs.writeFileSync(p, '# Hello\nworld');
    try {
      const out = await extractFileText(p);
      expect(out).not.toBeNull();
      expect(out?.method).toBe('fs');
      expect(out?.truncated).toBe(false);
      expect(out?.text).toContain('Hello');
    } finally {
      fs.rmSync(p, { force: true });
    }
  });

  test('truncates overly long text files with marker', async () => {
    const p = tmp('.txt');
    // 50KB of 'a' — will exceed 20KB cap
    fs.writeFileSync(p, 'a'.repeat(50 * 1024));
    try {
      const out = await extractFileText(p);
      expect(out?.truncated).toBe(true);
      expect(out?.text).toContain('[...内容过长已截断');
      // Text size should be close to but not exceeding cap + note
      expect(Buffer.from(out!.text, 'utf8').length).toBeLessThanOrEqual(
        EXTRACT_MAX_BYTES + 200,
      );
    } finally {
      fs.rmSync(p, { force: true });
    }
  });

  test('handles missing file gracefully (returns null)', async () => {
    const out = await extractFileText(tmp('.md'));
    expect(out).toBeNull();
  });

  test('supports common text extensions', async () => {
    const exts = ['.txt', '.json', '.csv', '.log', '.yaml'];
    for (const ext of exts) {
      const p = tmp(ext);
      fs.writeFileSync(p, `sample content for ${ext}`);
      try {
        const out = await extractFileText(p);
        expect(out).not.toBeNull();
        expect(out?.method).toBe('fs');
      } finally {
        fs.rmSync(p, { force: true });
      }
    }
  });

  test('returns null for .pdf when pdftotext absent or file invalid', async () => {
    // Write a junk .pdf file — pdftotext will refuse it. Extractor swallows
    // and returns null.
    const p = tmp('.pdf');
    fs.writeFileSync(p, 'NOT A PDF');
    try {
      const out = await extractFileText(p);
      expect(out).toBeNull();
    } finally {
      fs.rmSync(p, { force: true });
    }
  });

  test('truncation preserves UTF-8 boundary for CJK content', async () => {
    // Pad with ASCII so the boundary falls inside a CJK (3-byte) char.
    // "你" is 3 bytes in UTF-8. With a 20 KB cap, straddling the boundary
    // means naive byte-slicing could split mid-codepoint.
    const p = tmp('.txt');
    const padding = 'a'.repeat(EXTRACT_MAX_BYTES - 1); // one byte short of cap
    const body = padding + '你好世界';
    fs.writeFileSync(p, body);
    try {
      const out = await extractFileText(p);
      expect(out?.truncated).toBe(true);
      // Must not contain U+FFFD (replacement char) — means the slice cut
      // cleanly on a char boundary.
      expect(out?.text.includes('�')).toBe(false);
    } finally {
      fs.rmSync(p, { force: true });
    }
  });

  test('office file returns placeholder text when no extractor available', async () => {
    // On CI or Linux without textutil, .doc falls through to pandoc then
    // placeholder. On macOS textutil will succeed — this test checks the
    // structure either way: the result must not be null.
    const p = tmp('.doc');
    fs.writeFileSync(p, Buffer.from([0xd0, 0xcf, 0x11, 0xe0])); // OLE2 header
    try {
      const out = await extractFileText(p);
      // Should never be null for office formats — always returns either
      // extracted text or a placeholder telling the user to convert.
      expect(out).not.toBeNull();
      if (out!.method === 'textutil' && !out!.text.startsWith('[无法提取')) {
        // macOS textutil succeeded — that's fine
        expect(out!.truncated).toBe(false);
      } else {
        // textutil and pandoc both failed — must return helpful placeholder
        expect(out!.text).toContain('无法提取');
        expect(out!.text).toContain('PDF');
      }
    } finally {
      fs.rmSync(p, { force: true });
    }
  });
});
