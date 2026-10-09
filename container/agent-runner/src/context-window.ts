/**
 * Whether a model ID explicitly requests the extended 1M window.
 *
 * Only the `[1m]` suffix is checked: it is the ID the user chose to get 1M,
 * so a smaller resolved window means the request silently fell back.
 * Models that are 1M-native (Sonnet 5+, Opus 4.7+, Fable) need no suffix
 * and Claude Code resolves their window itself.
 */
export function isExtendedContextModel(model: string): boolean {
  return /(\[1m\])+$/i.test(model.trim());
}
