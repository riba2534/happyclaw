const ONE_MILLION_CONTEXT_SUFFIX = '[1m]';
const ONE_MILLION_CONTEXT_SUFFIX_RE = /(?:\[1m\])+$/i;
/** Fable 5 / Sonnet 5 / Mythos 5 ship a 1M context window natively, no [1m] suffix. */
const NATIVE_ONE_MILLION_CONTEXT_RE =
  /(?:^|[/:_-])(?:fable|sonnet|mythos)-5(?!\d)/i;

export interface ProviderModelSelection {
  model: string;
  oneMillionContext: boolean;
}

export interface DefaultProviderEnvRow {
  key: string;
  value: string;
  source: 'model' | 'context' | 'default';
}

/** Convert a stored provider model into the editable model name and context toggle. */
export function parseProviderModel(value: string): ProviderModelSelection {
  const normalized = value.trim();
  const oneMillionContext = ONE_MILLION_CONTEXT_SUFFIX_RE.test(normalized);
  return {
    model: normalized.replace(ONE_MILLION_CONTEXT_SUFFIX_RE, '').trim(),
    oneMillionContext,
  };
}

/** Build the single model value injected into Claude Code's environment. */
export function buildProviderModel(
  value: string,
  oneMillionContext: boolean,
): string {
  const model = parseProviderModel(value).model;
  if (!model) return '';
  return oneMillionContext ? `${model}${ONE_MILLION_CONTEXT_SUFFIX}` : model;
}

/** Build the editable defaults prefilled for third-party providers. */
export function buildDefaultProviderEnv(
  value: string,
  oneMillionContext: boolean,
): DefaultProviderEnvRow[] {
  const model = buildProviderModel(value, oneMillionContext);
  return [
    { key: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: model, source: 'model' },
    { key: 'ANTHROPIC_DEFAULT_SONNET_MODEL', value: model, source: 'model' },
    { key: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: model, source: 'model' },
    {
      key: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
      value:
        oneMillionContext || NATIVE_ONE_MILLION_CONTEXT_RE.test(model)
          ? '1000000'
          : '200000',
      source: 'context',
    },
    {
      key: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      value: '1',
      source: 'default',
    },
    { key: 'CLAUDE_CODE_EFFORT_LEVEL', value: 'max', source: 'default' },
    { key: 'CLAUDE_CODE_NO_FLICKER', value: '1', source: 'default' },
    { key: 'API_TIMEOUT_MS', value: '3000000', source: 'default' },
  ];
}
