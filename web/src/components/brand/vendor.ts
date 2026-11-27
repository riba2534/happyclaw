import type { VendorKind } from './vendorMarks';

/** Presets that are one vendor's own endpoint (MODEL_PRESETS ids). */
const VENDOR_BY_PRESET: Readonly<Record<string, VendorKind>> = {
  openrouter: 'openrouter',
  deepseek: 'deepseek',
  'zhipu-glm-cn': 'zhipu',
  'zhipu-glm-global': 'zhipu',
  'zhipu-coding-plan-cn': 'zhipu',
  'zai-coding-plan-global': 'zhipu',
  'moonshot-kimi-cn': 'moonshot',
  'moonshot-kimi-global': 'moonshot',
  'moonshot-kimi-code': 'kimi',
  'minimax-cn': 'minimax',
  'minimax-global': 'minimax',
  'aliyun-bailian-coding': 'alibaba',
  'aliyun-bailian-token-plan-cn': 'alibaba',
  'aliyun-bailian-token-plan-team-cn': 'alibaba',
  longcat: 'longcat',
  'xiaomi-mimo-api-cn': 'xiaomi',
  'xiaomi-mimo-token-plan-cn': 'xiaomi',
  'volcengine-agent-plan': 'bytedance',
  'volcengine-coding-plan': 'bytedance',
  'tencentcloud-coding-plan': 'hunyuan',
  'opencode-go': 'opencode',
  stepfun: 'stepfun',
};

/** Hosts of the vendors' own endpoints, matched on DNS boundaries. */
const VENDOR_BY_HOST: ReadonlyArray<readonly [string, VendorKind]> = [
  ['anthropic.com', 'anthropic'],
  ['openai.com', 'openai'],
  ['chatgpt.com', 'openai'],
  ['openrouter.ai', 'openrouter'],
  ['deepseek.com', 'deepseek'],
  ['bigmodel.cn', 'zhipu'],
  ['z.ai', 'zhipu'],
  ['moonshot.cn', 'moonshot'],
  ['moonshot.ai', 'moonshot'],
  ['kimi.com', 'kimi'],
  ['minimaxi.com', 'minimax'],
  ['minimax.io', 'minimax'],
  ['dashscope.aliyuncs.com', 'alibaba'],
  ['maas.aliyuncs.com', 'alibaba'],
  ['longcat.chat', 'longcat'],
  ['xiaomimimo.com', 'xiaomi'],
  ['volces.com', 'bytedance'],
  ['tencent.com', 'hunyuan'],
  ['opencode.ai', 'opencode'],
  ['stepfun.com', 'stepfun'],
  ['siliconflow.cn', 'siliconcloud'],
  ['siliconflow.com', 'siliconcloud'],
];

/** Model names (after any vendor prefix) and the vendor that makes them. */
const VENDOR_BY_MODEL: ReadonlyArray<readonly [RegExp, VendorKind]> = [
  [/^(claude|opus|sonnet|haiku|fable)\b/, 'anthropic'],
  [/^(gpt|chatgpt|codex|o\d)\b/, 'openai'],
  [/^glm\b/, 'zhipu'],
  [/^(kimi|k\d)/, 'moonshot'],
  [/^deepseek/, 'deepseek'],
  [/^minimax/, 'minimax'],
  [/^(qwen|qwq)/, 'alibaba'],
  [/^mimo/, 'xiaomi'],
  [/^step/, 'stepfun'],
  [/^longcat/, 'longcat'],
  [/^(hunyuan|tc-code)/, 'hunyuan'],
  [/^(doubao|ark-)/, 'bytedance'],
];

/** Vendor prefixes gateways put before a model (`z-ai/glm-5.2`). */
const VENDOR_BY_PREFIX: Readonly<Record<string, VendorKind>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  'z-ai': 'zhipu',
  zhipu: 'zhipu',
  moonshotai: 'moonshot',
  deepseek: 'deepseek',
  minimax: 'minimax',
  qwen: 'alibaba',
  alibaba: 'alibaba',
  xiaomi: 'xiaomi',
  stepfun: 'stepfun',
};

/** The vendor that makes a model, from its prefix or its name. */
export function vendorOfModel(id: string): VendorKind | null {
  const lower = id.trim().toLowerCase();
  if (!lower) return null;
  const slash = lower.indexOf('/');
  if (slash > 0) {
    const byPrefix = VENDOR_BY_PREFIX[lower.slice(0, slash)];
    if (byPrefix) return byPrefix;
  }
  const name = slash > 0 ? lower.slice(slash + 1) : lower;
  return VENDOR_BY_MODEL.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

function vendorOfHost(baseUrl: string): VendorKind | null {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  return (
    VENDOR_BY_HOST.find(
      ([host]) => hostname === host || hostname.endsWith(`.${host}`),
    )?.[1] ?? null
  );
}

/**
 * The vendor a connection stands for: a subscription by its kind, a preset
 * or a vendor's own address by that, else the maker of its default model.
 * Null when nothing says (a relay of unknown models): show a monogram.
 */
export function vendorOfConnection(connection: {
  kind: 'official' | 'third_party' | 'codex' | 'gemini';
  presetId?: string | null;
  baseUrl?: string;
  model?: string;
}): VendorKind | null {
  if (connection.kind === 'official') return 'anthropic';
  if (connection.kind === 'codex') return 'openai';
  if (connection.kind === 'gemini') return 'gemini';
  return (
    (connection.presetId ? VENDOR_BY_PRESET[connection.presetId] : null) ??
    (connection.baseUrl ? vendorOfHost(connection.baseUrl) : null) ??
    (connection.model ? vendorOfModel(connection.model) : null)
  );
}
