/**
 * IssPanel.
 *
 * Decides at runtime whether to mount the WebGL ISS viewer or a static NASA
 * preview image. The 3D code path is a separate `import()` chunk, so a weak
 * device — or any device that asks for reduced motion — never downloads
 * three.js at all. The static image is the same NASA render, so the panel looks
 * intentional either way.
 */

import { lazy, Suspense, useState } from "react";
import { isCapableDevice } from "@/lib/device";

const IssViewer = lazy(() => import("@/components/IssViewer"));

export default function IssPanel({ height = 320 }: { height?: number }) {
  const [capable] = useState(() => isCapableDevice());

  if (!capable) {
    return (
      <div className="flameviz" style={{ minHeight: height }}>
        <div className="fv-badge">
          <span className="dot" /> ISS · static preview
        </div>
        <img
          src="/assets/iss-preview.png"
          alt="International Space Station (NASA 3D Resources)"
          loading="lazy"
          decoding="async"
          style={{ width: "100%", height, objectFit: "contain", display: "block" }}
        />
        <div className="fv-legend">
          <b>NASA</b> ISS render<br />
          public domain
        </div>
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="flameviz" style={{ minHeight: height }}>
          <div className="fv-badge"><span className="dot live" /> ISS · free-fall attitude</div>
          <img
            src="/assets/iss-preview.png"
            alt="International Space Station"
            style={{ width: "100%", height, objectFit: "contain", opacity: 0.5 }}
          />
        </div>
      }
    >
      <IssViewer height={height} />
    </Suspense>
  );
}
