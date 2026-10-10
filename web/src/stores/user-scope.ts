/**
 * Stores holding user-scoped data register a reset here when their module
 * loads. Signing in or out resets only what was ever loaded, synchronously:
 * auth must not import (or wait to download) every such store just to clear
 * it.
 */
const resets = new Set<() => void>();

export function registerUserScopedReset(reset: () => void): void {
  resets.add(reset);
}

export function resetUserScopedStores(): void {
  for (const reset of resets) reset();
}
