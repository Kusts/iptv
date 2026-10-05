/** @type {import('next').NextConfig} */
const nextConfig = {
  // Container image boundary: `standalone` emits a self-contained server
  // bundle under `.next/standalone` (server.js + only the traced node_modules),
  // which is what `apps/web/Dockerfile` copies into its runtime stage.
  // `next build` / `next dev` / `pnpm --filter @iptv/web test` are unchanged.
  output: "standalone",
};

export default nextConfig;