/**
 * magpie gateway answers as its source (internal/gateway/gateway.go
 * modelObject and listModels, claude_discovery.go) shapes them: the model
 * list a HappyClaw request is shown, the one Claude Code's own discovery is
 * shown (ids without claude/anthropic renamed to anthropic/magpie-<n>, the
 * label as display_name), the quotas answer and a usage-limit refusal.
 */

interface MagpieModel {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  context?: number;
  maxOutput?: number;
  levels: string[];
  reasoning?: boolean;
}

export const MAGPIE_MODELS: readonly MagpieModel[] = [
  {
    id: 'codex/gpt-5.6-sol',
    name: 'GPT-5.6-Sol',
    provider: 'codex',
    providerName: 'Codex',
    context: 400_000,
    maxOutput: 128_000,
    levels: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'relaya/glm-5',
    name: 'GLM-5',
    provider: 'relaya',
    providerName: 'Relay A',
    context: 202_752,
    maxOutput: 131_072,
    levels: [],
    reasoning: true,
  },
  {
    id: 'relaya/deepseek-chat',
    name: 'DeepSeek Chat',
    provider: 'relaya',
    providerName: 'Relay A',
    context: 128_000,
    maxOutput: 8_192,
    levels: [],
    reasoning: false,
  },
  {
    id: 'claude/claude-opus-5-5',
    name: 'Opus 5.5',
    provider: 'claude',
    providerName: 'Claude',
    context: 1_000_000,
    maxOutput: 128_000,
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'group/fast',
    name: 'Fast',
    provider: 'relaya',
    providerName: 'routing group',
    context: 202_752,
    levels: [],
    reasoning: true,
  },
];

function row(model: MagpieModel, index: number, forClaudeCode: boolean) {
  const label = `${model.name} · ${model.providerName}`;
  const kept = /(claude|anthropic)/i.test(model.id);
  return {
    id: forClaudeCode && !kept ? `anthropic/magpie-${index + 1}` : model.id,
    object: 'model',
    type: 'model',
    created: 0,
    created_at: '2025-01-01T00:00:00Z',
    owned_by: model.provider,
    display_name: forClaudeCode ? label : model.name,
    reasoning: model.reasoning ?? model.levels.length > 0,
    supported_reasoning_levels: model.levels.map((effort) => ({ effort })),
    reasoning_levels: model.levels,
    ...(model.context
      ? {
          context_window: model.context,
          context_length: model.context,
          max_input_tokens: model.context,
        }
      : {}),
    ...(model.maxOutput ? { max_output_tokens: model.maxOutput } : {}),
    magpie_label: label,
  };
}

/** `GET /v1/models` as magpie answers a request. */
export function magpieModelList(options: { forClaudeCode?: boolean } = {}) {
  const data = MAGPIE_MODELS.map((model, index) =>
    row(model, index, options.forClaudeCode === true),
  );
  return {
    object: 'list',
    data,
    has_more: false,
    first_id: data[0].id,
    last_id: data[data.length - 1].id,
  };
}

/** Whether magpie would show this request Claude Code's discovery list. */
export function magpieSeesClaudeCode(headers: Headers): boolean {
  const ua = headers.get('user-agent') ?? '';
  return (
    !!headers.get('anthropic-version') &&
    (ua.startsWith('claude-code/') || ua.startsWith('claude-cli/'))
  );
}

/** `GET /v1/magpie/quotas`. */
export function magpieQuotas(now = Date.now()) {
  const inHours = (hours: number) =>
    new Date(now + hours * 3_600_000).toISOString();
  return {
    object: 'list',
    data: [
      {
        provider: 'codex',
        name: 'Codex · work',
        kind: 'subscription',
        plan: 'pro',
        user: 'me@example.com',
        windows: [
          { name: '5h', used: 100, remaining: 0, resetsAt: inHours(3) },
          { name: 'weekly', used: 40, remaining: 60, resetsAt: inHours(90) },
        ],
        readAt: new Date(now).toISOString(),
      },
      {
        provider: 'codex',
        name: 'Codex · home',
        kind: 'subscription',
        plan: 'plus',
        user: 'home@example.com',
        windows: [
          { name: '5h', used: 100, remaining: 0, resetsAt: inHours(1) },
        ],
        readAt: new Date(now).toISOString(),
      },
      {
        provider: 'relaya',
        name: 'Relay A',
        kind: 'balance',
        plan: null,
        user: null,
        windows: [{ name: 'balance', unlimited: true, used: 0, remaining: 0 }],
        readAt: new Date(now).toISOString(),
      },
      {
        provider: 'claude',
        name: 'Claude',
        kind: 'subscription',
        windows: [],
        readAt: new Date(now).toISOString(),
        error: 'token expired',
      },
    ],
  };
}

/** The refusal magpie sends when every account serving a model is spent. */
export function magpieUsageLimitBody(model: string) {
  return {
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: `usage limit reached: every account that serves "${model}" is held by magpie — Codex · work (5h). magpie uses it again once that window renews; wait or pick another model`,
    },
  };
}
