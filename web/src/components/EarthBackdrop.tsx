/**
 * EarthBackdrop.
 *
 * A fixed, full-viewport backdrop that slowly rotates the NASA Blue Marble
 * equirectangular texture. The rotation is the classic CSS trick — scroll a
 * horizontally-tiling `background-position` — so it costs no canvas, no WebGL
 * and no JS per frame.
 *
 * On a weak device, or when the user asks for reduced motion, the rotation is
 * dropped and only a cheap static layer remains, so the backdrop never forces
 * the compositor to keep animating a 160vmax layer.
 */

import { prefersReducedMotion } from "@/lib/device";

export default function EarthBackdrop() {
  const animate = typeof window !== "undefined" && !prefersReducedMotion();
  return (
    <div className="earth-backdrop" aria-hidden="true">
      <div className={`earth-sphere${animate ? "" : " still"}`} />
      <div className="earth-atmo" />
      <div className="earth-vignette" />
    </div>
  );
}
