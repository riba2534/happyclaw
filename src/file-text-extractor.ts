/**
 * Extract plain text from common file types for inline prompt injection.
 *
 * Models like MiniMax-M2.7 often fail to call Read reliably or fabricate from
 * session cache. Feeding extracted text directly into the prompt bypasses the
 * unreliable tool-use round-trip.
 *
 * Supported on macOS:
 * - PDF           → `pdftotext -layout`
 * - DOC/DOCX/RTF  → `textutil -convert txt -stdout`
 * - TXT/MD/CSV/JSON → direct fs read
 * - Other         → returns null (caller keeps the original file path)
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger.js';

const execFileP = promisify(execFile);

export const EXTRACT_MAX_BYTES = 20 * 1024; // 20 KB
const EXEC_TIMEOUT_MS = 15_000;
const EXEC_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB
const TRUNCATION_NOTE = '\n\n[...内容过长已截断，完整文件见原路径]';

const TEXT_EXTS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.log',
  '.yml',
  '.yaml',
  '.xml',
  '.html',
  '.htm',
]);

const OFFICE_EXTS = new Set(['.doc', '.docx', '.rtf']);

export interface ExtractResult {
  /** Extracted plain text (possibly truncated with a marker). */
  text: string;
  /** True when extracted text exceeded the cap and was truncated. */
  truncated: boolean;
  /** Extractor that produced the text. */
  method: 'pdftotext' | 'textutil' | 'fs';
}

function truncate(text: string): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= EXTRACT_MAX_BYTES) {
    return { text, truncated: false };
  }
  // Walk the byte before the cut point backward to a valid UTF-8 char
  // boundary so we don't leave a mid-codepoint byte that decodes to U+FFFD.
  // A UTF-8 continuation byte is 0x80–0xBF; a multi-byte start is >= 0xC0.
  let end = EXTRACT_MAX_BYTES;
  while (end > 0) {
    const b = buf[end - 1]!;
    if (b < 0x80) break; // ASCII — safe boundary
    if (b >= 0xc0) {
      // Start byte of an incomplete multi-byte char at the boundary — drop it.
      end -= 1;
      break;
    }
    end -= 1; // continuation — keep walking back
  }
  const safe = buf.subarray(0, end).toString('utf8');
  return { text: safe + TRUNCATION_NOTE, truncated: true };
}

/**
 * Try to extract plain text from `filePath`. Returns null when the file type
 * is not supported or extraction fails.
 */
export async function extractFileText(
  filePath: string,
): Promise<ExtractResult | null> {
  const ext = path.extname(filePath).toLowerCase();

  try {
    if (ext === '.pdf') {
      const { stdout } = await execFileP(
        'pdftotext',
        ['-layout', filePath, '-'],
        { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER },
      );
      const { text, truncated } = truncate(stdout);
      return { text, truncated, method: 'pdftotext' };
    }

    if (OFFICE_EXTS.has(ext)) {
      // macOS built-in; fails silently on other platforms.
      const { stdout } = await execFileP(
        'textutil',
        ['-convert', 'txt', '-stdout', filePath],
        { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER },
      );
      const { text, truncated } = truncate(stdout);
      return { text, truncated, method: 'textutil' };
    }

    if (TEXT_EXTS.has(ext)) {
      const raw = await fs.readFile(filePath, 'utf8');
      const { text, truncated } = truncate(raw);
      return { text, truncated, method: 'fs' };
    }

    return null;
  } catch (err) {
    // Missing binary, timeout, maxBuffer exceeded, unreadable file, etc. Log
    // so operators can diagnose; caller falls back to just referencing the
    // file path.
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      { filePath, ext, reason },
      'extractFileText failed, falling back to path-only reference',
    );
    return null;
  }
}
