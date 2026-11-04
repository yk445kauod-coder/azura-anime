/**
 * Device capability detection.
 *
 * The dashboard has to stay smooth on a low-end phone, so the expensive parts
 * of the UI — WebGL scenes and the continuously-animating backdrops — are
 * opt-in per device rather than always on. A device is considered capable only
 * when it has several cores, enough RAM, and does not ask for reduced motion;
 * everything else gets the static, image-based experience.
 */

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type NavigatorWithMemory = Navigator & { deviceMemory?: number };

/** True when the device should be offered animated or WebGL content. */
export function isCapableDevice(): boolean {
  if (typeof window === "undefined") return false;
  if (prefersReducedMotion()) return false;

  const nav = navigator as NavigatorWithMemory;
  const cores = nav.hardwareConcurrency ?? 4;
  const mem = nav.deviceMemory ?? 4; // GB, Chromium only; assume 4 elsewhere
  if (cores <= 2 || mem <= 2) return false;

  // A coarse pointer plus a small viewport means a phone; skip the 3D there.
  if (window.matchMedia("(pointer: coarse)").matches && window.innerWidth < 820) return false;

  // WebGL must actually be available before we commit to a canvas scene.
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** True when the viewport is wide enough for the two-column layouts. */
export function isWideViewport(): boolean {
  return typeof window !== "undefined" && window.innerWidth >= 1024;
}
