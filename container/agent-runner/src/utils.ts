/**
 * Utility functions for HappyClaw Agent Runner.
 *
 * Pure utility functions with no side effects or state dependencies.
 */

/**
 * Shorten a string to maxLen, appending "..." if truncated.
 */
export function shorten(input: string, maxLen = 180): string {
  if (input.length <= maxLen) return input;
  return `${input.slice(0, maxLen)}...`;
}

/**
 * Recursively redact sensitive fields (tokens, passwords, API keys, etc.)
 * from an object. Limits recursion depth to 3 levels.
 */
export function redactSensitive(input: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]';
  if (input == null) return input;
  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    return input;
  }
  if (Array.isArray(input)) {
    return input.slice(0, 10).map((item) => redactSensitive(item, depth + 1));
  }
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/(token|password|secret|api[_-]?key|authorization|cookie)/iu.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSensitive(v, depth + 1);
      }
    }
    return out;
  }
  return '[unsupported]';
}

/**
 * Summarize tool input for display in stream events.
 * Extracts key fields (command, query, path, etc.) or serializes the object.
 */
export function summarizeToolInput(input: unknown): string | undefined {
  if (input == null) return undefined;

  if (typeof input === 'string') {
    return shorten(input.trim());
  }

  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const keyCandidates = ['command', 'query', 'path', 'pattern', 'prompt', 'url', 'name'];
    for (const key of keyCandidates) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) {
        return `${key}: ${shorten(value.trim())}`;
      }
    }
    try {
      const json = JSON.stringify(redactSensitive(obj));
      // Skip empty or trivial objects (e.g. {} at content_block_start)
      if (!json || json === '{}' || json === '[]') return undefined;
      return shorten(json);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Extract a skill name from Skill tool input.
 * Tries skillName, skill, name, command fields, then regex-matches leading slashes.
 */
export function extractSkillName(toolName: unknown, input: unknown): string | undefined {
  if (toolName !== 'Skill') return undefined;
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const raw =
    (typeof obj.skillName === 'string' && obj.skillName) ||
    (typeof obj.skill === 'string' && obj.skill) ||
    (typeof obj.name === 'string' && obj.name) ||
    (typeof obj.command === 'string' && obj.command) ||
    '';
  if (!raw) return undefined;
  const matched = raw.match(/\/([A-Za-z0-9._-]+)/);
  if (matched && matched[1]) return matched[1];
  return raw.replace(/^\/+/, '').trim() || undefined;
}

/**
 * Sanitize a string for use as a filename.
 * Lowercases, replaces non-alphanumeric characters with hyphens, trims, and limits length.
 */
export function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/**
 * Generate a fallback conversation archive filename based on current time.
 */
export function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}
