/**
 * Whether focus on ``target`` came from the keyboard (``:focus-visible``).
 * A mouse click focuses a button too, and Chromium keeps that focus after
 * the pointer leaves, so a hover-like light follows keyboard focus only.
 * False where the selector is not supported.
 */
export function isKeyboardFocus(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  try {
    return target.matches(":focus-visible");
  } catch {
    return false;
  }
}
