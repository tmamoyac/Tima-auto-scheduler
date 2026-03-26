/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * Disk-based webpack cache occasionally throws ENOENT renaming `.next/cache/webpack/**.pack_*`
   * on iCloud/Dropbox/concurrent builds, which breaks `next build` with “Cannot find module for page”.
   * Memory cache is slightly slower but avoids that class of failure.
   */
  webpack: (config, { dev }) => {
    if (!dev) {
      config.cache = { type: "memory" };
    }
    return config;
  },
};

export default nextConfig;
