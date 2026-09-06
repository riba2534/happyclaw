/**
 * Task Template Service (R18)
 *
 * Implements parameter declarations, validation, prompt rendering,
 * and safe task draft generation from historical runs.
 *
 * Security & robustness guarantees:
 * - Strict calendar date validation (rejects invalid dates like 2026-99-99, 2026-02-31).
 * - Default values are strictly validated against their declared types.
 * - Single-pass token replacement using replacer function:
 *   prevents special replacement patterns ($&, $1, etc.) from being interpreted,
 *   and completely prevents secondary expansion attacks.
 * - Enforces parameter name security and identifier limits.
 */

import type { TemplateParameterDefinition, TaskRun } from './types.js';

const PARAM_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const PLACEHOLDER_REGEX = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface RenderTemplateResult {
  success: boolean;
  renderedPrompt: string;
  appliedParameters: Record<string, string>;
  missingParameters: string[];
  validationErrors: string[];
}

/**
 * Perform calendar semantic validation on a date string.
 * Rejects nonexistent calendar dates like 2026-99-99 or 2026-02-31.
 */
export function isValidCalendarDate(str: string): boolean {
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);

    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    if (year < 1970 || year > 2100) return false;

    // Check actual days in month via UTC Date rollover
    const d = new Date(Date.UTC(year, month - 1, day));
    return (
      d.getUTCFullYear() === year &&
      d.getUTCMonth() === month - 1 &&
      d.getUTCDate() === day
    );
  }

  // Handle ISO 8601 full datetime strings
  const isoMatch = str.match(
    /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/,
  );
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    const d = new Date(Date.UTC(year, month - 1, day));
    if (
      d.getUTCFullYear() !== year ||
      d.getUTCMonth() !== month - 1 ||
      d.getUTCDate() !== day
    ) {
      return false;
    }
    const ts = Date.parse(str);
    return Number.isFinite(ts);
  }

  return false;
}

/**
 * Validate a parameter value against its type definition.
 */
export function validateParameterValue(
  def: TemplateParameterDefinition,
  val: unknown,
): { valid: boolean; error?: string; normalizedValue?: string } {
  // Empty or missing value handling
  if (val === undefined || val === null || val === '') {
    if (def.required) {
      // If required, but has a valid default_value, fallback to default_value
      if (
        def.default_value !== undefined &&
        def.default_value !== null &&
        def.default_value !== ''
      ) {
        return validateParameterValue(
          { ...def, required: false },
          def.default_value,
        );
      }
      return {
        valid: false,
        error: `缺少必要参数: "${def.name}" (${def.label || def.name})`,
      };
    }
    // Optional parameter without value
    if (
      def.default_value !== undefined &&
      def.default_value !== null &&
      def.default_value !== ''
    ) {
      return validateParameterValue(
        { ...def, required: false },
        def.default_value,
      );
    }
    return { valid: true, normalizedValue: '' };
  }

  const strVal = String(val).trim();

  switch (def.type) {
    case 'number': {
      const num = Number(strVal);
      if (!Number.isFinite(num)) {
        return {
          valid: false,
          error: `参数 "${def.name}" 必须为有效数字，当前值为 "${strVal}"`,
        };
      }
      return { valid: true, normalizedValue: strVal };
    }
    case 'date': {
      if (!isValidCalendarDate(strVal)) {
        return {
          valid: false,
          error: `参数 "${def.name}" 必须为合法日历日期 (如 YYYY-MM-DD)，当前值为 "${strVal}"`,
        };
      }
      return { valid: true, normalizedValue: strVal };
    }
    case 'path': {
      // Strict path safety check: reject path traversal and dangerous paths
      if (
        strVal.includes('..') ||
        strVal.startsWith('/') ||
        strVal.startsWith('\\') ||
        strVal.includes('\0')
      ) {
        return {
          valid: false,
          error: `参数 "${def.name}" 路径不能包含 ".." 越界符、空字节或以绝对根路径开头`,
        };
      }
      return { valid: true, normalizedValue: strVal };
    }
    case 'string':
    default:
      if (strVal.includes('\0')) {
        return {
          valid: false,
          error: `参数 "${def.name}" 不能包含空字符`,
        };
      }
      return { valid: true, normalizedValue: strVal };
  }
}

/**
 * Validate parameter definitions for uniqueness, valid identifiers, supported types,
 * and ensure any default_value is type-compliant.
 */
export function validateParameterDefinitions(
  definitions: TemplateParameterDefinition[],
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const seenNames = new Set<string>();

  if (!Array.isArray(definitions)) {
    return { valid: false, errors: ['参数定义必须为数组'] };
  }

  if (definitions.length > 50) {
    return { valid: false, errors: ['参数定义数量不能超过 50 个'] };
  }

  for (const def of definitions) {
    if (!def.name || !PARAM_NAME_REGEX.test(def.name)) {
      errors.push(
        `参数标识符 "${def.name}" 不合法，必须由字母、数字、下划线组成且不能以数字开头`,
      );
    }
    if (FORBIDDEN_KEYS.has(def.name)) {
      errors.push(`参数标识符 "${def.name}" 是受保护的保留字，禁止使用`);
    }
    if (def.name && def.name.length > 50) {
      errors.push(`参数标识符 "${def.name}" 长度不能超过 50 字符`);
    }
    if (seenNames.has(def.name)) {
      errors.push(`参数标识符 "${def.name}" 重复定义`);
    }
    seenNames.add(def.name);

    if (!['string', 'number', 'date', 'path'].includes(def.type)) {
      errors.push(
        `参数 "${def.name}" 类型 "${def.type}" 不受支持，支持类型为 string, number, date, path`,
      );
    }

    // Strict check for declared default_value
    if (
      def.default_value !== undefined &&
      def.default_value !== null &&
      def.default_value !== ''
    ) {
      const defaultValCheck = validateParameterValue(
        { ...def, required: false },
        def.default_value,
      );
      if (!defaultValCheck.valid) {
        errors.push(`参数 "${def.name}" 默认值非法: ${defaultValCheck.error}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Extract all {{parameter}} placeholders from a template string.
 */
export function extractTemplateParameters(promptTemplate: string): string[] {
  const params: string[] = [];
  const matches = promptTemplate.matchAll(PLACEHOLDER_REGEX);
  for (const m of matches) {
    if (m[1] && !params.includes(m[1])) {
      params.push(m[1]);
    }
  }
  return params;
}

/**
 * Render template with given parameters and validate types & completeness.
 *
 * Implements SINGLE-PASS function replacement:
 * - Eliminates $& / $1 / $' replacement meta-character vulnerabilities.
 * - Eliminates secondary / recursive expansion of user values containing {{...}}.
 */
export function renderTemplate(
  promptTemplate: string,
  definitions: TemplateParameterDefinition[],
  values: Record<string, unknown>,
): RenderTemplateResult {
  const missingParameters: string[] = [];
  const validationErrors: string[] = [];
  const appliedParameters: Record<string, string> = Object.create(null);

  const defMap = new Map<string, TemplateParameterDefinition>();
  for (const def of definitions) {
    defMap.set(def.name, def);
  }

  // 1. Process all declared parameter definitions
  for (const def of definitions) {
    const rawVal = values[def.name];
    const validation = validateParameterValue(def, rawVal);
    if (!validation.valid) {
      if (validation.error?.startsWith('缺少必要参数')) {
        missingParameters.push(def.name);
      }
      validationErrors.push(validation.error || `参数 "${def.name}" 校验失败`);
    } else {
      appliedParameters[def.name] = validation.normalizedValue ?? '';
    }
  }

  // 2. Check for template placeholders not covered by definitions
  const placeholders = extractTemplateParameters(promptTemplate);
  for (const p of placeholders) {
    if (!defMap.has(p)) {
      const supplied = values[p];
      if (supplied !== undefined && supplied !== null && supplied !== '') {
        appliedParameters[p] = String(supplied);
      } else {
        if (!missingParameters.includes(p)) {
          missingParameters.push(p);
          validationErrors.push(
            `模板引用的参数 "{{${p}}}" 未在参数定义中声明且未传入值`,
          );
        }
      }
    }
  }

  // 3. Single-pass token replacement using replacer function.
  // When a function is passed to String.prototype.replace, its return value
  // is inserted as a pure literal string without interpreting any $ patterns.
  // Also, because it's a single pass over the original template, values containing
  // {{...}} are never re-evaluated!
  const renderedPrompt = promptTemplate.replace(
    PLACEHOLDER_REGEX,
    (_match, paramName: string) => {
      if (Object.prototype.hasOwnProperty.call(appliedParameters, paramName)) {
        return appliedParameters[paramName];
      }
      return _match;
    },
  );

  const success =
    missingParameters.length === 0 && validationErrors.length === 0;

  return {
    success,
    renderedPrompt,
    appliedParameters,
    missingParameters,
    validationErrors,
  };
}

/**
 * Task draft object generated from a run or template.
 * Crucial security requirement (R18): Does NOT inherit channel targets,
 * notify channels, or another user's delivery routes.
 */
export interface TaskDraft {
  source_type: 'run' | 'template';
  source_id: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  execution_type: 'agent' | 'script';
  execution_mode: 'host' | 'container' | null;
  script_command: string | null;
  chat_jid: string;
  suggested_workspace_jid?: string;
  notify_channels: null;
  delivery_route_jid: null;
  template_parameters?: Record<string, string>;
  parameter_definitions?: TemplateParameterDefinition[];
}

/**
 * Create a fresh, safe task draft from a historical run's definition snapshot.
 * Strips all external channel bindings, routes, and notifications.
 */
export function buildDraftFromRun(
  run: TaskRun,
  userWorkspaces: Array<{ jid: string; name: string }>,
): TaskDraft {
  const snapshot = run.definition_snapshot;
  const originalWorkspace = userWorkspaces.find(
    (w) => w.jid === snapshot.chat_jid,
  );
  const suggestedWorkspaceJid = originalWorkspace ? originalWorkspace.jid : '';

  return {
    source_type: 'run',
    source_id: run.id,
    prompt: snapshot.prompt || '',
    schedule_type: 'once',
    schedule_value: new Date(Date.now() + 300_000).toISOString(),
    context_mode: snapshot.context_mode || 'isolated',
    execution_type: snapshot.execution_type || 'agent',
    execution_mode: snapshot.execution_mode || null,
    script_command: snapshot.script_command || null,
    chat_jid: suggestedWorkspaceJid,
    suggested_workspace_jid: suggestedWorkspaceJid,
    notify_channels: null,
    delivery_route_jid: null,
  };
}

/**
 * Suggest candidate parameter definitions by analyzing a prompt.
 * Finds dates like 2026-09-07, path patterns, or common placeholders.
 */
export function extractCandidateParametersFromPrompt(prompt: string): {
  templatePrompt: string;
  candidateDefs: TemplateParameterDefinition[];
} {
  let templatePrompt = prompt;
  const candidateDefs: TemplateParameterDefinition[] = [];

  // 1. Detect date patterns: YYYY-MM-DD
  const dateMatch = prompt.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (dateMatch && isValidCalendarDate(dateMatch[0])) {
    const origDate = dateMatch[0];
    templatePrompt = templatePrompt.replace(
      new RegExp(origDate, 'g'),
      '{{date}}',
    );
    candidateDefs.push({
      name: 'date',
      label: '日期',
      type: 'date',
      required: true,
      default_value: origDate,
      description: '执行或分析的目标日期 (YYYY-MM-DD)',
    });
  }

  // 2. Detect existing {{param}} placeholders
  const existingPlaceholders = extractTemplateParameters(prompt);
  for (const name of existingPlaceholders) {
    if (!candidateDefs.some((d) => d.name === name)) {
      candidateDefs.push({
        name,
        label: name,
        type: name.includes('date')
          ? 'date'
          : name.includes('dir') || name.includes('path')
            ? 'path'
            : 'string',
        required: true,
        description: `参数 ${name}`,
      });
    }
  }

  return { templatePrompt, candidateDefs };
}
