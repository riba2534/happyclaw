export const ACTIVATION_MODE_OPTIONS = [
  { value: 'always', label: '始终响应' },
  { value: 'when_mentioned', label: '仅 mention' },
  { value: 'owner_mentioned', label: '仅我 mention' },
  { value: 'auto', label: '自动（按需响应）' },
  { value: 'disabled', label: '禁用' },
] as const;
