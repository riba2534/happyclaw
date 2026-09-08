type SystemMessageStyle = 'divider' | 'error';

interface SystemMessageRule {
  match: (content: string) => boolean;
  style: SystemMessageStyle;
  extract: (content: string) => string;
}

const SYSTEM_MESSAGE_RULES: SystemMessageRule[] = [
  {
    match: (c) => c === 'context_reset',
    style: 'divider',
    extract: () => '上下文已清除',
  },
  {
    match: (c) => c.startsWith('context_reset:'),
    style: 'divider',
    extract: (c) => c.slice('context_reset:'.length),
  },
  {
    match: (c) => c === 'context_fresh_window',
    style: 'divider',
    extract: () => '已开启新上下文窗口（零摘要换窗）',
  },
  {
    match: (c) => c.startsWith('[HAPPYCLAW_FRESH_WINDOW_HANDOFF]'),
    style: 'divider',
    extract: () => '新窗口交接说明（零摘要）',
  },
  {
    match: (c) => c === 'query_interrupted',
    style: 'divider',
    extract: () => '已停止',
  },
  {
    match: (c) => c.startsWith('agent_error:'),
    style: 'error',
    extract: (c) => c.slice('agent_error:'.length),
  },
  {
    match: (c) => c.startsWith('agent_max_retries:'),
    style: 'error',
    extract: (c) => c.slice('agent_max_retries:'.length),
  },
  {
    match: (c) => c.startsWith('system_error:'),
    style: 'error',
    extract: (c) => c.slice('system_error:'.length),
  },
  {
    match: (c) => c.startsWith('system_info:'),
    style: 'divider',
    extract: (c) => c.slice('system_info:'.length),
  },
];

export function resolveSystemMessage(content: string): {
  style: SystemMessageStyle;
  text: string;
} {
  for (const rule of SYSTEM_MESSAGE_RULES) {
    if (rule.match(content))
      return { style: rule.style, text: rule.extract(content) };
  }
  return { style: 'divider', text: content };
}
