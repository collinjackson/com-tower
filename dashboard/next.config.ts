import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @napi-rs/canvas ships a native .node binding that Turbopack cannot place in an ESM chunk
  // ("non-ecmascript placeable asset"), so it has to stay external and be required at runtime.
  serverExternalPackages: ['@napi-rs/canvas'],
  // The chart reads its font at runtime via process.cwd(), which file tracing cannot infer
  // from a dynamic path — without this the font is absent in the deployed bundle and every
  // label rasterises as tofu boxes.
  outputFileTracingIncludes: {
    '/api/chart/[gameId]': ['./fonts/**'],
  },
};

export default nextConfig;
