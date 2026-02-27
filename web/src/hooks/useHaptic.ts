const canVibrate = typeof navigator !== 'undefined' && 'vibrate' in navigator;

export function lightTap() {
  if (canVibrate) navigator.vibrate(10);
}

export function mediumTap() {
  if (canVibrate) navigator.vibrate(20);
}

export function successTap() {
  if (canVibrate) navigator.vibrate([10, 50, 20]);
}
