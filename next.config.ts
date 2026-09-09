import type { NextConfig } from 'next'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

const config: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  images: {
    unoptimized: true,
  },
  turbopack: {
    root,
  },
};

export default config;
