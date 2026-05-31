import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Keep native/server-only deps out of the bundler. The pipeline + browser
  // work runs in the standalone worker process, not in route handlers.
  serverExternalPackages: ["@prisma/adapter-pg", "@prisma/client", "pg"],
};

export default nextConfig;
