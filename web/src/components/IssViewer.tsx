/**
 * IssViewer.
 *
 * Renders NASA's own ISS model — the glTF-binary from NASA's 3D Resources
 * (github.com/nasa/NASA-3D-Resources), public domain — as a slow, free-floating
 * station rather than anything hand-drawn. Because the station is in free fall
 * there is no "down", so the scene drifts on every axis with a gentle wobble.
 *
 * Cost control: three.js and the model are code-split and only fetched when a
 * capable device actually mounts this. `frameloop` is demand-driven (the scene
 * renders on a throttled timer, not every vsync) and the canvas dpr is capped,
 * so a mid-range laptop is not pinned to 100% GPU by a decorative element.
 * Weak devices never reach here — the caller swaps in a static preview.
 */

import { Suspense, useEffect, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Stage, Stars, Html, OrbitControls, useGLTF } from "@react-three/drei";
import type { Group } from "three";

const MODEL = "/assets/iss.glb";
/** Target frames per second for the decorative rotation. */
const FPS = 24;

/**
 * Drive the demand-driven render loop at a fixed, modest cadence instead of
 * every vsync, and stop entirely while the tab is hidden. The rotation is slow
 * enough that 24 fps is indistinguishable from 60, at a third of the cost.
 */
function Pulse() {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    let id = 0;
    const tick = () => {
      if (!document.hidden) invalidate();
    };
    id = window.setInterval(tick, 1000 / FPS);
    return () => clearInterval(id);
  }, [invalidate]);
  return null;
}

function Station() {
  const ref = useRef<Group>(null);
  const { scene } = useGLTF(MODEL);

  useFrame((_, delta) => {
    const g = ref.current;
    if (!g) return;
    const d = Math.min(delta, 0.05); // clamp so a background tab cannot jump the pose
    g.rotation.y += d * 0.18;
    g.rotation.x += d * 0.06;
    g.rotation.z += d * 0.04;
    g.position.y = Math.sin(performance.now() / 2800) * 0.08;
  });

  return (
    <group ref={ref} dispose={null}>
      <primitive object={scene} />
    </group>
  );
}

function Loading() {
  return (
    <Html center>
      <div style={{ color: "#8494b4", font: "600 12px Inter, sans-serif" }}>loading ISS model…</div>
    </Html>
  );
}

export default function IssViewer({ height = 320 }: { height?: number }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  // Only start the WebGL context once the panel is actually on screen, so it
  // never competes with first paint.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setVisible(true)),
      { rootMargin: "160px" },
    );
    io.observe(host);
    return () => io.disconnect();
  }, []);

  return (
    <div className="flameviz" style={{ minHeight: height }} ref={hostRef}>
      <div className="fv-badge">
        <span className="dot live" /> ISS · free-fall attitude
      </div>
      {visible && (
        <Canvas
          frameloop="demand"
          camera={{ position: [0, 0.6, 3.4], fov: 42 }}
          dpr={[1, 1.75]}
          gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
          style={{ height, background: "transparent" }}
        >
          <color attach="background" args={["#04060d"]} />
          <Pulse />
          <Stars radius={60} depth={40} count={1400} factor={3} saturation={0} fade speed={0.5} />
          <Suspense fallback={<Loading />}>
            <Stage intensity={0.9} environment="night" adjustCamera={false} shadows={false}>
              <Station />
            </Stage>
          </Suspense>
          <OrbitControls enablePan={false} minDistance={2} maxDistance={7} makeDefault />
        </Canvas>
      )}
      <div className="fv-legend">
        <b>NASA</b> ISS 3D model<br />
        public domain · drag to orbit
      </div>
    </div>
  );
}
