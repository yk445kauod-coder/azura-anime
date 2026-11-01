import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pg"],
  experimental: {
    // Corpus text is fetched at runtime from Postgres, not bundled.
    serverActions: { bodySizeLimit: "4mb" },
  },
};

export default nextConfig;
