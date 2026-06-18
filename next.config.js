/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Linting is a dev-time concern; don't fail production image builds on style rules.
  eslint: {
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
