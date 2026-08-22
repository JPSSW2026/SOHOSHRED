/**
 * navigator.getGamepads(), guarded.
 *
 * Feature-detecting the method is not enough. It exists on every modern
 * navigator, but inside a frame that a Permissions-Policy has not granted
 * `gamepad` to, CALLING it throws SecurityError instead of returning an
 * empty list. Both call sites poll from inside the fixed-timestep tick, so
 * that throw propagated out of Engine.tick and killed the loop on frame
 * one: the mountain and HUD had already rendered, so the game looked booted
 * and was frozen behind the title card. Embedded builds (an <iframe> on a
 * host page) hit this every time; a same-origin dev server never does,
 * which is why it survived local testing.
 *
 * A denial is fixed for the document's lifetime, so latch it rather than
 * throwing and catching 120 times a second.
 */
const NONE = [];
let blocked = false;

export function getGamepads() {
  if (blocked || typeof navigator === 'undefined' || !navigator.getGamepads) return NONE;
  try {
    return navigator.getGamepads() || NONE;
  } catch {
    blocked = true;
    return NONE;
  }
}
