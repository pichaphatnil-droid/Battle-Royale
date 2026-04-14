import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  images: {
    // อนุญาตโหลดรูปจาก domain ใดก็ได้ (URL รูปผู้เล่นและไอเทม)
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
      { protocol: 'http', hostname: '**' },
    ],
  },
  // ปิด X-Powered-By header
  poweredByHeader: false,
}

export default nextConfig
