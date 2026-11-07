/**
 * For Radix's `onCloseAutoFocus`. A closed menu or sheet hands focus back to
 * its trigger once its exit animation ends. When the chosen action already
 * moved focus on (the composer it filled, a panel or dialog it opened),
 * pulling focus back would undo that, so it stays where it went.
 */
export function keepFocusThatMovedOn(event: Event) {
  const active = document.activeElement;
  if (active && active !== document.body) event.preventDefault();
}
