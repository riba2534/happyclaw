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
 * Strip well-known secret patterns embedded inside tool input strings before
 * they ride out as `toolInputSummary` to every connected WebSocket client and
 * the persisted stream-event log.
 *
 * `redactSensitive` only matches sensitive *keys* — that's not enough for
 * Bash/curl/WebFetch where the actual command/url string carries a Bearer
 * token, api_key=, sk-…, ghp_…, etc. as inline content. We string-replace
 * those before truncating to 180 chars.
 */
export function redactInlineSecrets(value: string): string {
  // 长度兜底：超过 32KB 直接整段标记，跳过昂贵的多 regex 扫描。攻击者
  // 若用 prompt-injection 让 agent 跑出 60KB+ 的 toolInput（接近 schema
  // 上限），原 regex 在 lazy-prefix 下退化为 O(n^2)（10k char ≈ 16ms,
  // 60k ≈ 600ms），可被多次链式 tool-call 钉住单 agent CPU。
  if (value.length > 32 * 1024) {
    return '[REDACTED LARGE INPUT]';
  }
  return (
    value
      // OAuth bearer (case-insensitive)
      .replace(/\bbearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, 'Bearer [REDACTED]')
      // basic auth in URLs (https://user:pass@host) — extend beyond http(s)
      // to cover postgres / mongodb / redis / mysql / ftp / ssh / git etc.
      // The DSN form `<scheme>://user:pass@host/...` is universal; restrict
      // the scheme to a reasonable identifier shape to avoid colon-rich text.
      .replace(/(\b[a-z][a-z0-9+.\-]{1,15}:\/\/[^\s\/:@]+:)[^\s@\/?#]+(@)/gi,
        '$1[REDACTED]$2')
      // key=value / key:value with explicit secret-shaped key. Anchor 不再
      // 用 lazy `[A-Za-z0-9_]*?` 兜底（O(n^2) ReDoS 源头），改成显式枚举
      // 常见前缀 + 限定长度。截止字符增加 ; , 拦多 cookie 行。
      .replace(
        /(?:^|[^A-Za-z0-9])((?:gh|github|gitlab|npm|access|refresh|auth|api)[_-]token|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|x-api-key|authorization|password|secret|cookie|token|pat)\s*[:=]\s*["']?[^"'\s;,&]+/giu,
        (m, k) => {
          const prefix = m.startsWith(k) ? '' : m[0];
          return `${prefix}${k}=[REDACTED]`;
        },
      )
      // CLI 形态 `--token <value>` / `--api-key value` / `-H 'Authorization: …'`
      .replace(
        /(--?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|x-api-key))\s+(?!--)\S{4,}/gi,
        '$1 [REDACTED]',
      )
      // 主流厂商 token 前缀
      .replace(/\bsk-(?:ant-)?[A-Za-z0-9_\-]{16,}/g, '[REDACTED]')
      .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[REDACTED]')
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]')
      .replace(/\bglpat-[A-Za-z0-9_\-]{20,}/g, '[REDACTED]')
      .replace(/\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]')
      .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{12,20}\b/g, '[REDACTED]')
      .replace(/\bAIza[0-9A-Za-z_\-]{35}/g, '[REDACTED]')
      .replace(/\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g, '[REDACTED]')
      .replace(/\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}/g, '[REDACTED]')
      .replace(/\bnpm_[A-Za-z0-9]{30,}/g, '[REDACTED]')
      // private key / pem 头标识，整段一路擦到 END 标记
      .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
  );
}

/**
 * Summarize tool input for display in stream events.
 * Extracts key fields (command, query, path, etc.) or serializes the object.
 */
export function summarizeToolInput(input: unknown): string | undefined {
  if (input == null) return undefined;

  if (typeof input === 'string') {
    return shorten(redactInlineSecrets(input.trim()));
  }

  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const keyCandidates = ['command', 'query', 'path', 'pattern', 'prompt', 'url', 'name'];
    for (const key of keyCandidates) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) {
        return `${key}: ${shorten(redactInlineSecrets(value.trim()))}`;
      }
    }
    try {
      const json = JSON.stringify(redactSensitive(obj));
      // Skip empty or trivial objects (e.g. {} at content_block_start)
      if (!json || json === '{}' || json === '[]') return undefined;
      return shorten(redactInlineSecrets(json));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Summarize a tool_result block's content for streaming display.
 *
 * The SDK delivers tool results as either a plain string or an array of content
 * blocks ({type:'text'|'image'|...}). We flatten the text, redact inline secrets,
 * and clamp the length so the trace stays readable without dumping a 10K-line
 * bash output into the card. Returns undefined for empty / non-textual results.
 */
export function summarizeToolResult(content: unknown, maxLen = 400): string | undefined {
  let text: string | undefined;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object') {
          const block = b as { type?: string; text?: string };
          if (block.type === 'text') return block.text ?? '';
          if (block.type === 'image') return '[image]';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return shorten(redactInlineSecrets(trimmed), maxLen);
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
