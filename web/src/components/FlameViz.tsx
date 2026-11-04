/**
 * FlameViz.
 *
 * An animated depiction of the difference that motivates this whole corpus:
 * in microgravity there is no buoyant plume, so a flame becomes a quiescent
 * sphere, while at 1 g it stretches into a teardrop. The point is comparative,
 * so the canvas renders both side by side on one time base.
 *
 * This is an illustration, not data — the caption says so. It is driven by a
 * single requestAnimationFrame loop that pauses when the tab is hidden, and it
 * renders one static frame under `prefers-reduced-motion`.
 */

import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "@/lib/device";

type Pt = { x: number; y: number };

function flamePath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, t: number, stretch: number) {
  // `stretch` is the vertical elongation: 1 is a sphere (microgravity), >1 pulls
  // a plume upward (buoyant, 1 g). Wobble is small and phase-shifted so the two
  // flames are visibly the same phenomenon under different gravity.
  const N = 64;
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const wob = 1 + 0.05 * Math.sin(a * 5 + t * 2.1) + 0.03 * Math.sin(a * 3 - t * 1.4);
    const up = Math.cos(a); // 1 at top
    const rr = r * wob * (1 + (stretch - 1) * Math.max(0, up) * 0.9);
    const x = cx + Math.cos(a) * rr * 0.92;
    const y = cy - Math.sin(a) * rr * stretch;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function particles(t: number, cx: number, cy: number, r: number, stretch: number, n: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const seed = i * 12.9898;
    const life = ((t * 0.35 + (seed % 1)) % 1);
    const a = (Math.sin(seed) * 0.5 + 0.5) * Math.PI * 2;
    const rad = r * (0.55 + life * 1.5) * (1 + (stretch - 1) * 0.7 * Math.max(0, Math.cos(a)));
    out.push({
      x: cx + Math.cos(a) * rad,
      y: cy - Math.sin(a) * rad * stretch - (stretch - 1) * life * r * 0.6,
    });
  }
  return out;
}

function draw(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  ctx.clearRect(0, 0, w, h);
  const cy = h * 0.56;
  const r = Math.min(w * 0.16, h * 0.26);
  const leftX = w * 0.29;
  const rightX = w * 0.71;

  // faint grid horizon
  ctx.strokeStyle = "rgba(94,118,168,0.16)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, cy);
  ctx.lineTo(w, cy);
  ctx.stroke();

  const flames: [number, number, string][] = [
    [leftX, 1.0, "Microgravity"],
    [rightX, 1.62, "Earth (1 g)"],
  ];

  for (const [cx, stretch, label] of flames) {
    // outer halo
    const halo = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * (2.4 + stretch));
    halo.addColorStop(0, "rgba(255,150,40,0.35)");
    halo.addColorStop(0.5, "rgba(255,90,20,0.12)");
    halo.addColorStop(1, "rgba(255,90,20,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, r * (2.4 + stretch), 0, Math.PI * 2);
    ctx.fill();

    // body
    const g = ctx.createRadialGradient(cx, cy - r * 0.2, r * 0.1, cx, cy, r * (1.3 + stretch));
    g.addColorStop(0, "rgba(255,246,214,0.98)");
    g.addColorStop(0.35, "rgba(255,196,80,0.95)");
    g.addColorStop(0.7, "rgba(255,110,26,0.8)");
    g.addColorStop(1, "rgba(180,40,0,0.15)");
    ctx.fillStyle = g;
    flamePath(ctx, cx, cy, r, t, stretch);
    ctx.fill();

    // sparks
    ctx.fillStyle = "rgba(255,220,150,0.85)";
    for (const p of particles(t, cx, cy, r, stretch, 22)) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }

    // label
    ctx.fillStyle = "rgba(195,204,224,0.9)";
    ctx.font = "600 12px 'Inter', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(label, cx, h - 14);
  }

  // divider
  ctx.strokeStyle = "rgba(94,118,168,0.22)";
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(w / 2, h * 0.16);
  ctx.lineTo(w / 2, h * 0.84);
  ctx.stroke();
  ctx.setLineDash([]);
}

export default function FlameViz({
  className,
  caption = "Buoyancy-free combustion · illustrative, not measured data",
}: {
  className?: string;
  caption?: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = prefersReducedMotion();
    // Animate at a modest fixed cadence rather than every vsync: the motion is
    // slow, so 20 fps looks the same and leaves the main thread mostly idle.
    const FRAME_MS = 1000 / 20;
    let raf = 0;
    let start = 0;
    let last = 0;
    let running = true;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, reduce ? 1 : 1.5);
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width * dpr));
      const h = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    };

    const frame = (now: number) => {
      if (!running) return;
      if (!start) start = now;
      if (now - last >= FRAME_MS) {
        last = now;
        resize();
        draw(ctx, canvas.clientWidth, canvas.clientHeight, reduce ? 0.8 : (now - start) / 1000);
      }
      if (!reduce) raf = requestAnimationFrame(frame);
    };

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!reduce && !running) {
        running = true;
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    raf = requestAnimationFrame(frame);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div className={`flameviz ${className ?? ""}`}>
      <div className="fv-badge">
        <span className="dot live" /> Combustion visualisation
      </div>
      <canvas ref={ref} />
      <div className="fv-legend">
        <b>µg</b> spherical, quiescent<br />
        <b>1 g</b> buoyant plume
        <div style={{ marginTop: 6, opacity: 0.75 }}>{caption}</div>
      </div>
    </div>
  );
}
