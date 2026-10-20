/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Dipakai Dockerfile: hasil build ringkas (.next/standalone) untuk runtime.
  output: "standalone",
};

export default nextConfig;
