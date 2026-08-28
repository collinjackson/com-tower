import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The chart reads its font at runtime via process.cwd(), which file tracing cannot infer
  // from a dynamic path — without this the font is absent in the deployed bundle and every
  // label rasterises as tofu boxes.
  outputFileTracingIncludes: {
    '/api/chart/[gameId]': ['./fonts/**'],
  },
};

export default nextConfig;
