const STANDARD_CONTEXT_WINDOW = 200_000;
const EXTENDED_CONTEXT_WINDOW = 1_000_000;

/** Fable 5 / Sonnet 5 / Mythos 5 ship a 1M context window natively, no [1m] suffix. */
const NATIVE_EXTENDED_CONTEXT_MODEL_RE =
  /(?:^|[/:_-])(?:fable|sonnet|mythos)-5(?!\d)/i;

/**
 * Claude Agent SDK uses the [1m] model suffix to request extended context;
 * Fable 5 / Sonnet 5 / Mythos 5 models get the 1M window without any suffix.
 */
export function isExtendedContextModel(model: string): boolean {
  const normalized = model.trim();
  return (
    /(\[1m\])+$/i.test(normalized) ||
    NATIVE_EXTENDED_CONTEXT_MODEL_RE.test(normalized)
  );
}

export function resolveModelContextWindow(model: string): number {
  return isExtendedContextModel(model)
    ? EXTENDED_CONTEXT_WINDOW
    : STANDARD_CONTEXT_WINDOW;
}

/** Convert a model-relative compact percentage into the SDK token setting. */
export function resolveAutoCompactWindow(
  model: string,
  percentage: number,
): number | undefined {
  if (!Number.isInteger(percentage) || percentage < 50 || percentage > 90) {
    return undefined;
  }
  return Math.round((resolveModelContextWindow(model) * percentage) / 100);
}

/**
 * Older installs persisted an absolute compact threshold.  Preserve smaller
 * values, but never pass a threshold above 90% of the active model window to
 * the SDK: an 800K value inherited from a [1m] model would otherwise overflow
 * after switching back to a regular 200K model before compaction can run.
 */
export function resolveLegacyAutoCompactWindow(
  model: string,
  configuredTokens: number,
): number | undefined {
  if (!Number.isFinite(configuredTokens) || configuredTokens <= 0) {
    return undefined;
  }
  const safeMaximum = Math.floor(resolveModelContextWindow(model) * 0.9);
  return Math.min(Math.floor(configuredTokens), safeMaximum);
}
