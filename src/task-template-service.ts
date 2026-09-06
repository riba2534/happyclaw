/**
 * Task Template Service (R18)
 *
 * Implements parameter declarations, validation, prompt rendering,
 * and safe task draft generation from historical runs.
 */

import type { TemplateParameterDefinition, TaskRun } from './types.js';

const PARAM_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const PLACEHOLDER_REGEX = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const DATE_FORMAT_REGEX =
  /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export interface RenderTemplateResult {
  success: boolean;
  renderedPrompt: string;
  appliedParameters: Record<string, string>;
  missingParameters: string[];
  validationErrors: string[];
}

/**
 * Validate parameter definitions for uniqueness, valid identifiers, and supported types.
 */
export function validateParameterDefinitions(
  definitions: TemplateParameterDefinition[],
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const seenNames = new Set<string>();

  for (const def of definitions) {
    if (!def.name || !PARAM_NAME_REGEX.test(def.name)) {
      errors.push(
        `参数标识符 "${def.name}" 不合法，必须由字母、数字、下划线组成且不能以数字开头`,
      );
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
 * Validate a parameter value against its type definition.
 */
export function validateParameterValue(
  def: TemplateParameterDefinition,
  val: unknown,
): { valid: boolean; error?: string; normalizedValue?: string } {
  if (val === undefined || val === null || val === '') {
    if (def.required) {
      return {
        valid: false,
        error: `缺少必要参数: "${def.name}" (${def.label || def.name})`,
      };
    }
    return { valid: true, normalizedValue: def.default_value ?? '' };
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
      if (!DATE_FORMAT_REGEX.test(strVal)) {
        return {
          valid: false,
          error: `参数 "${def.name}" 必须为日期格式 (YYYY-MM-DD 或 ISO 格式)，当前值为 "${strVal}"`,
        };
      }
      return { valid: true, normalizedValue: strVal };
    }
    case 'path': {
      // Prevent path traversal attempts
      if (
        strVal.includes('..') ||
        strVal.startsWith('/') ||
        strVal.includes('\\')
      ) {
        return {
          valid: false,
          error: `参数 "${def.name}" 路径不能包含 ".." 越界符或以绝对根路径开头`,
        };
      }
      return { valid: true, normalizedValue: strVal };
    }
    case 'string':
    default:
      return { valid: true, normalizedValue: strVal };
  }
}

/**
 * Render template with given parameters and validate types & completeness.
 */
export function renderTemplate(
  promptTemplate: string,
  definitions: TemplateParameterDefinition[],
  values: Record<string, unknown>,
): RenderTemplateResult {
  const missingParameters: string[] = [];
  const validationErrors: string[] = [];
  const appliedParameters: Record<string, string> = {};

  const defMap = new Map<string, TemplateParameterDefinition>();
  for (const def of definitions) {
    defMap.set(def.name, def);
  }

  // 1. Process all defined parameters
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

  // 2. Check for template placeholders that are not in definitions or supplied values
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

  // 3. Substitute values
  let renderedPrompt = promptTemplate;
  for (const [key, val] of Object.entries(appliedParameters)) {
    const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
    renderedPrompt = renderedPrompt.replace(pattern, val);
  }

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
  // Security boundary: old channel bindings and delivery routes are stripped
  chat_jid: string;
  suggested_workspace_jid?: string;
  notify_channels: null;
  delivery_route_jid: null;
  // Template parameters if applicable
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
  // Verify if original workspace still belongs to user; if so suggest it, else leave empty for explicit choice
  const originalWorkspace = userWorkspaces.find(
    (w) => w.jid === snapshot.chat_jid,
  );
  const suggestedWorkspaceJid = originalWorkspace ? originalWorkspace.jid : '';

  return {
    source_type: 'run',
    source_id: run.id,
    prompt: snapshot.prompt || '',
    schedule_type: 'once', // New draft defaults to one-shot or easily customizable
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
  if (dateMatch) {
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
